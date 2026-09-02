/**
 * gridAgreement.test.ts
 *
 * Exercises the raster comparison maths with SYNTHETIC grids. This proves the
 * comparison is correct; it validates no product and supports no claim.
 *
 * Expected statistics below are worked out by hand in the comments so a reader
 * can check them without running the code.
 */

import { describe, it, expect } from 'vitest';
import {
  compareGrids,
  compareGridsCircular,
  angularSeparationDeg,
  signedAngularDifferenceDeg,
  GRID_ALIGNMENT_EPSILON,
  type GridSpec,
  type Raster,
} from '../src/validation/gridAgreement';

const SPEC: GridSpec = { originX: 100, originY: 200, cellSize: 0.5, width: 2, height: 2 };

function raster(values: number[], spec: GridSpec = SPEC, nodata: number | null = null): Raster {
  return { spec, values, nodata };
}

describe('compareGrids refusals', () => {
  it('refuses a different origin instead of shifting', () => {
    const a = raster([1, 2, 3, 4]);
    const b = raster([1, 2, 3, 4], { ...SPEC, originX: 100.001 });
    const r = compareGrids(a, b, { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('grid-origin-differs');
    expect(r.detail).toContain('no shift is applied');
  });

  it('refuses a different cell size instead of resampling', () => {
    const a = raster([1, 2, 3, 4]);
    const b = raster([1, 2, 3, 4], { ...SPEC, cellSize: 1 });
    const r = compareGrids(a, b, { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('grid-cell-size-differs');
    expect(r.detail).toContain('no resample is performed');
  });

  it('refuses different dimensions', () => {
    const a = raster([1, 2, 3, 4]);
    const b = raster([1, 2, 3, 4], { ...SPEC, width: 4, height: 1 });
    const r = compareGrids(a, b, { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('grid-dimensions-differ');
  });

  it('accepts a float-representation difference below the alignment epsilon', () => {
    const a = raster([1, 2, 3, 4]);
    const b = raster([1, 2, 3, 4], { ...SPEC, originX: 100 + GRID_ALIGNMENT_EPSILON / 10 });
    const r = compareGrids(a, b, { tolerance: 0 });
    expect(r.status).toBe('compared');
  });

  it('refuses a value count that contradicts the spec', () => {
    const a = raster([1, 2, 3]);
    const b = raster([1, 2, 3, 4]);
    const r = compareGrids(a, b, { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('value-count-mismatch');
  });

  it('refuses a mask of the wrong length', () => {
    const r = compareGrids(raster([1, 2, 3, 4]), raster([1, 2, 3, 4]), {
      tolerance: 0.1,
      interpolatedMask: [false, true],
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('mask-length-mismatch');
  });

  it('refuses a negative or non-finite tolerance', () => {
    for (const tolerance of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = compareGrids(raster([1, 2, 3, 4]), raster([1, 2, 3, 4]), { tolerance });
      expect(r.status).toBe('refused');
      if (r.status !== 'refused') continue;
      expect(r.reason).toBe('invalid-tolerance');
    }
  });

  it('refuses an unusable grid spec', () => {
    const bad: GridSpec = { ...SPEC, width: 0, height: 0 };
    const r = compareGrids(raster([], bad), raster([], bad), { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-grid');
  });

  it('refuses a zero-length comparison rather than reporting zeros', () => {
    const nd = -9999;
    const a = raster([nd, nd, nd, nd], SPEC, nd);
    const b = raster([1, 2, 3, 4], SPEC, nd);
    const r = compareGrids(a, b, { tolerance: 0.1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-comparable-cells');
    expect(r.detail).toContain('not reported');
  });

  it('refuses an overlap below the caller minimum', () => {
    const nd = -9999;
    const a = raster([1, nd, nd, nd], SPEC, nd);
    const b = raster([1, 2, 3, 4], SPEC, nd);
    const r = compareGrids(a, b, { tolerance: 0.1, minCells: 3 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('below-min-cells');
    expect(r.detail).toContain('3 required');
  });

  it('refuses a non-integer minCells', () => {
    const r = compareGrids(raster([1, 2, 3, 4]), raster([1, 2, 3, 4]), {
      tolerance: 0.1,
      minCells: 0,
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-min-cells');
  });
});

describe('compareGrids statistics', () => {
  // diffs 0, +0.5, -0.5, -2. mean -0.5, median -0.5, rmse sqrt(1.125),
  // mae 0.75, |e| sorted [0, 0.5, 0.5, 2], nmad 1.4826 x 0.5.
  const a = raster([1, 2, 3, 4]);
  const b = raster([1, 1.5, 3.5, 6]);

  it('reports every statistic on a hand-checked grid', () => {
    const r = compareGrids(a, b, { tolerance: 0.5 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    const v = r.value;
    expect(v.n).toBe(4);
    expect(v.meanSignedError).toBeCloseTo(-0.5, 12);
    expect(v.medianSignedError).toBeCloseTo(-0.5, 12);
    expect(v.rmse).toBeCloseTo(Math.sqrt(1.125), 12);
    expect(v.mae).toBeCloseTo(0.75, 12);
    expect(v.nmad).toBeCloseTo(1.4826 * 0.5, 12);
    expect(v.p50AbsError).toBeCloseTo(0.5, 12);
    expect(v.p90AbsError).toBeCloseTo(2, 12);
    expect(v.p95AbsError).toBeCloseTo(2, 12);
    expect(v.p99AbsError).toBeCloseTo(2, 12);
    expect(v.maxAbsError).toBeCloseTo(2, 12);
    expect(v.withinToleranceFraction).toBeCloseTo(0.75, 12);
  });

  it('accepts typed arrays', () => {
    const r = compareGrids(
      { spec: SPEC, values: new Float64Array([1, 2, 3, 4]), nodata: null },
      { spec: SPEC, values: new Float32Array([1, 2, 3, 4]), nodata: null },
      { tolerance: 0 },
    );
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.rmse).toBe(0);
    expect(r.value.withinToleranceFraction).toBe(1);
  });

  it('matches a nodata sentinel that float32 cannot hold exactly', () => {
    // -9999.9 is a real GeoTIFF sentinel and is not representable in float32:
    // a Float32 band stores it as -9999.900390625. Comparing the stored cell
    // against the float64 tag value with === leaves the sentinel in the sample.
    const nd = -9999.9;
    expect(Math.fround(nd)).not.toBe(nd);
    const spec: GridSpec = { originX: 0, originY: 0, cellSize: 1, width: 3, height: 1 };
    // Cells 0 and 1 hold equal measurements; cell 2 is nodata in A and a real 0
    // in B. Masking cell 2 leaves two cells that agree exactly, so rmse is 0 by
    // definition. Reading the sentinel as a measurement instead contributes a
    // single error of fround(9999.9), giving rmse = fround(9999.9)/sqrt(3).
    const a: Raster = { spec, values: new Float32Array([1, 2, nd]), nodata: nd };
    const b: Raster = { spec, values: new Float32Array([1, 2, 0]), nodata: nd };
    const r = compareGrids(a, b, { tolerance: 0 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(2);
    expect(r.value.rmse).toBe(0);
    expect(r.value.rmse).not.toBeCloseTo(Math.fround(9999.9) / Math.sqrt(3), 3);
    expect(r.mask.onlyB).toBe(1);
    expect(r.mask.bothValid).toBe(2);
  });

  it('leaves a float64 grid comparing against the sentinel as stated', () => {
    // The float32 rounding must not leak into a Float64Array, where the tag
    // value is held exactly and a cell equal to fround(nodata) is a measurement.
    const nd = -9999.9;
    const spec: GridSpec = { originX: 0, originY: 0, cellSize: 1, width: 3, height: 1 };
    const a: Raster = { spec, values: new Float64Array([1, 2, Math.fround(nd)]), nodata: nd };
    const b: Raster = { spec, values: new Float64Array([1, 2, Math.fround(nd)]), nodata: nd };
    const r = compareGrids(a, b, { tolerance: 0 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(3);
  });

  it('matches the sentinel in a slope gate stored as float32', () => {
    // A large positive sentinel, as float rasters written by GDAL often carry.
    // It is not float32-exact, so a === against the tag value fails and the
    // sentinel reads as a slope of 3.4e38, which clears any gate. Both cells
    // would then enter the headline statistics as steep ground.
    const nd = 3.402823466e38;
    expect(Math.fround(nd)).not.toBe(nd);
    const a = raster([100, 200, 0, 90]);
    const b = raster([101, 199, 180, 180]);
    const r = compareGridsCircular(a, b, {
      tolerance: 2,
      slopeGate: { values: new Float32Array([12, 8, nd, nd]), minSlope: 2, nodata: nd },
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(2);
    expect(r.flatExcluded).toBe(2);
    expect(r.slopeUnknownExcluded).toBe(2);
    // Cells 2 and 3 disagree by 180 and 90 degrees, which is what would have
    // polluted the headline figure.
    expect(r.flat?.maxAbsError).toBeCloseTo(180, 12);
  });

  it('reports mask agreement separately from value agreement', () => {
    const nd = -9999;
    // Cells 0 and 1 hold data on both sides and agree exactly. Cell 2 is nodata
    // on one side only, cell 3 on the other: the values agree perfectly while
    // the two grids disagree about half their cells.
    const left = raster([1, 2, 3, nd], SPEC, nd);
    const right = raster([1, 2, nd, 4], SPEC, nd);
    const r = compareGrids(left, right, { tolerance: 0 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.rmse).toBe(0);
    expect(r.value.n).toBe(2);
    expect(r.mask).toEqual({
      cells: 4,
      bothValid: 2,
      bothNodata: 0,
      onlyA: 1,
      onlyB: 1,
      agreementFraction: 0.5,
    });
  });

  it('counts a non-finite cell as nodata on either side', () => {
    const left = raster([1, Number.NaN, 3, 4]);
    const right = raster([1, 2, 3, 4]);
    const r = compareGrids(left, right, { tolerance: 0 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(3);
    expect(r.mask.onlyB).toBe(1);
  });

  it('splits covered and interpolated cells', () => {
    // cells 0,1 measured (diffs 0, 0.5); cells 2,3 interpolated (diffs -0.5, -2)
    const r = compareGrids(a, b, {
      tolerance: 0.5,
      interpolatedMask: [false, false, true, true],
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.covered?.n).toBe(2);
    expect(r.interpolated?.n).toBe(2);
    expect(r.covered?.rmse).toBeCloseTo(Math.sqrt((0 + 0.25) / 2), 12);
    expect(r.interpolated?.rmse).toBeCloseTo(Math.sqrt((0.25 + 4) / 2), 12);
    expect(r.covered?.withinToleranceFraction).toBe(1);
    expect(r.interpolated?.withinToleranceFraction).toBe(0.5);
  });

  it('accepts a Uint8Array mask', () => {
    const r = compareGrids(a, b, {
      tolerance: 0.5,
      interpolatedMask: new Uint8Array([0, 0, 1, 1]),
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.covered?.n).toBe(2);
    expect(r.interpolated?.n).toBe(2);
  });

  it('leaves an empty bucket null rather than zero', () => {
    const r = compareGrids(a, b, {
      tolerance: 0.5,
      interpolatedMask: [true, true, true, true],
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.covered?.n).toBe(0);
    expect(r.covered?.rmse).toBeNull();
    expect(r.covered?.mae).toBeNull();
    expect(r.covered?.maxAbsError).toBeNull();
    expect(r.covered?.withinToleranceFraction).toBeNull();
  });

  it('reports no split at all when no mask is supplied', () => {
    const r = compareGrids(a, b, { tolerance: 0.5 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.covered).toBeNull();
    expect(r.interpolated).toBeNull();
  });
});

describe('angular separation wraps', () => {
  it('puts 359 and 1 two degrees apart, in both orders', () => {
    expect(angularSeparationDeg(359, 1)).toBeCloseTo(2, 12);
    expect(angularSeparationDeg(1, 359)).toBeCloseTo(2, 12);
    expect(signedAngularDifferenceDeg(359, 1)).toBeCloseTo(-2, 12);
    expect(signedAngularDifferenceDeg(1, 359)).toBeCloseTo(2, 12);
  });

  it('separates the four cardinal and four intercardinal directions from north', () => {
    const expected: ReadonlyArray<readonly [number, number]> = [
      [0, 0], // N
      [45, 45], // NE
      [90, 90], // E
      [135, 135], // SE
      [180, 180], // S
      [225, 135], // SW
      [270, 90], // W
      [315, 45], // NW
      [360, 0], // N again, expressed as 360
    ];
    for (const [aspect, sep] of expected) {
      expect(angularSeparationDeg(0, aspect)).toBeCloseTo(sep, 12);
      expect(angularSeparationDeg(aspect, 0)).toBeCloseTo(sep, 12);
    }
  });

  it('separates each adjacent compass pair by 45 degrees around the whole circle', () => {
    const compass = [0, 45, 90, 135, 180, 225, 270, 315, 360];
    for (let i = 1; i < compass.length; i++) {
      expect(angularSeparationDeg(compass[i - 1], compass[i])).toBeCloseTo(45, 12);
    }
  });

  it('handles negative and out-of-range inputs', () => {
    expect(angularSeparationDeg(-10, 350)).toBeCloseTo(0, 12);
    expect(angularSeparationDeg(710, 10)).toBeCloseTo(20, 12);
  });
});

describe('compareGridsCircular', () => {
  it('wraps instead of reporting a 358 degree error', () => {
    const a = raster([359, 10, 90, 180]);
    const b = raster([1, 10, 90, 180]);
    const r = compareGridsCircular(a, b, { tolerance: 5 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.maxAbsError).toBeCloseTo(2, 12);
    expect(r.value.withinToleranceFraction).toBe(1);
  });

  it('excludes cells below the minimum slope and reports them separately', () => {
    // Cells 0 and 1 are steep and agree. Cells 2 and 3 are flat, where aspect is
    // undefined, and disagree by 180 and 90 degrees.
    const a = raster([100, 200, 0, 90]);
    const b = raster([101, 199, 180, 180]);
    const r = compareGridsCircular(a, b, {
      tolerance: 2,
      slopeGate: { values: [12, 8, 0.1, 0.2], minSlope: 2 },
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(2);
    expect(r.value.maxAbsError).toBeCloseTo(1, 12);
    expect(r.value.withinToleranceFraction).toBe(1);
    expect(r.flatExcluded).toBe(2);
    expect(r.minSlope).toBe(2);
    expect(r.flat?.n).toBe(2);
    expect(r.flat?.maxAbsError).toBeCloseTo(180, 12);
  });

  it('excludes a cell whose slope is itself nodata', () => {
    const a = raster([100, 200, 0, 90]);
    const b = raster([101, 199, 180, 180]);
    const r = compareGridsCircular(a, b, {
      tolerance: 2,
      slopeGate: { values: [12, 8, -9999, Number.NaN], minSlope: 2, nodata: -9999 },
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.n).toBe(2);
    expect(r.flatExcluded).toBe(2);
    // Both exclusions are unknown slope, not measured flat ground.
    expect(r.slopeUnknownExcluded).toBe(2);
  });

  it('separates cells measured flat from cells with no slope reading', () => {
    // Cell 2 is measured at 0.1, below the gate. Cell 3 has no slope reading.
    const a = raster([100, 200, 0, 90]);
    const b = raster([101, 199, 180, 180]);
    const r = compareGridsCircular(a, b, {
      tolerance: 2,
      slopeGate: { values: [12, 8, 0.1, -9999], minSlope: 2, nodata: -9999 },
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.flatExcluded).toBe(2);
    expect(r.slopeUnknownExcluded).toBe(1);
  });

  it('does not call an all-nodata slope raster flat ground', () => {
    // Every slope cell is a sentinel, so nothing was measured as flat. Saying
    // these cells "fell below the slope gate" asserts terrain nobody surveyed.
    const r = compareGridsCircular(raster([0, 90, 180, 270]), raster([10, 80, 190, 260]), {
      tolerance: 5,
      slopeGate: { values: [-9999, -9999, -9999, -9999], minSlope: 2, nodata: -9999 },
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-comparable-cells');
    expect(r.detail).toContain('0 below the minimum');
    expect(r.detail).toContain('4 with no slope reading');
  });

  it('reports no flat bucket when every cell clears the gate', () => {
    const r = compareGridsCircular(raster([10, 20, 30, 40]), raster([10, 20, 30, 40]), {
      tolerance: 1,
      slopeGate: { values: [10, 10, 10, 10], minSlope: 2 },
    });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.flatExcluded).toBe(0);
    expect(r.flat).toBeNull();
  });

  it('refuses when every comparable cell is flat', () => {
    const r = compareGridsCircular(raster([0, 90, 180, 270]), raster([10, 80, 190, 260]), {
      tolerance: 5,
      slopeGate: { values: [0, 0, 0, 0], minSlope: 2 },
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-comparable-cells');
    expect(r.detail).toContain('slope gate');
    // All four were measured at 0 and found flat, none had a missing reading.
    expect(r.detail).toContain('4 below the minimum');
    expect(r.detail).toContain('0 with no slope reading');
  });

  it('refuses a slope raster of the wrong length', () => {
    const r = compareGridsCircular(raster([0, 90, 180, 270]), raster([0, 90, 180, 270]), {
      tolerance: 5,
      slopeGate: { values: [1, 2], minSlope: 2 },
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('slope-count-mismatch');
  });

  it('refuses a negative minimum slope', () => {
    const r = compareGridsCircular(raster([0, 90, 180, 270]), raster([0, 90, 180, 270]), {
      tolerance: 5,
      slopeGate: { values: [1, 2, 3, 4], minSlope: -1 },
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-min-slope');
  });

  it('keeps the alignment refusals of the linear path', () => {
    const r = compareGridsCircular(raster([0, 90, 180, 270]), raster([0, 90, 180, 270], {
      ...SPEC,
      cellSize: 2,
    }), { tolerance: 5 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('grid-cell-size-differs');
  });

  it('reports a systematic rotation as a signed mean', () => {
    // Every cell rotated 10 degrees clockwise, including across the wrap.
    const a = raster([0, 90, 180, 355]);
    const b = raster([350, 80, 170, 345]);
    const r = compareGridsCircular(a, b, { tolerance: 1 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.value.meanSignedError).toBeCloseTo(10, 12);
    expect(r.value.withinToleranceFraction).toBe(0);
  });
});

describe('compareGrids compensated summation', () => {
  // Signed errors [1e16, 1, -1e16, 0]: the true sum is 1, mean 0.25. Naive
  // accumulation cancels the 1 away (1e16 + 1 rounds to 1e16) and reports
  // mean 0; the Neumaier accumulator keeps it.
  it('keeps the mean signed error where a naive running sum cancels', () => {
    const a = raster([1e16, 1, -1e16, 0]);
    const b = raster([0, 0, 0, 0]);
    const r = compareGrids(a, b, { tolerance: 2e16 });
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    // Reference: exact integer arithmetic (1e16 and 1 are exact doubles).
    expect(r.value.meanSignedError).toBeCloseTo(0.25, 12);
  });
});
