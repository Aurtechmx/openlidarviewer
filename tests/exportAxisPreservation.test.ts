/**
 * exportAxisPreservation.test.ts — the converter writes source coordinates.
 *
 * A georeferenced PLY is loaded with the real loader, its CRS resolved through
 * CrsService, and converted with the real converter to XYZ, LAS 1.2 and
 * LAS 1.4. Every written point must equal its source point, under the CRS the
 * request kept or assigned, whatever the scan's shape: a vertical facade facing
 * north/south or east/west, a steep slope, a large survey origin, and ordinary
 * horizontal terrain. The only axis change is the explicit rotation of a local
 * Y-up model, which the report and the file record; the scan's inferred shape
 * and the viewer's display orientation never move a coordinate.
 */

import { describe, it, expect, vi } from 'vitest';

const shapeCalls = vi.hoisted(() => ({ count: 0, up: null as 'y' | 'z' | null }));
vi.mock('../src/terrain/scanShape', async (orig) => {
  const real = await orig<typeof import('../src/terrain/scanShape')>();
  return {
    ...real,
    // Whatever up the shape classifier (and so the display) settles on, the
    // export must not change. Counting calls proves the converter never asks.
    classifyScanShape: (...args: Parameters<typeof real.classifyScanShape>) => {
      shapeCalls.count++;
      const verdict = real.classifyScanShape(...args);
      return shapeCalls.up ? { ...verdict, up: shapeCalls.up } : verdict;
    },
  };
});

import { PointCloud } from '../src/model/PointCloud';
import { loadPly } from '../src/io/loadPly';
import { loadLas } from '../src/io/loadLas';
import { loadXyz } from '../src/io/loadXyz';
import { upOfFormat } from '../src/io/sniffFormat';
import { CrsService } from '../src/geo/CrsService';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { convertCloud } from '../src/convert/convertCloud';
import { epsgLabel } from '../src/convert/epsg';
import { Y_UP_TO_Z_UP_OPT_IN, type ConvertFormat, type ConvertOptions } from '../src/convert/types';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

type Pt = readonly [number, number, number];

/** An ASCII PLY with double X/Y/Z, as a survey package writes one. */
function plyBytes(pts: readonly Pt[]): ArrayBuffer {
  const rows = pts.map((p) => p.join(' ')).join('\n');
  const text = `ply\nformat ascii 1.0\nelement vertex ${pts.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows}\n`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** The CRS a user resolves for a PLY that declares none (an override to EPSG). */
function resolveEpsg(name: string, epsg: number): ResolvedCrs {
  const store = new Map<string, unknown>();
  const service = new CrsService({
    get: (k) => store.get(k) as never,
    set: (k, v) => { store.set(k, { ...v, updatedAt: 0 }); },
    clear: (k) => { store.delete(k); },
  });
  service.resolveForScan({ name, detected: undefined, source: 'default-assumption' });
  const resolved = service.setOverride({ override: { kind: 'projected', epsg }, detected: undefined, source: 'default-assumption' });
  if (!resolved || resolved.epsg !== epsg) throw new Error(`could not resolve EPSG:${epsg}`);
  return resolved;
}

/** A local (no-CRS) resolution, as CrsService gives a PLY with nothing declared. */
function resolveLocal(name: string): ResolvedCrs {
  const service = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
  return service.resolveForScan({ name, detected: undefined, source: 'default-assumption' });
}

/** Read the written points back, with the CRS the file reports. */
async function readBack(format: ConvertFormat, bytes: Uint8Array): Promise<{ pts: Pt[]; epsg: number | null }> {
  if (format === 'xyz') {
    const text = new TextDecoder().decode(bytes);
    const epsgLine = text.split('\n').find((l) => l.startsWith('# crs:')) ?? '';
    const m = /EPSG:(\d+)/.exec(epsgLine);
    const pts = text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
      const [x, y, z] = l.split(/\s+/).map(Number);
      return [x, y, z] as Pt;
    });
    return { pts, epsg: m ? Number(m[1]) : null };
  }
  const copy = bytes.slice();
  const cloud = await loadLas(copy.buffer as ArrayBuffer, 'las', 'out.las');
  const g = cloudToGlobal(cloud);
  const pts: Pt[] = [];
  for (let i = 0; i < g.count; i++) pts.push([g.x[i], g.y[i], g.z[i]]);
  return { pts, epsg: cloud.metadata?.crs?.epsg ?? null };
}

