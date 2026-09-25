/**
 * e57AcquisitionStations.test.ts — the AcquisitionStations sidecar (OB-INT-02)
 * for multi-scan E57.
 *
 * Mocks `parseE57` the same way `tests/loadE57Merge.test.ts` does, so the
 * MERGE loop's new station bookkeeping is pinned against hand-computed scan
 * data rather than a binary fixture. E57's per-scan pose and membership are
 * exactly what OB-INT-02 targets for the unstructured path: SPEC §1.3 states
 * they are otherwise "applied and then discarded" once per scan, and that is
 * this file's `loadE57Merge.test.ts` sibling already covers the merge without
 * ever asserting the pose or the record range survive it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { E57ScanData } from '../src/io/e57/parseE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { READ_EVERY_RECORD, parseResult, scan } from './helpers/e57ScanFixtures';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);

beforeEach(() => {
  mockedParse.mockReset();
});

// 90 deg yaw about +Z, the same hand-derived quaternion loadE57Merge.test.ts
// uses, reused here so the numbers are already checked evidence, not new
// arithmetic to trust.
const YAW_90: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

describe('two posed scans', () => {
  const scanA = (): E57ScanData =>
    scan(
      'A',
      3,
      {
        cartesianX: Float64Array.from([1, 2, 3]),
        cartesianY: Float64Array.from([1, 2, 3]),
        cartesianZ: Float64Array.from([1, 2, 3]),
      },
      { rotation: [1, 0, 0, 0], translation: [10, 0, 0] },
    );
  const scanB = (): E57ScanData =>
    scan(
      'B',
      2,
      {
        cartesianX: Float64Array.from([4, 5]),
        cartesianY: Float64Array.from([4, 5]),
        cartesianZ: Float64Array.from([4, 5]),
      },
      { rotation: YAW_90, translation: [0, 20, 0] },
    );

  it('records one station per scan, with exact pre-drop ranges', async () => {
    mockedParse.mockReturnValue(parseResult([scanA(), scanB()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scan.e57', { plan: READ_EVERY_RECORD });
    expect(cloud.positions.length / 3).toBe(5);
    const stations = cloud.acquisitionStations?.stations;
    expect(stations).toHaveLength(2);
    expect(stations![0]).toMatchObject({
      id: 'scan-1',
      source: 'e57-scan',
      originStatus: 'DECLARED',
      recordRange: { start: 0, end: 3 },
    });
    expect(stations![1]).toMatchObject({
      id: 'scan-2',
      source: 'e57-scan',
      originStatus: 'DECLARED',
      recordRange: { start: 3, end: 5 },
    });
  });

  it("carries each scan's own declared pose", async () => {
    mockedParse.mockReturnValue(parseResult([scanA(), scanB()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'two-scan.e57', { plan: READ_EVERY_RECORD });
    const [a, b] = cloud.acquisitionStations!.stations;
    expect(a.pose.worldTranslation).toEqual([10, 0, 0]);
    expect(a.pose.rotation).toEqual({ w: 1, x: 0, y: 0, z: 0 });
    expect(a.pose.rotationSource).toBe('source-declared');
    expect(a.pose.localPositionSource).toBe('not-applicable');
    expect(b.pose.worldTranslation).toEqual([0, 20, 0]);
    expect(b.pose.rotation!.w).toBeCloseTo(Math.SQRT1_2, 10);
    expect(b.pose.rotation!.z).toBeCloseTo(Math.SQRT1_2, 10);
  });
});

describe('a scan with no pose element', () => {
  it('declares an identity placement, not an inferred one', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('unposed', 1, {
          cartesianX: Float64Array.from([1.5]),
          cartesianY: Float64Array.from([2.5]),
          cartesianZ: Float64Array.from([3.5]),
        }),
      ]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'unposed.e57', { plan: READ_EVERY_RECORD });
    const stations = cloud.acquisitionStations!.stations;
    expect(stations).toHaveLength(1);
    expect(stations[0].pose.worldTranslation).toEqual([0, 0, 0]);
    expect(stations[0].pose.localPositionSource).toBe('not-applicable');
    // No pose element means no rotation is DECLARED either — absent, never
    // filled with an identity quaternion a reader could mistake for a real one.
    expect(stations[0].pose.rotation).toBeUndefined();
    expect(stations[0].pose.rotationSource).toBeUndefined();
  });
});

describe('single-scan E57 (byte identity)', () => {
  // The exact fixture loadE57Merge.test.ts's "front" scan uses, so the
  // position bytes below are already-checked evidence: this test only adds
  // the station assertion, it does not re-derive the geometry.
  const solo = (): E57ScanData =>
    scan('front', 3, {
      cartesianX: Float64Array.from([10.5, 99, 12.5]),
      cartesianY: Float64Array.from([20.5, 99, 22.5]),
      cartesianZ: Float64Array.from([5.5, 99, 7.5]),
      cartesianInvalidState: Float64Array.from([0, 1, 0]),
    });

  it('gives the same points as before, plus one station covering all of them', async () => {
    mockedParse.mockReturnValue(parseResult([solo()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'one-scan.e57', { plan: READ_EVERY_RECORD });
    // Unchanged from loadE57Merge.test.ts's own assertion of this fixture.
    expect(cloud.pointCount).toBe(2);
    expect(cloud.origin).toEqual([10, 20, 5]);
    expect([...cloud.positions]).toEqual([0.5, 0.5, 0.5, 2.5, 2.5, 2.5]);
    const stations = cloud.acquisitionStations!.stations;
    expect(stations).toHaveLength(1);
    expect(stations[0].recordRange).toEqual({ start: 0, end: 2 });
  });
});

describe('a sanitation drop inside one station', () => {
  // scan A: 3 records that all pass the E57-level invalid check, but the
  // middle one is non-finite — dropped by sanitizeAndRecenter, one step
  // AFTER the merge loop that builds preStations. scan B is untouched.
  const scanA = (): E57ScanData =>
    scan('A', 3, {
      cartesianX: Float64Array.from([1, Number.NaN, 3]),
      cartesianY: Float64Array.from([1, 0, 3]),
      cartesianZ: Float64Array.from([1, 0, 3]),
    });
  const scanB = (): E57ScanData =>
    scan('B', 2, {
      cartesianX: Float64Array.from([10, 11]),
      cartesianY: Float64Array.from([10, 11]),
      cartesianZ: Float64Array.from([10, 11]),
    });

  it('shrinks the affected station and shifts the one after it', async () => {
    mockedParse.mockReturnValue(parseResult([scanA(), scanB()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'drop.e57', { plan: READ_EVERY_RECORD });
    expect(cloud.positions.length / 3).toBe(4); // 2 survivors + 2
    const stations = cloud.acquisitionStations!.stations;
    expect(stations[0].recordRange).toEqual({ start: 0, end: 2 });
    expect(stations[1].recordRange).toEqual({ start: 2, end: 4 });
  });
});

describe('a station whose records all drop', () => {
  it('records an empty range rather than omitting the station', async () => {
    const scanAllNaN = scan('gone', 2, {
      cartesianX: Float64Array.from([Number.NaN, Number.NaN]),
      cartesianY: Float64Array.from([0, 0]),
      cartesianZ: Float64Array.from([0, 0]),
    });
    const scanFine = scan('fine', 1, {
      cartesianX: Float64Array.from([1]),
      cartesianY: Float64Array.from([1]),
      cartesianZ: Float64Array.from([1]),
    });
    mockedParse.mockReturnValue(parseResult([scanAllNaN, scanFine]));
    const cloud = await loadE57(new ArrayBuffer(0), 'all-drop.e57', { plan: READ_EVERY_RECORD });
    const stations = cloud.acquisitionStations!.stations;
    expect(stations).toHaveLength(2);
    expect(stations[0].id).toBe('scan-1');
    expect(stations[0].recordRange).toEqual({ start: 0, end: 0 });
    expect(stations[1].recordRange).toEqual({ start: 0, end: 1 });
  });
});

describe('a strided decode (per-scan record counts already reduced)', () => {
  // parseE57 is mocked here, so the sampling ITSELF is not exercised — that is
  // tests/e57StrideDecode.test.ts's job, against a real binary fixture. What
  // this checks is loadE57's OWN new bookkeeping (preStations/scanStart/w):
  // given scans whose recordCount already reflects a stride (as a real
  // strided parseE57 would hand back), does each station's range still track
  // its scan's actual share of the merged output. Two scans with UNEQUAL
  // post-stride counts are chosen deliberately, so a station boundary that
  // silently assumed equal-sized scans would be caught.
  it('still tracks each scan\'s own share of the strided merge', async () => {
    const scanA = scan('A', 2, {
      cartesianX: Float64Array.from([1, 2]),
      cartesianY: Float64Array.from([1, 2]),
      cartesianZ: Float64Array.from([1, 2]),
    });
    const scanB = scan('B', 5, {
      cartesianX: Float64Array.from([10, 11, 12, 13, 14]),
      cartesianY: Float64Array.from([10, 11, 12, 13, 14]),
      cartesianZ: Float64Array.from([10, 11, 12, 13, 14]),
    });
    mockedParse.mockReturnValue(parseResult([scanA, scanB]));
    const cloud = await loadE57(new ArrayBuffer(0), 'strided.e57', {
      plan: { ...READ_EVERY_RECORD, stride: 5 },
    });
    expect(cloud.loadStride).toBe(5);
    const stations = cloud.acquisitionStations!.stations;
    expect(stations[0].recordRange).toEqual({ start: 0, end: 2 });
    expect(stations[1].recordRange).toEqual({ start: 2, end: 7 });
  });
});
