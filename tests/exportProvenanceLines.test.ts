/**
 * The provenance lines every converted XYZ / ASC / LAS file carries, the
 * measurement CSV sidecar, and the active-scan hooks that feed it.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { writeXyz } from '../src/convert/writeAscii';
import { loadXyz } from '../src/io/loadXyz';
import { cloudToGlobal } from '../src/convert/globalPoints';
import {
  classEditLine,
  classesEdited,
  pointBasisOfCloud,
  softwareLine,
  sourceFileLine,
  measurementCsvProvenance,
  provenanceSidecarName,
} from '../src/export/exportProvenanceLines';
import { activeScanBasisOf } from '../src/app/measurementScanHooks';

const cloud = (): PointCloud => new PointCloud({
  positions: Float32Array.from([0, 0, 0, 10, 20, 1, 4, 5, 6]),
  origin: [500000, 4000000, 100],
  sourceFormat: 'las',
  name: 'survey.las',
} as unknown as ConstructorParameters<typeof PointCloud>[0]);

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const comments = (t: string): string[] => t.split('\n').filter((l) => l.startsWith('#'));
const points = (t: string): string[] => t.trim().split('\n').filter((l) => !l.startsWith('#'));

/** The LASF_Spec Text Area Description (record 3) payload of a LAS 1.2/1.4 file. */
function textArea(las: Uint8Array): string | null {
  const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
  const headerSize = view.getUint16(94, true);
  const n = view.getUint32(100, true);
  const str = (off: number, len: number): string => {
    let out = '';
    for (let i = 0; i < len && las[off + i] !== 0; i++) out += String.fromCharCode(las[off + i]);
    return out;
  };
  let p = headerSize;
  for (let i = 0; i < n; i++) {
    const recLen = view.getUint16(p + 20, true);
    if (str(p + 2, 16) === 'LASF_Spec' && view.getUint16(p + 18, true) === 3) return str(p + 54, recLen);
    p += 54 + recLen;
  }
  return null;
}

describe('provenance line helpers', () => {
  it('names the build, dropping an unresolved commit and marking a dirty tree', () => {
    expect(softwareLine({ version: '0.7.0', commit: 'a1b2c3d', dirty: false })).toBe('Software: OpenLiDARViewer 0.7.0 (a1b2c3d)');
    expect(softwareLine({ version: '0.7.0', commit: 'a1b2c3d', dirty: true })).toBe('Software: OpenLiDARViewer 0.7.0 (a1b2c3d+dirty)');
    expect(softwareLine({ version: '0.7.0', commit: 'unknown', dirty: false })).toBe('Software: OpenLiDARViewer 0.7.0');
  });

  it('writes the source basename, never a host path', () => {
    expect(sourceFileLine('data/sub/site.laz')).toBe('Source file: site.laz');
    expect(sourceFileLine('C:\\scans\\site.laz')).toBe('Source file: site.laz');
    expect(sourceFileLine(null)).toBe('Source file: unknown');
  });

  it('counts an edit epoch above 0 or non-source codes as edited', () => {
    expect(classesEdited({ provenance: 'source', editEpoch: 0 })).toBe(false);
    expect(classesEdited({ provenance: 'source', editEpoch: 2 })).toBe(true);
    expect(classesEdited({ provenance: 'derived', editEpoch: 0 })).toBe(true);
    expect(classesEdited({ provenance: 'cleared', editEpoch: 0 })).toBe(true);
    expect(classEditLine(true)).toBe('Classes edited in app: yes');
  });

  it('states the point basis for a full file and a display sample', () => {
  });
});