/** Largest per-axis difference between two equally ordered point lists. */
function worstDelta(a: readonly Pt[], b: readonly Pt[]): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[i][k] - b[i][k]));
  return worst;
}

const relief = (u: number, v: number): number => 5 * Math.exp(-(((u - 20) ** 2 + (v - 20) ** 2) / 180));

/** The surveyed shapes, each placed at a georeferenced origin. */
const SHAPES: Record<string, (e0: number, n0: number, h0: number) => Pt[]> = {
  // A wall in the east/height plane: it faces north or south. Its small
  // northing spread is what made a shape classifier call northing "up".
  'north/south-facing facade': (e0, n0, h0) => grid((u, v) => [e0 + u * 2, n0 + relief(u, v), h0 + v * 2]),
  // A wall in the north/height plane: it faces east or west.
  'east/west-facing facade': (e0, n0, h0) => grid((u, v) => [e0 + relief(u, v), n0 + u * 2, h0 + v * 2]),
  // A 70 degree cut slope rising to the north.
  'steep slope': (e0, n0, h0) => grid((u, v) => [e0 + u * 2, n0 + v * 0.5, h0 + v * 0.5 * Math.tan((70 * Math.PI) / 180) + 0.2 * relief(u, v)]),
  // Ordinary horizontal terrain: the control that always passed.
  'horizontal terrain': (e0, n0, h0) => grid((u, v) => [e0 + u * 2, n0 + v * 2, h0 + relief(u, v)]),
};

function grid(at: (u: number, v: number) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let u = 0; u < 40; u++) for (let v = 0; v < 40; v++) out.push(at(u, v));
  return out;
}

/** Survey origins: a UTM 13N site and a large southern-hemisphere northing. */
const ORIGINS = [
  { label: 'UTM 13N', epsg: 32613, origin: [500000, 4000000, 100] as const },
  { label: 'large origin, UTM 33S', epsg: 32733, origin: [699123.456, 9876543.21, 2450.5] as const },
];

const FORMATS: ConvertFormat[] = ['xyz', 'las', 'las14'];

describe('a georeferenced PLY keeps its global coordinates and its CRS', () => {
  for (const [shape, build] of Object.entries(SHAPES)) {
    for (const site of ORIGINS) {
      for (const mode of ['keep', 'assign'] as const) {
        for (const format of FORMATS) {
          it(`${shape}, ${site.label}: ${mode} to ${format}`, async () => {
            const pts = build(site.origin[0], site.origin[1], site.origin[2]);
            const cloud = await loadPly(plyBytes(pts), 'surveyed.ply');
            const resolved = resolveEpsg(cloud.name, site.epsg);
            shapeCalls.count = 0;
            const { file, report } = convertCloud(cloud, {
              format,
              crsMode: mode,
              targetEpsg: site.epsg,
              resolvedSourceCrs: resolved,
            });
            expect(report.ok, report.log.map((l) => l.message).join(' | ')).toBe(true);
            const back = await readBack(format, file!.bytes);
            // Millimetre agreement on every point: no axis was swapped or negated.
            expect(worstDelta(back.pts, pts)).toBeLessThan(0.001);
            // The coordinates and the CRS travel together.
            expect(back.epsg).toBe(site.epsg);
            expect(report.crsNote).toContain(epsgLabel(site.epsg));
            if (mode === 'assign') expect(report.crsNote).toContain('coordinates unchanged');
            expect(report.events?.some((e) => e.id === 'axes-y-up-to-z-up')).toBe(false);
            expect(report.log.some((l) => /rotat/i.test(l.message))).toBe(false);
            expect(shapeCalls.count).toBe(0);
          });
        }
      }
    }
  }

  it('reproduces the reported facade case exactly (500000, 4000000.058718, 100)', async () => {
    const pts = SHAPES['north/south-facing facade'](500000, 4000000, 100);
    const cloud = await loadPly(plyBytes(pts), 'surveyed-facade.ply');
    const resolved = resolveEpsg(cloud.name, 32613);
    for (const mode of ['keep', 'assign'] as const) {
      const { file } = convertCloud(cloud, { format: 'xyz', crsMode: mode, targetEpsg: 32613, resolvedSourceCrs: resolved });
      const first = (await readBack('xyz', file!.bytes)).pts[0];
      expect(first[0]).toBeCloseTo(500000, 3);
      expect(first[1]).toBeCloseTo(4000000.058718, 3);
      expect(first[2]).toBeCloseTo(100, 3);
    }
  });
});

