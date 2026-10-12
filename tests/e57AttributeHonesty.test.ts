/**
 * e57AttributeHonesty.test.ts — what `loadE57` reports about attributes it
 * cannot carry faithfully:
 *
 *   - points whose colour or intensity the file flags invalid
 *     (`isColorInvalid` / `isIntensityInvalid`);
 *   - the per-scan rule that mapped intensity onto the 0–65535 store, and the
 *     exports that name the channel as normalised;
 *   - a channel present in some merged scans but not all, which the merge drops;
 *   - a scan whose pose cannot be read, which is skipped rather than placed by
 *     a guessed rotation.
 *
 * The parser is mocked (as in loadE57Merge.test.ts) so the columns are
 * hand-built and synthetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseE57 } from '../src/io/e57/parseE57';
import type { E57ScanData } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { LoadError } from '../src/io/loadErrors';
import { toCsv, toXyz } from '../src/io/exporters';
import { intensityNormalisationLine } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { READ_EVERY_RECORD, scan, parseResult } from './helpers/e57ScanFixtures';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);

const f64 = (...v: number[]): Float64Array => Float64Array.from(v);

/** Cartesian columns for `n` distinct finite points. */
function xyz(n: number, x0 = 0): Record<string, Float64Array> {
  return {
    cartesianX: Float64Array.from({ length: n }, (_, i) => x0 + i),
    cartesianY: Float64Array.from({ length: n }, () => 1),
    cartesianZ: Float64Array.from({ length: n }, () => 2),
  };
}

const load = (name = 'synthetic.e57') =>
  loadE57(new ArrayBuffer(0), name, { plan: READ_EVERY_RECORD });

beforeEach(() => {
  mockedParse.mockReset();
});

describe('loadE57 — invalid colour / intensity flags', () => {
  it('keeps the geometry of flagged points and reports the counts', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('flagged', 4, {
          ...xyz(4),
          colorRed: f64(10, 20, 30, 40),
          colorGreen: f64(10, 20, 30, 40),
          colorBlue: f64(10, 20, 30, 40),
          isColorInvalid: f64(0, 1, 1, 0),
          intensity: f64(100, 200, 300, 400),
          isIntensityInvalid: f64(1, 0, 0, 0),
        }),
      ]),
    );
    const cloud = await load();
    expect(cloud.pointCount).toBe(4);
    const w = (cloud.metadata?.loadWarnings ?? []).join('\n');
    expect(w).toMatch(/"flagged"/);
    expect(w).toMatch(/2 point\(s\) with invalid colour/);
    expect(w).toMatch(/1 point\(s\) with invalid intensity/);
  });

  it('leaves flagged intensity out of the observed-maximum rule', async () => {
    // Valid values are unit range; one flagged value of 5000 must not switch
    // the scan to the raw rule.
    mockedParse.mockReturnValue(
      parseResult([
        scan('unit', 3, {
          ...xyz(3),
          intensity: f64(0.25, 0.75, 5000),
          isIntensityInvalid: f64(0, 0, 1),
        }),
      ]),
    );
    const cloud = await load();
    expect(cloud.intensity![0]).toBe(16384);
    expect(cloud.intensity![1]).toBe(49151);
  });

  it('adds no warning when nothing is flagged', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('clean', 2, { ...xyz(2), intensity: f64(1, 2), isIntensityInvalid: f64(0, 0) }),
      ]),
    );
    const cloud = await load();
    expect(cloud.metadata?.loadWarnings ?? []).toEqual([]);
  });
});