describe('point basis of a loaded cloud', () => {
  const trunc = (read: number, declared: number) => ({ truncation: { read, declared } });

  it('a full file', () => {
    expect(pointBasisOfCloud({ pointCount: 1200 }, null)).toBe('Point basis: full file (1,200 points)');
    expect(pointBasisOfCloud({ pointCount: 1200, sourceDeclaredPointCount: 1200 }, false)).toBe('Point basis: full file (1,200 points)');
  });

  it('a full-resolution cloud holding fewer points than declared is not called the full file', () => {
    const line = pointBasisOfCloud({ pointCount: 900, sourceDeclaredPointCount: 1000 }, false);
    expect(line).not.toMatch(/full file/);
    expect(line).toBe('Point basis: display sample (900 of 1,000 points)');
  });

  it('a strided display sample, from the load stride or the caller\'s reduced state', () => {
    expect(pointBasisOfCloud({ pointCount: 500, loadStride: 4, sourceDeclaredPointCount: 2000 }, null))
      .toBe('Point basis: display sample (500 of 2,000 points)');
    expect(pointBasisOfCloud({ pointCount: 500, sourceDeclaredPointCount: 2000 }, true))
      .toBe('Point basis: display sample (500 of 2,000 points)');
  });

  it('a voxel-reduced cloud, from the declared-count fallback', () => {
    expect(pointBasisOfCloud({ pointCount: 800, declaredPointCount: 3000 }, null))
      .toBe('Point basis: display sample (800 of 3,000 points)');
  });

  it('a truncated file is named as truncated, never as a display sample', () => {
    const c = { pointCount: 4, declaredPointCount: 2601, metadata: trunc(4, 2601) };
    expect(pointBasisOfCloud(c, null)).toBe('Point basis: truncated file (4 of 2,601 declared points read)');
    expect(pointBasisOfCloud(c, false)).toBe('Point basis: truncated file (4 of 2,601 declared points read)');
  });

  it('a truncated file also sampled for display names both, with each count', () => {
    const c = { pointCount: 250, loadStride: 4, sourceDeclaredPointCount: 5000, metadata: trunc(1000, 5000) };
    expect(pointBasisOfCloud(c, null))
      .toBe('Point basis: truncated file, display sample (250 held of 1,000 read of 5,000 declared points)');
    expect(pointBasisOfCloud(c, true))
      .toBe('Point basis: truncated file, display sample (250 held of 1,000 read of 5,000 declared points)');
  });

  it('the converter writes the truncated basis into a LAS file', () => {
    const c = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'cut.las',
      declaredPointCount: 10,
      metadata: { truncation: { read: 2, declared: 10 } },
    } as unknown as ConstructorParameters<typeof PointCloud>[0]);
    const { file } = convertCloud(c, { format: 'las' });
    expect(textArea(file!.bytes)).toContain('Point basis: truncated file (2 of 10 declared points read)');
  });
});