describe('Y-up to Z-up happens only when the request asks for it', () => {
  // A local phone-scan style model: Y is up, -Z is north.
  const model: Pt[] = grid((u, v) => [u * 0.1, 0.4 * relief(u, v), -v * 0.1]);

  it('a local Y-up model is written as stored by default', async () => {
    const cloud = await loadPly(plyBytes(model), 'room.ply');
    for (const format of FORMATS) {
      const { file, report } = convertCloud(cloud, { format, resolvedSourceCrs: resolveLocal(cloud.name) });
      expect(report.ok).toBe(true);
      expect(worstDelta((await readBack(format, file!.bytes)).pts, model)).toBeLessThan(0.001);
      expect(report.crsNote).toBe('no CRS recorded (coordinates unchanged)');
      expect(report.events?.some((e) => e.id === 'axes-y-up-to-z-up')).toBe(false);
    }
  });

  it('the explicit option rotates (x, y, z) to (x, -z, y) and the report and file say so', async () => {
    const cloud = await loadPly(plyBytes(model), 'room.ply');
    const rotated = model.map(([x, y, z]) => [x, -z, y] as Pt);
    for (const format of FORMATS) {
      const { file, report } = convertCloud(cloud, {
        format,
        resolvedSourceCrs: resolveLocal(cloud.name),
        axisHandling: 'y-up-to-z-up',
      });
      expect(report.ok, report.log.map((l) => l.message).join(' | ')).toBe(true);
      expect(worstDelta((await readBack(format, file!.bytes)).pts, rotated)).toBeLessThan(0.001);
      // The report never claims unchanged coordinates for a rotated file.
      expect(report.crsNote).toBe('no CRS recorded (axes rotated Y-up to Z-up)');
      expect(report.crsNote).not.toMatch(/unchanged/);
      const event = report.events?.find((e) => e.id === 'axes-y-up-to-z-up');
      expect(event?.acknowledged).toBe(true);
      expect(event?.points).toBe(model.length);
      expect(report.log.some((l) => /\(x, -z, y\)/.test(l.message))).toBe(true);
      // The file itself carries the rotation, in the ASCII header or the LAS text-area record.
      const raw = new TextDecoder('latin1').decode(file!.bytes);
      expect(raw).toContain('Conversion event axes-y-up-to-z-up');
      expect(raw).not.toContain('coordinates unchanged');
    }
  });

  it('the explicit option is refused when the export keeps or assigns a CRS', async () => {
    const pts = SHAPES['north/south-facing facade'](500000, 4000000, 100);
    const cloud = await loadPly(plyBytes(pts), 'surveyed.ply');
    const resolved = resolveEpsg(cloud.name, 32613);
    for (const mode of ['keep', 'assign'] as const) {
      const { file, report } = convertCloud(cloud, {
        format: 'las14', crsMode: mode, targetEpsg: 32613, resolvedSourceCrs: resolved, axisHandling: 'y-up-to-z-up',
      });
      expect(file).toBeNull();
      const err = report.log.find((l) => l.level === 'error')?.message ?? '';
      expect(err).toContain('EPSG:32613');
      expect(err).toContain(Y_UP_TO_Z_UP_OPT_IN);
    }
    // Assigning a CRS to a local model is refused too: the output then has one.
    const local = await loadPly(plyBytes(model), 'room.ply');
    const assigned = convertCloud(local, {
      format: 'xyz', crsMode: 'assign', targetEpsg: 32613, resolvedSourceCrs: resolveLocal(local.name), axisHandling: 'y-up-to-z-up',
    });
    expect(assigned.file).toBeNull();
  });

  it('the explicit option is refused for a format that is Z-up by specification', () => {
    const las = new PointCloud({ positions: Float32Array.from([1, 2, 3]), origin: [0, 0, 0], sourceFormat: 'las', name: 's.las' });
    const { file, report } = convertCloud(las, { format: 'xyz', axisHandling: 'y-up-to-z-up' });
    expect(file).toBeNull();
    expect(report.log.find((l) => l.level === 'error')?.message).toMatch(/LAS is Z-up by specification/);
  });

  it('a glTF source (Y-up by specification) under a CRS is refused, not rotated', () => {
    const glb = new PointCloud({ positions: Float32Array.from([1, 2, 3]), origin: [500000, 0, 4000000], sourceFormat: 'glb', name: 'm.glb' });
    const opts: ConvertOptions = { format: 'xyz', crsMode: 'assign', targetEpsg: 32613, resolvedSourceCrs: null };
    const refused = convertCloud(glb, opts);
    expect(refused.file).toBeNull();
    expect(refused.report.log.find((l) => l.level === 'error')?.message).toMatch(/glTF stores Y as the up axis.*Reconcile the axes/);
    // With no CRS in play the same model is written as stored.
    const local = convertCloud(glb, { format: 'xyz', resolvedSourceCrs: null });
    expect(local.report.ok).toBe(true);
    expect(new TextDecoder().decode(local.file!.bytes).trim().split('\n').pop()).toBe('500001.000 2.000 4000003.000');
  });
});

