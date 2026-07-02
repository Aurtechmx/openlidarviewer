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
    sourceMetadata: null,
    warnings: [],
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

describe('loadE57 — pose rotation of normals', () => {
  // 90° yaw about +Z: q = [w, x, y, z] = [√2/2, 0, 0, √2/2] maps +X → +Y.
  // Hand-derivation for p = (1, 0, 0):
  //   t = 2 · (q.xyz × p) = 2 · ((0,0,√2/2) × (1,0,0)) = (0, √2, 0)
  //   p + w·t + q.xyz × t = (1,0,0) + (0,1,0) + (−1,0,0) = (0, 1, 0).
  const YAW_90: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

  it('rotates normals with the geometry (rotation only, no translation)', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan(
          'posed',
          1,
          {
            cartesianX: Float64Array.from([1]),
            cartesianY: Float64Array.from([0]),
            cartesianZ: Float64Array.from([0]),
            normalX: Float64Array.from([1]),
            normalY: Float64Array.from([0]),
            normalZ: Float64Array.from([0]),
          },
          { rotation: YAW_90, translation: [100, 200, 300] },
        ),
      ]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'posed.e57');

    // Geometry: (1,0,0) rotated to (0,1,0), then translated → (100, 201, 300).
    // The floored origin is (100, 201, 300), so the local position is ~0.
    expect(cloud.origin).toEqual([100, 201, 300]);
    // Normal: rotated to (0,1,0) — and NOT shifted by the translation, which
    // would have produced the nonsense direction (100, 201, 300).
    expect(cloud.normals).toBeDefined();
    expect(cloud.normals![0]).toBeCloseTo(0, 6);
    expect(cloud.normals![1]).toBeCloseTo(1, 6);
    expect(cloud.normals![2]).toBeCloseTo(0, 6);
  });

  it('threads parser warnings (pose anomalies) into the cloud load warnings', async () => {
    const result = parseResult([
      scan('solo', 1, {
        cartesianX: Float64Array.from([1.5]),
        cartesianY: Float64Array.from([2.5]),
        cartesianZ: Float64Array.from([3.5]),
      }),
    ]);
    result.warnings.push('Scan "solo": pose rotation quaternion has norm 2.000000 (expected 1) — normalised before use.');
    mockedParse.mockReturnValue(result);
    const cloud = await loadE57(new ArrayBuffer(0), 'solo.e57');
    expect(cloud.metadata?.loadWarnings).toEqual([
      'Scan "solo": pose rotation quaternion has norm 2.000000 (expected 1) — normalised before use.',
    ]);
  });

  it('leaves normals untouched when the scan has no pose', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('unposed', 1, {
          cartesianX: Float64Array.from([1.5]),
          cartesianY: Float64Array.from([2.5]),
          cartesianZ: Float64Array.from([3.5]),
          normalX: Float64Array.from([0.6]),
          normalY: Float64Array.from([0.8]),
          normalZ: Float64Array.from([0]),
        }),
      ]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'unposed.e57');
    expect(cloud.normals![0]).toBeCloseTo(0.6, 6);
    expect(cloud.normals![1]).toBeCloseTo(0.8, 6);
    expect(cloud.normals![2]).toBeCloseTo(0, 6);
  });
});

describe('loadE57 — declared source metadata attach (v0.5.4)', () => {
  const onePoint = (): E57ScanData[] => [
    scan('s', 1, {
      cartesianX: Float64Array.from([1.5]),
      cartesianY: Float64Array.from([2.5]),
      cartesianZ: Float64Array.from([3.5]),
    }),
  ];

  it('attaches sourceMetadata and the load-time declaredCapture', async () => {
    const result = parseResult(onePoint());
    result.sourceMetadata = {
      standard: [
        { name: 'sensorModel', value: 'Procedural heritage reference reconstruction' },
      ],
      extensions: [
        { name: 'license', value: 'CC-BY-4.0', namespaceUri: 'https://aurtech.mx/olv' },
      ],
    };
    mockedParse.mockReturnValue(result);
    const cloud = await loadE57(new ArrayBuffer(0), 'declared.e57');
    expect(cloud.metadata?.sourceMetadata).toEqual(result.sourceMetadata);
    // The keyword scan runs at LOAD time (lazy chunk), so the classifier
    // wiring in the startup shell reads a plain precomputed field.
    expect(cloud.metadata?.declaredCapture).toMatchObject({
      field: 'sensorModel',
      value: 'Procedural heritage reference reconstruction',
    });
    expect(cloud.metadata?.declaredCapture?.label).toBe(
      'Declared: Procedural heritage reference reconstruction (from file metadata)',
    );
  });

  it('attaches sourceMetadata WITHOUT declaredCapture for a physical sensor', async () => {
    const result = parseResult(onePoint());
    result.sourceMetadata = {
      standard: [{ name: 'sensorModel', value: 'VZ-400i' }],
      extensions: [],
    };
    mockedParse.mockReturnValue(result);
    const cloud = await loadE57(new ArrayBuffer(0), 'tls.e57');
    expect(cloud.metadata?.sourceMetadata).toEqual(result.sourceMetadata);
    expect(cloud.metadata?.declaredCapture).toBeUndefined();
  });

  it('attaches neither when the file declares nothing', async () => {
    mockedParse.mockReturnValue(parseResult(onePoint()));
    const cloud = await loadE57(new ArrayBuffer(0), 'bare.e57');
    expect(cloud.metadata?.sourceMetadata).toBeUndefined();
    expect(cloud.metadata?.declaredCapture).toBeUndefined();
  });
});