describe('XYZ', () => {
  it('opens with the product, CRS, software, source and basis lines; the numbers are unchanged', () => {
    const { file } = convertCloud(cloud(), { format: 'xyz' });
    const t = text(file!.bytes);
    expect(comments(t)).toEqual([
      '# OpenLiDARViewer XYZ export',
      '# crs: none recorded (coordinates unchanged from the source)',
      expect.stringMatching(/^# Software: OpenLiDARViewer \S+ \(testtest\)$/),
      '# Source file: survey.las',
      '# Point basis: full file (3 points)',
      '# Classes edited in app: no',
    ]);
    // The point lines are exactly what the writer produced before any header.
    const bare = writeXyz(cloudToGlobal(cloud()), 3);
    expect(points(t)).toEqual(bare.trim().split('\n'));
  });

  it('records a display sample, a class edit and the CRS the caller passes', () => {
    const { file } = convertCloud(cloud(), {
      format: 'xyz',
      displaySample: { held: 3, source: 9000 },
      classesEdited: true,
      resolvedSourceCrs: { epsg: 32613, name: 'WGS 84 / UTM zone 13N' } as never,
    });
    const c = comments(text(file!.bytes));
    expect(c).toContain('# crs: EPSG:32613');
    expect(c).toContain('# Point basis: display sample (3 of 9,000 points)');
    expect(c).toContain('# Classes edited in app: yes');
  });

  it('still parses in the app\'s own XYZ reader', async () => {
    const { file } = convertCloud(cloud(), { format: 'xyz', classesEdited: true });
    const out = await loadXyz(file!.bytes.slice().buffer as ArrayBuffer, 'survey.xyz');
    expect(out.pointCount).toBe(3);
  });
});

describe('ASC', () => {
  it('carries the same lines as # comments ahead of the columns line', () => {
    const t = text(convertCloud(cloud(), { format: 'asc', classesEdited: false }).file!.bytes);
    const c = comments(t);
    expect(c[0]).toBe('# OpenLiDARViewer ASC export');
    expect(c[1]).toMatch(/^# crs: /);
    expect(c).toContain('# Source file: survey.las');
    expect(c).toContain('# Point basis: full file (3 points)');
    expect(c).toContain('# Classes edited in app: no');
    expect(c[c.length - 1]).toBe('# columns: x y z');
    expect(c.some((l) => /^# Software: OpenLiDARViewer /.test(l))).toBe(true);
    expect(points(t)).toHaveLength(3);
  });
});

/** The line a LAS export adds when the cloud records no source scale and offset. */
const NO_SOURCE_QUANTISATION = 'Scale/offset: re-quantised (the source scale and offset are not recorded for this cloud).';

describe('LAS', () => {
  it('adds the point basis and class-edit lines to the Text Area provenance', () => {
    for (const format of ['las', 'las14'] as const) {
      const { file } = convertCloud(cloud(), { format, classesEdited: true, pointBasis: 'Point basis: full file (9,000 points)' });
      expect(textArea(file!.bytes)).toBe(`Point basis: full file (9,000 points)\nClasses edited in app: yes\n${NO_SOURCE_QUANTISATION}`);
    }
  });
});

describe('measurement CSV sidecar', () => {
  it('is named after the CSV', () => {
    expect(provenanceSidecarName('site-measurements.csv')).toBe('site-measurements.provenance.txt');
  });

  it('lists the build, source, digest, CRS, basis and class-edit state', () => {
    const t = measurementCsvProvenance(
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'site',
        crsName: 'EPSG:32613',
        digests: { sourceSha256: 'ab'.repeat(32), sourceSha256Note: null } as never,
        build: { version: '0.7.0', commit: 'a1b2c3d', dirty: false, builtAt: '' } as never,
      },
      { pointBasis: 'Point basis: full file (10 points)', classesEdited: false, sourceName: 'site.laz' },
    );
    const lines = t.trimEnd().split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'OpenLiDARViewer measurement CSV provenance',
      'Software: OpenLiDARViewer 0.7.0 (a1b2c3d)',
      'Generated: 2026-01-01T00:00:00.000Z',
      'Source file: site.laz',
      `Source SHA-256: ${'ab'.repeat(32)}`,
      'CRS: EPSG:32613',
    ]);
    expect(lines.slice(-2)).toEqual(['Point basis: full file (10 points)', 'Classes edited in app: no']);
  });
});

describe('active-scan basis', () => {
  const loaded = (prov: string, declared?: number) => ({
    key: { pointCount: 500, sourceDeclaredPointCount: declared, classificationProvenance: prov },
    streamed: false,
  });

  it('reads a display sample and an edit epoch above 0', () => {
    expect(activeScanBasisOf(loaded('source', 2000), 1)).toEqual({
      pointBasis: 'Point basis: display sample (500 of 2,000 points)',
      classesEdited: true,
    });
  });

  it('reads a full-file scan with source classes as unedited, derived classes as edited', () => {
    expect(activeScanBasisOf(loaded('source'), 0)).toEqual({ pointBasis: 'Point basis: full file (500 points)', classesEdited: false });
    expect(activeScanBasisOf(loaded('derived'), 0)?.classesEdited).toBe(true);
  });

  it('reads a streaming snapshot from its resident and source counts', () => {
    const partial = { key: { residentPointCount: 300, sourcePointCount: 1000 }, streamed: true };
    expect(activeScanBasisOf(partial, 0)?.pointBasis).toBe('Point basis: display sample (300 of 1,000 points)');
    const whole = { key: { residentPointCount: 1000, sourcePointCount: 1000 }, streamed: true };
    expect(activeScanBasisOf(whole, 0)?.pointBasis).toBe('Point basis: full file (1,000 points)');
  });

  it('is null with no source in the frame', () => {
    expect(activeScanBasisOf(undefined, 0)).toBeNull();
  });
});
