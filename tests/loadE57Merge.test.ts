/**
 * loadE57Merge.test.ts — the multi-scan merge in `loadE57`.
 *
 * The parser (`parseE57`) is covered against a real fixture in e57.test.ts;
 * here it is mocked so the MERGE logic can be pinned against hand-computed
 * scan data: a scan with no Cartesian X/Y/Z must be skipped WITHOUT leaving
 * phantom zero-coordinate points (the pre-v0.5.4 bug counted its records
 * into the allocation but never wrote them, parking `total − written` points
 * at the local origin), the declared/decoded counts must describe what was
 * actually merged, and a load warning must name the skipped scan.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { E57ScanData, E57ParseResult } from '../src/io/e57/parseE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);

/** Minimal scan builder — only the fields the merge actually consumes. */
function scan(
  name: string,
  recordCount: number,
  columns: Record<string, Float64Array>,
  pose: E57ScanData['pose'] = null,
): E57ScanData {
  return {
    name,
    guid: `guid-${name}`,
    recordCount,
    columns,
    fields: [],
    pose,
    colorMax: null,
    intensityMax: null,
  };
}

function parseResult(scans: E57ScanData[]): E57ParseResult {
  return {
    scans,
    metadata: { formatName: 'ASTM E57 3D Imaging Data File', guid: 'g', library: 'test-lib', creationDateTime: null },
  };
}

beforeEach(() => {
  mockedParse.mockReset();
});

describe('loadE57 — merging a Cartesian scan with a spherical-only scan', () => {
  // Scan "front": 3 records, records 0 and 2 valid (invalid[1] = 1).
  // Valid global points, hand-picked so no local coordinate is 0:
  //   (10.5, 20.5, 5.5) and (12.5, 22.5, 7.5)
  // min = (10.5, 20.5, 5.5) → floored origin (10, 20, 5) → local
  //   (0.5, 0.5, 0.5) and (2.5, 2.5, 2.5).
  // Scan "dome": 4 records, spherical prototype only — no cartesian columns.
  const front = (): E57ScanData =>
    scan('front', 3, {
      cartesianX: Float64Array.from([10.5, 99, 12.5]),
      cartesianY: Float64Array.from([20.5, 99, 22.5]),
      cartesianZ: Float64Array.from([5.5, 99, 7.5]),
      cartesianInvalidState: Float64Array.from([0, 1, 0]),
      colorRed: Float64Array.from([10, 0, 40]),
      colorGreen: Float64Array.from([20, 0, 50]),
      colorBlue: Float64Array.from([30, 0, 60]),
    });
  const dome = (): E57ScanData =>
    scan('dome', 4, {
      sphericalRange: Float64Array.from([1, 2, 3, 4]),
      sphericalAzimuth: Float64Array.from([0, 0, 0, 0]),
      sphericalElevation: Float64Array.from([0, 0, 0, 0]),
    });

  it('merges only the Cartesian scan — no phantom origin points', async () => {
    mockedParse.mockReturnValue(parseResult([front(), dome()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scans.e57');

    // 2 valid points, not 2 + 4 phantom records.
    expect(cloud.pointCount).toBe(2);
    expect(cloud.positions.length).toBe(6);
    expect(cloud.origin).toEqual([10, 20, 5]);
    expect([...cloud.positions]).toEqual([0.5, 0.5, 0.5, 2.5, 2.5, 2.5]);
    // No point sits at the local origin (the phantom signature).
    for (let i = 0; i < cloud.pointCount; i++) {
      const isOrigin =
        cloud.positions[i * 3] === 0 &&
        cloud.positions[i * 3 + 1] === 0 &&
        cloud.positions[i * 3 + 2] === 0;
      expect(isOrigin).toBe(false);
    }
  });

  it('declares honest counts — the merged total, not the file record total', async () => {
    mockedParse.mockReturnValue(parseResult([front(), dome()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scans.e57');
    expect(cloud.declaredPointCount).toBe(2);
    expect(cloud.decodedPointCount).toBe(2);
  });

  it('records a load warning that names the skipped scan and its record count', async () => {
    mockedParse.mockReturnValue(parseResult([front(), dome()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scans.e57');
    const warnings = cloud.metadata?.loadWarnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"dome"/);
    expect(warnings[0]).toMatch(/skipped 4/);
    expect(warnings[0]).toMatch(/Cartesian X\/Y\/Z/);
  });

  it('does not let the skipped scan veto attributes the merged scans carry', async () => {
    mockedParse.mockReturnValue(parseResult([front(), dome()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scans.e57');
    // "front" carries RGB; "dome" (skipped) does not — colours must survive.
    expect(cloud.colors).toBeDefined();
    expect([...cloud.colors!]).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('still rejects a file where NO scan has Cartesian coordinates', async () => {
    mockedParse.mockReturnValue(parseResult([dome()]));
    await expect(loadE57(new ArrayBuffer(0), 'dome-only.e57')).rejects.toThrow(
      /no valid points/,
    );
  });

  it('emits no warnings for an all-Cartesian file', async () => {
    mockedParse.mockReturnValue(parseResult([front()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'one-scan.e57');
    expect(cloud.metadata?.loadWarnings).toBeUndefined();
  });
});