describe('loadE57 — intensity normalisation is recorded', () => {
  it('records the per-scan declared limits used', async () => {
    const s = scan('limits', 2, { ...xyz(2), intensity: f64(0.3, 0.7) });
    s.intensityLimits = { minimum: 0.2, maximum: 0.8 };
    mockedParse.mockReturnValue(parseResult([s]));
    const cloud = await load();
    const n = cloud.metadata?.intensityNormalisation;
    expect(n?.rescaled).toBe(true);
    expect(n?.scans).toEqual([
      { scan: 'limits', rule: 'declared-limits', minimum: 0.2, maximum: 0.8 },
    ]);
    const line = intensityNormalisationLine(cloud.metadata);
    expect(line).toMatch(/normalised/);
    expect(line).toMatch(/not calibrated reflectance/);
    expect(line).toMatch(/0\.2/);
  });

  it('records the observed unit-range rule and the raw rule', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('unit', 2, { ...xyz(2), intensity: f64(0.25, 0.5) }),
        scan('raw', 2, { ...xyz(2, 10), intensity: f64(12, 300) }),
      ]),
    );
    const cloud = await load();
    expect(cloud.metadata?.intensityNormalisation?.scans.map((s) => s.rule)).toEqual([
      'observed-unit-range',
      'raw',
    ]);
  });

  it('names the CSV column and the XYZ header as normalised', async () => {
    const s = scan('limits', 2, { ...xyz(2), intensity: f64(0.3, 0.7) });
    s.intensityLimits = { minimum: 0.2, maximum: 0.8 };
    mockedParse.mockReturnValue(parseResult([s]));
    const cloud = await load();
    expect(toCsv(cloud).split('\n')[0]).toBe('x,y,z,intensity_normalised');
    const xyzText = toXyz(cloud);
    expect(xyzText).toMatch(/^# intensity: .*normalised/m);
  });

  it('records the normalisation in an ASC conversion, which writes intensity', async () => {
    const s = scan('limits', 2, { ...xyz(2), intensity: f64(0.3, 0.7) });
    s.intensityLimits = { minimum: 0.2, maximum: 0.8 };
    mockedParse.mockReturnValue(parseResult([s]));
    const cloud = await load();
    const { file } = convertCloud(cloud, { format: 'asc' });
    expect(new TextDecoder().decode(file!.bytes)).toMatch(/^# intensity: normalised/m);
  });

  it('leaves a raw-only intensity export unchanged', async () => {
    mockedParse.mockReturnValue(
      parseResult([scan('raw', 2, { ...xyz(2), intensity: f64(12, 300) })]),
    );
    const cloud = await load();
    expect(cloud.metadata?.intensityNormalisation?.rescaled).toBe(false);
    expect(intensityNormalisationLine(cloud.metadata)).toBeNull();
    expect(toCsv(cloud).split('\n')[0]).toBe('x,y,z,intensity');
  });
});

describe('loadE57 — channels present in only some merged scans', () => {
  it('names each dropped channel and the scans that lack it', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('A', 1, {
          ...xyz(1),
          intensity: f64(5),
          classification: f64(2),
          colorRed: f64(1),
          colorGreen: f64(1),
          colorBlue: f64(1),
          normalX: f64(0),
          normalY: f64(0),
          normalZ: f64(1),
        }),
        scan('B', 1, { ...xyz(1, 5) }),
      ]),
    );
    const cloud = await load();
    expect(cloud.intensity).toBeUndefined();
    expect(cloud.colors).toBeUndefined();
    const w = cloud.metadata?.loadWarnings ?? [];
    for (const ch of ['colour', 'intensity', 'classification', 'normals']) {
      const hit = w.find((l) => l.includes(`${ch} channel`));
      expect(hit, ch).toBeDefined();
      expect(hit).toMatch(/"B"/);
      expect(hit).not.toMatch(/"A"/);
    }
  });

  it('adds no channel warning when every scan agrees', async () => {
    mockedParse.mockReturnValue(
      parseResult([scan('A', 1, { ...xyz(1) }), scan('B', 1, { ...xyz(1, 5) })]),
    );
    const cloud = await load();
    expect(cloud.metadata?.loadWarnings ?? []).toEqual([]);
  });
});

describe('loadE57 — scans whose pose is refused', () => {
  function refused(name: string, n: number, x0: number): E57ScanData {
    return { ...scan(name, n, xyz(n, x0)), poseRefused: 'pose rotation x is not a finite number ("abc")' };
  }

  it('skips the refused scan with a warning and keeps the others', async () => {
    mockedParse.mockReturnValue(
      parseResult([scan('good', 2, xyz(2)), refused('bad', 3, 100)]),
    );
    const cloud = await load();
    expect(cloud.pointCount).toBe(2);
    const w = (cloud.metadata?.loadWarnings ?? []).join('\n');
    expect(w).toMatch(/"bad"/);
    expect(w).toMatch(/not a finite number/);
    expect(w).toMatch(/skipped/);
  });

  it('fails the load clearly when every scan is refused', async () => {
    mockedParse.mockReturnValue(parseResult([refused('bad', 3, 0)]));
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(/no scan could be placed/i);
    expect((err as Error).message).toMatch(/"bad"/);
  });
});