describe('the viewing orientation never changes exported coordinates', () => {
  const pts = SHAPES['north/south-facing facade'](500000, 4000000, 100);

  it('the same points displayed Y-up (PLY) and Z-up (XYZ) export identically', async () => {
    const ply = await loadPly(plyBytes(pts), 'facade.ply');
    const xyzText = pts.map((p) => p.join(' ')).join('\n');
    const xyz = await loadXyz(new TextEncoder().encode(xyzText).buffer as ArrayBuffer, 'facade.xyz');
    // The two layers are displayed with different up vectors.
    expect(upOfFormat(ply.sourceFormat)).toEqual([0, 1, 0]);
    expect(upOfFormat(xyz.sourceFormat)).toEqual([0, 0, 1]);
    const resolved = resolveEpsg('facade', 32613);
    for (const format of FORMATS) {
      const a = await readBack(format, convertCloud(ply, { format, resolvedSourceCrs: resolved }).file!.bytes);
      const b = await readBack(format, convertCloud(xyz, { format, resolvedSourceCrs: resolved }).file!.bytes);
      expect(worstDelta(a.pts, b.pts)).toBeLessThan(0.001);
      expect(worstDelta(a.pts, pts)).toBeLessThan(0.001);
    }
  });

  it('whatever up the shape classifier reports, the written bytes are the same', async () => {
    const cloud = await loadPly(plyBytes(pts), 'facade.ply');
    const resolved = resolveEpsg(cloud.name, 32613);
    const run = (up: 'y' | 'z'): Uint8Array => {
      shapeCalls.up = up;
      shapeCalls.count = 0;
      const out = convertCloud(cloud, { format: 'las14', resolvedSourceCrs: resolved }).file!.bytes;
      expect(shapeCalls.count).toBe(0);
      return out;
    };
    const asY = run('y');
    const asZ = run('z');
    shapeCalls.up = null;
    expect(Buffer.from(asY).equals(Buffer.from(asZ))).toBe(true);
  });
});
