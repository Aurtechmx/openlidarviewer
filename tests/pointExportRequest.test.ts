/**
 * The quick-format point export is one request captured at the click
 * (`src/app/pointExportRequest.ts`). These tests drive the real capture and
 * the real writers, hold the writer chunk open, change the live app during the
 * wait, and check the file still describes what was asked for.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { rememberCloudFile } from '../src/io/sourceFiles';
import { makeClipBox, type ClipBox } from '../src/render/clip/clipBox';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import {
  capturePointExportRequest,
  writePointExport,
  EMPTY_CLIP_EXPORT_REFUSAL,
  type PointExportRequestDeps,
} from '../src/app/pointExportRequest';
import { runPointExport } from '../src/app/exportImageAction';
import { prepareExportScope } from '../src/render/clip/clipExportScope';
import type { ExportFormat } from '../src/io/exporters';

const UTM: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as CrsInfo;
const LATLON: CrsInfo = { source: 'wkt', name: 'WGS 84', epsg: 4326, linearUnit: 'degree', linearUnitToMetres: 1, isGeographic: true } as unknown as CrsInfo;
const crsOf = (c: CrsInfo): ResolvedCrs => resolvedFromCrsInfo(c, 'las-vlr')!;

/** A row of `n` points at x = 0..n-1 (source-local), placed at `origin`. */
function row(name: string, n: number, origin: [number, number, number], bytes: string): { cloud: PointCloud; sha: string } {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = i;
  const cloud = new PointCloud({ positions, origin, sourceFormat: 'las', name });
  rememberCloudFile(cloud, new File([bytes], name));
  return { cloud, sha: createHash('sha256').update(bytes).digest('hex') };
}

/** A clip keeping x in [lo, hi] (project frame), every y and z. */
function clipX(lo: number, hi: number): ClipBox {
  return { ...makeClipBox({ min: [lo, -1e9, -1e9], max: [hi, 1e9, 1e9] }), enabled: true };
}

/** Live app state the deps read; a test mutates it mid-export. */
function liveApp(cloud: PointCloud, crs: CrsInfo) {
  const state = { cloud: cloud as PointCloud | null, clip: null as ClipBox | null, offset: null as [number, number, number] | null, crs };
  const deps: PointExportRequestDeps = {
    activeCloud: () => state.cloud,
    clip: () => state.clip,
    clipOffset: () => state.offset,
    crs: () => crsOf(state.crs),
    isGeographic: () => state.crs.isGeographic === true,
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
  };
  return { state, deps };
}

/** Exporters held until `release()`; `downloads` collects what was written. */
function heldIo() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const downloads: { name: string; text: string }[] = [];
  const io = {
    loadExporters: vi.fn(async () => { await gate; return import('../src/io/exporters'); }),
    download: (name: string, bytes: Uint8Array) => { downloads.push({ name, text: new TextDecoder().decode(bytes) }); },
    progress: { setProgress: vi.fn(), setError: vi.fn() },
  };
  return { io, release, downloads };
}

const rows = (text: string, format: ExportFormat): number[][] => {
  const lines = text.split('\n').filter((l) => l.trim());
  const body = format === 'ply' ? lines.slice(lines.indexOf('end_header') + 1)
    : format === 'obj' ? lines.filter((l) => l.startsWith('v ')).map((l) => l.slice(2))
      : format === 'csv' ? lines.filter((l) => !l.startsWith('#')).slice(1)
        : lines.filter((l) => !l.startsWith('#'));
  return body.map((l) => l.trim().split(/[\s,]+/).slice(0, 3).map(Number));
};

describe('quick point export request', () => {
  it('captures the clip at the click and writes the same points the conversion scope step keeps', async () => {
    const a = row('a.las', 10, [500000, 4000000, 100], 'scan-a');
    for (const format of ['xyz', 'ply', 'obj', 'csv'] as const) {
      const { state, deps } = liveApp(a.cloud, UTM);
      state.clip = clipX(2, 5);
      const { io, release, downloads } = heldIo();
      const done = runPointExport(format, deps, io);
      // The clip moves while the writer loads; the file keeps the one asked for.
      state.clip = clipX(0, 9);
      release();
      await done;
      expect(downloads).toHaveLength(1);
      const { name, text } = downloads[0]!;
      expect(name).toBe(`a-clip.${format}`);
      const xs = rows(text, format).map((r) => r[0]).sort((p, q) => p - q);
      expect(xs).toEqual([500002, 500003, 500004, 500005]);
      // Same membership as the conversion route's scope step.
      const reference = prepareExportScope(a.cloud, { clip: clipX(2, 5), clipOffset: null, displayOrigin: a.cloud.sourceOrigin });
      expect(xs).toHaveLength(reference.cloud.pointCount);
      if (format !== 'csv') {
        expect(text).toContain('Clipped: 4 of 10 points');
        // The digest is the source file's, not the clipped copy's (which holds no file).
        expect(text).toContain(a.sha);
      }
    }
  });

  it('places a layer into the project frame before testing the clip, and writes source coordinates', async () => {
    const b = row('b.las', 4, [502000, 4102000, 195], 'scan-b');
    const { state, deps } = liveApp(b.cloud, UTM);
    // Layer B sits 2000 m east of the project frame's origin.
    state.offset = [2000, 2000, 0];
    state.clip = clipX(2000 - 0.5, 2000 + 1.5);
    const { io, release, downloads } = heldIo();
    const done = runPointExport('xyz', deps, io);
    release();
    await done;
    expect(rows(downloads[0]!.text, 'xyz').map((r) => r[0])).toEqual([502000, 502001]);
  });

  it('keeps scan A when scan B becomes active while the writer loads', async () => {
    const a = row('a.las', 3, [500000, 4000000, 100], 'scan-a-bytes');
    const b = row('b.las', 2, [10, 20, 1], 'scan-b-bytes');
    const { state, deps } = liveApp(a.cloud, UTM);
    const { io, release, downloads } = heldIo();
    const done = runPointExport('xyz', deps, io);
    state.cloud = b.cloud;
    state.crs = LATLON;
    release();
    await done;
    const { name, text } = downloads[0]!;
    expect(name).toBe('a.xyz');
    expect(text).toContain(a.sha);
    expect(text).not.toContain(b.sha);
    expect(text).not.toContain('EPSG:4326');
    // Projected precision (3 dp), as scan A's frame asks.
    expect(text.split('\n').find((l) => l && !l.startsWith('#'))).toBe('500000.000 4000000.000 100.000');
  });

  it('refuses a clip that keeps no points, and writes nothing', async () => {
    const a = row('a.las', 5, [0, 0, 0], 'x');
    const { state, deps } = liveApp(a.cloud, UTM);
    state.clip = clipX(100, 200);
    expect(capturePointExportRequest('xyz', deps)).toEqual({ refusal: EMPTY_CLIP_EXPORT_REFUSAL });
    const { io } = heldIo();
    await runPointExport('xyz', deps, io);
    expect(io.progress.setError).toHaveBeenCalledWith(EMPTY_CLIP_EXPORT_REFUSAL);
    expect(io.loadExporters).not.toHaveBeenCalled();
  });

  it('does nothing without an active static cloud', () => {
    const a = row('a.las', 1, [0, 0, 0], 'x');
    const { state, deps } = liveApp(a.cloud, UTM);
    state.cloud = null;
    expect(capturePointExportRequest('ply', deps)).toBeNull();
  });

  it('a disabled clip exports the whole cloud with no clip line or suffix', async () => {
    const a = row('a.las', 3, [0, 0, 0], 'x');
    const { state, deps } = liveApp(a.cloud, UTM);
    state.clip = { ...clipX(0, 0), enabled: false };
    const captured = capturePointExportRequest('obj', deps);
    expect(captured && 'request' in captured && captured.request.cloud).toBe(a.cloud);
    const downloads: string[] = [];
    await writePointExport((captured as { request: Parameters<typeof writePointExport>[0] }).request, {
      loadExporters: () => import('../src/io/exporters'),
      download: (n) => downloads.push(n),
    });
    expect(downloads).toEqual(['a.obj']);
  });

  it('hands back a promise that settles a failed write through the export toast', async () => {
    const a = row('a.las', 2, [0, 0, 0], 'x');
    const { deps } = liveApp(a.cloud, UTM);
    const progress = { setProgress: vi.fn(), setError: vi.fn() };
    const done = runPointExport('xyz', deps, { loadExporters: () => Promise.reject(new Error('chunk gone')), download: vi.fn(), progress });
    expect(done).toBeInstanceOf(Promise);
    await expect(done).resolves.toBeUndefined();
    expect(progress.setError).toHaveBeenCalledWith('Export failed: chunk gone');
  });

  it('keeps the sample disclosure of a strided source when the clip narrows it', async () => {
    const positions = new Float32Array(30);
    for (let i = 0; i < 10; i++) positions[i * 3] = i;
    const source = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 's.las', declaredPointCount: 40, loadStride: 4 });
    const { state, deps } = liveApp(source, UTM);
    state.clip = clipX(0, 4);
    const downloads: { name: string; text: string }[] = [];
    const captured = capturePointExportRequest('ply', deps) as { request: Parameters<typeof writePointExport>[0] };
    await writePointExport(captured.request, {
      loadExporters: () => import('../src/io/exporters'),
      download: (name, bytes) => downloads.push({ name, text: new TextDecoder().decode(bytes) }),
    });
    expect(downloads[0]!.name).toBe('s-sample-clip.ply');
    expect(downloads[0]!.text).toMatch(/comment SUBSET: 10 of 40 points/);
    expect(downloads[0]!.text).toContain('comment Clipped: 5 of 10 points');
    expect(downloads[0]!.text).toContain('element vertex 5');
  });
});
