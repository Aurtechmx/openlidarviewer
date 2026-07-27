/**
 * unitIntegrity.test.ts: every reported quantity carries the unit it claims.
 *
 * WHY THIS SUITE EXISTS. One defect shape has recurred in this codebase: the
 * same physical quantity derived by two code paths, diverging because one path
 * applied a unit or axis conversion the other did not. The slope zScale for
 * foot CRS data, Y-up versus Z-up in the scan report, the streaming and
 * intelligence unit conversions, the density formatter, the export count and
 * bounds basis, the contour third ordinate, the despike floor's vertical unit.
 * All the same bug wearing different clothes. A test that exercises one path
 * cannot catch it. Only a test that runs both paths over the same physical
 * scene and compares can.
 *
 * WHAT A CASE LOOKS LIKE. Take a synthetic terrain whose true geometry is known
 * in metres. Express it a second time in a different CRS. International feet
 * horizontally, or a compound frame with metre eastings over foot heights, or a
 * Y-up axis order. Feed both through the production functions with the unit
 * factors those functions declare, and assert the physical result matches.
 * Angles and dimensionless ratios must be numerically equal. Lengths must agree
 * after the declared conversion and nothing else.
 *
 * WHY IT RUNS EVERY COMMIT. The checks are pure arithmetic over small grids and
 * finish in under a second, so they are not env-gated the way the timing suites
 * are. A unit defect is a correctness defect; it belongs in the always-on set.
 *
 * TOLERANCES. Every tolerance below is stated with the physical magnitude that
 * justifies it, and every one is derived from representation limits rather than
 * from an observed difference. The dominant term is not double-precision
 * arithmetic but Float32 storage: elevation grids are `Float32Array`, so the
 * same physical height stored in metres and in feet quantises to two different
 * floats. Float32 has a relative epsilon of 2^-24 ≈ 6e-8; over the elevation
 * range these fixtures use (tens of metres) that is a sub-micrometre absolute
 * error, and the Horn stencil divides it by the cell size rather than
 * amplifying it. Tolerances are set an order of magnitude above that bound and
 * are still far below any surveying significance. See each constant.
 *
 * NOT COVERED HERE. Anything whose unit only exists on the GPU or in the DOM.
 * See UNCOVERED at the bottom of this file for the explicit list; those are
 * named rather than checked, because a check that cannot fail is worse than an
 * admitted gap.
 */
import { describe, test, expect } from 'vitest';

import { hornSlope, hornSlopeAspect } from '../../src/terrain/ground/terrainDerivatives';
import { horizontalCellMetresXY, horizontalCellMetres } from '../../src/terrain/ground/horizontalScale';
import { slopeStats, shadeFromSlopeAspect } from '../../src/terrain/surface/hillshade';
import { findSpikes } from '../../src/terrain/ground/despike';
import { detectChange } from '../../src/terrain/change/changeDetection';
import { computeCellMetrics } from '../../src/terrain/quality/cellMetrics';
import { rasterizeDtm } from '../../src/terrain/ground/rasterizeDtm';
import { buildSurfaceFromRaster } from '../../src/terrain/ground/surfaceFromRaster';
import { contoursAt } from '../../src/terrain/contour/contoursAt';
import { classifyDensity } from '../../src/terrain/datasetIntelligence';
import { footprintMetres } from '../../src/report/reportFootprint';
import { measurementMetrics } from '../../src/export/measurementExport';
import {
  UNIT_FACTORS,
  verticalUnitLabel,
  verticalUnitSuffix,
  horizontalUnitLabel,
  toMetresIfKnown,
  knownUnit,
  unknownUnit,
  sourceUnits,
  raw,
} from '../../src/units/units';
import { linearUnitOf, linearUnitLabel } from '../../src/export/ScanReportRenderer';
import { createInspectorCardRefreshers } from '../../src/app/inspectorCardRefreshers';

// ── Pre-registered tolerances ────────────────────────────────────────────────
// Written before any comparison was run. Each states the physical magnitude
// that justifies it; none was widened after seeing a result.

/**
 * Dimensionless slope tangent, compared between a metre grid and the same
 * terrain stored as a foot grid. Both are `Float32Array`, so the same height
 * quantises differently in the two units: relative eps 2^-24 ≈ 6e-8 over a
 * ~40 m elevation range is ~2.4e-6 m of storage error, and the Horn stencil
 * divides that by the cell size (1 m here) rather than amplifying it. 1e-5 on
 * the tangent is four times that bound and corresponds to 6e-4 degrees of
 * slope, three orders below the ~0.1° at which a slope map is read.
 */
const SLOPE_TANGENT_TOL = 1e-5;

/**
 * Slope reported in degrees. atan is contractive for the tangents these
 * fixtures produce, so the degree error is bounded by
 * SLOPE_TANGENT_TOL * 180/pi ≈ 5.7e-4. Rounded up to 1e-3 degrees, which is
 * 3.6 arc-seconds, below the angular resolution any terrain product claims.
 */
const SLOPE_DEGREE_TOL = 1e-3;

/**
 * A length already converted to metres, compared between two source units.
 * Doubles carry ~1e-16 relative error and the conversion is a single multiply
 * by an exact factor (0.3048 is exact in decimal but not in binary, costing one
 * rounding). Over the ~100 m extents here that is ~1e-14 m. 1e-9 m is a
 * nanometre, five orders below the millimetre at which any survey instrument
 * reports, and still six orders above the arithmetic bound.
 */
const LENGTH_METRES_TOL = 1e-9;

/**
 * Areal density in points per square metre, compared across source units. The
 * quantity is a count divided by a converted area, so it inherits the length
 * tolerance squared in relative terms. Expressed as a relative tolerance
 * because densities here span 0.1 to 1e4 pts/m². 1e-9 relative is far below the
 * one-part-in-a-hundred at which a density is banded into a Quality Level.
 */
const DENSITY_RELATIVE_TOL = 1e-9;

/**
 * A volume in cubic metres, compared across source units. Three multiplies by
 * the conversion factor rather than one, so three roundings; still ~1e-15
 * relative. Expressed as relative, at 1e-9, nine orders below the few-percent
 * uncertainty a stockpile volume is actually quoted with.
 */
const VOLUME_RELATIVE_TOL = 1e-9;

/**
 * A volume in cubic metres whose elevations travelled through a `Float32Array`
 * grid, which is the case for every raster-derived volume. Float32 dominates,
 * and the difference of two nearly equal stored heights amplifies it: heights
 * near 33 (feet) carry ~2e-6 of storage error each, and the change being
 * integrated is ~4.9 units, so the relative error on the difference is
 * ~8e-7. Set at 1e-5 relative, an order above that bound, and a hundredth of
 * one percent on a volume, against the few percent such a figure is quoted
 * with.
 *
 * The separate constant exists because VOLUME_RELATIVE_TOL above states a
 * double-arithmetic bound, which does not apply once a value is stored as
 * Float32. The bbox-volume checks stay on the tighter one.
 */
const VOLUME_FLOAT32_RELATIVE_TOL = 1e-5;

const M_PER_FT = UNIT_FACTORS.M_PER_FT;
const M_PER_US_FT = UNIT_FACTORS.M_PER_US_FT;

// ── Synthetic terrain, defined in metres ─────────────────────────────────────

/**
 * The reference surface. A tilted plane carrying a smooth Gaussian rise, so the
 * scene has both a constant regional gradient and a locally varying one. A
 * plane alone would let an axis error hide, because its slope is the same in
 * every direction.
 *
 * Coordinates and the return are metres. Every fixture below derives its other
 * unit expressions from this one function, so the two CRS variants describe the
 * SAME physical ground rather than two independently written grids.
 */
function surfaceMetres(xM: number, yM: number): number {
  return 0.15 * xM + 0.05 * yM + 6 * Math.exp(-((xM - 20) ** 2 + (yM - 25) ** 2) / 60);
}

const GRID_N = 48;
const CELL_M = 1;

/**
 * Sample the reference surface onto a regular grid, expressing the elevation in
 * a chosen vertical unit. `verticalMetresPerUnit` is the CRS's own factor: pass
 * 1 for a metre grid, 0.3048 for a grid whose heights are stored in feet.
 */
function elevationGrid(verticalMetresPerUnit: number): Float32Array {
  const z = new Float32Array(GRID_N * GRID_N);
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      z[r * GRID_N + c] = surfaceMetres(c * CELL_M, r * CELL_M) / verticalMetresPerUnit;
    }
  }
  return z;
}

/** Sample the reference surface as a point list in a chosen source unit. */
function pointsInUnit(horizontalMetresPerUnit: number, verticalMetresPerUnit: number) {
  const pts: { x: number; y: number; z: number }[] = [];
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const xM = c * CELL_M;
      const yM = r * CELL_M;
      pts.push({
        x: xM / horizontalMetresPerUnit,
        y: yM / horizontalMetresPerUnit,
        z: surfaceMetres(xM, yM) / verticalMetresPerUnit,
      });
    }
  }
  return pts;
}

const FULL_COVERAGE = new Uint8Array(GRID_N * GRID_N).fill(1);

/** Largest absolute difference between two same-length numeric grids. */
function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] as number) - (b[i] as number));
    if (d > worst) worst = d;
  }
  return worst;
}

/** Largest relative difference, for quantities whose scale varies by fixture. */
function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('unit integrity: horizontal-unit invariance', () => {
  /**
   * Slope is a ratio of two lengths, so it is dimensionless: the same hillside
   * measured in a metre CRS and a foot CRS must produce the SAME number, not a
   * number that needs converting. This is the check the foot-CRS zScale defect
   * would have failed.
   */
  test('Horn slope tangent is identical in a metre CRS and a foot CRS', () => {
    const metreSlope = hornSlope(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);

    // The same ground in international feet: cell size and heights both grow by
    // 1/0.3048, and both unit factors are declared to the production helpers.
    const cellFt = CELL_M / M_PER_FT;
    const cellMetres = horizontalCellMetresXY(cellFt, false, 0, M_PER_FT);
    const footSlope = hornSlope(
      elevationGrid(M_PER_FT),
      GRID_N,
      GRID_N,
      cellMetres.x,
      cellMetres.y,
      M_PER_FT,
    );

    expect(maxAbsDiff(metreSlope, footSlope)).toBeLessThan(SLOPE_TANGENT_TOL);
  });

  /** The same invariance, on the US survey foot's 2 ppm-different factor. */
  test('Horn slope tangent is identical in a US-survey-foot CRS', () => {
    const metreSlope = hornSlope(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const cellUsFt = CELL_M / M_PER_US_FT;
    const cellMetres = horizontalCellMetresXY(cellUsFt, false, 0, M_PER_US_FT);
    const usSlope = hornSlope(
      elevationGrid(M_PER_US_FT),
      GRID_N,
      GRID_N,
      cellMetres.x,
      cellMetres.y,
      M_PER_US_FT,
    );
    expect(maxAbsDiff(metreSlope, usSlope)).toBeLessThan(SLOPE_TANGENT_TOL);
  });

  /**
   * Aspect is a compass direction, so a dimensionless angle. A unit change must
   * not rotate it at all.
   */
  test('aspect is unchanged by the horizontal unit', () => {
    const m = hornSlopeAspect(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const cellMetres = horizontalCellMetresXY(CELL_M / M_PER_FT, false, 0, M_PER_FT);
    const f = hornSlopeAspect(
      elevationGrid(M_PER_FT),
      GRID_N,
      GRID_N,
      cellMetres.x,
      cellMetres.y,
      M_PER_FT,
    );
    // Aspect is periodic; compare the unit vector rather than the raw radian so
    // a wrap at ±pi is not read as a 2pi-sized disagreement.
    let worst = 0;
    for (let i = 0; i < m.aspect.length; i++) {
      const d = Math.hypot(
        Math.cos(m.aspect[i] as number) - Math.cos(f.aspect[i] as number),
        Math.sin(m.aspect[i] as number) - Math.sin(f.aspect[i] as number),
      );
      if (d > worst) worst = d;
    }
    expect(worst).toBeLessThan(SLOPE_TANGENT_TOL);
  });

  /**
   * Slope statistics are what the report prints. Deriving them from the two
   * unit expressions must agree in degrees, not merely in the raw tangent grid.
   */
  test('reported slope statistics agree in degrees across horizontal units', () => {
    const toDeg = (t: Float32Array): Float32Array => {
      const d = new Float32Array(t.length);
      for (let i = 0; i < t.length; i++) d[i] = (Math.atan(t[i] as number) * 180) / Math.PI;
      return d;
    };
    const m = slopeStats(
      toDeg(hornSlope(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1)),
      FULL_COVERAGE,
    );
    const cellMetres = horizontalCellMetresXY(CELL_M / M_PER_FT, false, 0, M_PER_FT);
    const f = slopeStats(
      toDeg(
        hornSlope(elevationGrid(M_PER_FT), GRID_N, GRID_N, cellMetres.x, cellMetres.y, M_PER_FT),
      ),
      FULL_COVERAGE,
    );
    expect(Math.abs(m.meanDeg - f.meanDeg)).toBeLessThan(SLOPE_DEGREE_TOL);
    expect(Math.abs(m.maxDeg - f.maxDeg)).toBeLessThan(SLOPE_DEGREE_TOL);
    expect(Math.abs(m.p95Deg - f.p95Deg)).toBeLessThan(SLOPE_DEGREE_TOL);
  });

  /**
   * Cell size in metres is a length: the foot expression must convert to the
   * metre expression exactly, and a geographic frame must not silently reuse
   * the projected branch.
   */
  test('horizontal cell size converts to the same metres from either unit', () => {
    expect(Math.abs(horizontalCellMetres(CELL_M, false, 1) - CELL_M)).toBeLessThan(
      LENGTH_METRES_TOL,
    );
    expect(
      Math.abs(horizontalCellMetres(CELL_M / M_PER_FT, false, M_PER_FT) - CELL_M),
    ).toBeLessThan(LENGTH_METRES_TOL);
    expect(
      Math.abs(horizontalCellMetres(CELL_M / M_PER_US_FT, false, M_PER_US_FT) - CELL_M),
    ).toBeLessThan(LENGTH_METRES_TOL);
  });

  /**
   * Ground density is points per square METRE. A foot grid holds the same
   * points over the same ground, so the density must be the same number. The
   * area conversion is the square of the linear one, and getting that wrong is
   * a 10.76x error that still looks like a plausible density.
   */
  test('per-cell ground density is the same pts/m² in a metre and a foot CRS', () => {
    const raster = rasterizeDtm(pointsInUnit(1, 1), new Uint8Array(GRID_N * GRID_N).fill(1), {
      cellSizeM: 2,
      aggregation: 'mean',
    });
    const metreGrid = buildSurfaceFromRaster(raster, {
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
    }).dtm;

    const footRaster = rasterizeDtm(
      pointsInUnit(M_PER_FT, M_PER_FT),
      new Uint8Array(GRID_N * GRID_N).fill(1),
      { cellSizeM: 2 / M_PER_FT, aggregation: 'mean' },
    );
    const footGrid = buildSurfaceFromRaster(footRaster, {
      horizontalUnitToMetres: M_PER_FT,
      verticalUnitToMetres: M_PER_FT,
    }).dtm;

    const m = computeCellMetrics(metreGrid, { horizontalUnitToMetres: 1 }).summary;
    const f = computeCellMetrics(footGrid, { horizontalUnitToMetres: M_PER_FT }).summary;

    expect(m.measuredCellCount).toBe(f.measuredCellCount);
    expect(relDiff(m.meanDensity, f.meanDensity)).toBeLessThan(DENSITY_RELATIVE_TOL);
    expect(relDiff(m.medianDensity, f.medianDensity)).toBeLessThan(DENSITY_RELATIVE_TOL);
  });

  /**
   * Cut/fill volumes from a two-epoch comparison are reported in cubic metres.
   * The same physical change measured in a foot grid must give the same m³.
   */
  test('change-detection volumes agree in m³ across horizontal units', () => {
    const flat = (v: number, unit: number): Float32Array => {
      const g = new Float32Array(GRID_N * GRID_N);
      g.fill(v / unit);
      return g;
    };
    const metre = detectChange(
      { width: GRID_N, height: GRID_N, cellSizeM: CELL_M, values: flat(10, 1) },
      { width: GRID_N, height: GRID_N, cellSizeM: CELL_M, values: flat(11.5, 1) },
      { horizontalUnitToMetres: 1, verticalUnitToMetres: 1, levelOfDetectionM: 0.1 },
    );
    const foot = detectChange(
      {
        width: GRID_N,
        height: GRID_N,
        cellSizeM: CELL_M / M_PER_FT,
        values: flat(10, M_PER_FT),
      },
      {
        width: GRID_N,
        height: GRID_N,
        cellSizeM: CELL_M / M_PER_FT,
        values: flat(11.5, M_PER_FT),
      },
      { horizontalUnitToMetres: M_PER_FT, verticalUnitToMetres: M_PER_FT, levelOfDetectionM: 0.1 },
    );
    expect(relDiff(metre.stats.gainVolumeM3, foot.stats.gainVolumeM3)).toBeLessThan(
      VOLUME_FLOAT32_RELATIVE_TOL,
    );
    expect(metre.stats.gainVolumeM3).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('unit integrity: vertical-unit independence', () => {
  /**
   * The classic compound-CRS case: metre eastings and northings over foot
   * heights. Slope must come out the same as the all-metre expression, which
   * only happens if the vertical factor is applied where z enters the gradient
   * and the horizontal factor is not applied to it.
   */
  test('slope is correct for metre horizontal over foot vertical', () => {
    const allMetres = hornSlope(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const compound = hornSlope(
      elevationGrid(M_PER_FT), // heights in feet
      GRID_N,
      GRID_N,
      CELL_M, // eastings/northings already metres
      CELL_M,
      M_PER_FT, // vertical factor only
    );
    expect(maxAbsDiff(allMetres, compound)).toBeLessThan(SLOPE_TANGENT_TOL);
  });

  /**
   * The negative control for the check above. Omitting the vertical factor on a
   * foot-height grid must NOT accidentally agree. If it did, the test above
   * would be passing vacuously and could not detect a regression.
   */
  test('omitting the vertical factor on a foot-height grid changes the slope', () => {
    const allMetres = hornSlope(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const unconverted = hornSlope(elevationGrid(M_PER_FT), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    // 1/0.3048 = 3.28x steeper. Assert it is grossly different, not merely
    // outside the tolerance, so this control cannot pass by a rounding accident.
    expect(maxAbsDiff(allMetres, unconverted)).toBeGreaterThan(0.1);
  });

  /**
   * The despike floor is declared in METRES (`minDeviationM`). A deviation of
   * 0.1 foot is 0.0305 m and sits below the 0.05 m floor, so a foot-height grid
   * must NOT flag it, while the same numeric deviation on a metre grid must.
   */
  test('the despike floor is honoured in metres, not in source vertical units', () => {
    const n = 11;
    const had = new Uint8Array(n * n).fill(1);
    const centre = Math.floor((n * n) / 2);

    const footZ = new Float32Array(n * n).fill(10);
    footZ[centre] = 10.1; // 0.1 ft = 0.0305 m, below the 0.05 m floor
    const flaggedAsFeet = findSpikes(footZ, had, n, n, {
      verticalUnitToMetres: M_PER_FT,
      minDeviationM: 0.05,
      madThreshold: 0,
    });
    expect(flaggedAsFeet[centre]).toBe(0);

    const metreZ = new Float32Array(n * n).fill(10);
    metreZ[centre] = 10.1; // 0.1 m, above the 0.05 m floor
    const flaggedAsMetres = findSpikes(metreZ, had, n, n, {
      verticalUnitToMetres: 1,
      minDeviationM: 0.05,
      madThreshold: 0,
    });
    expect(flaggedAsMetres[centre]).toBe(1);
  });

  /**
   * Level of detection in change detection is declared in metres. The same
   * physical 0.03 m change must be rejected under a 0.1 m LoD whichever
   * vertical unit the grids are stored in.
   */
  test('level of detection is applied in metres regardless of the grid vertical unit', () => {
    const g = (v: number, unit: number) => ({
      width: 8,
      height: 8,
      cellSizeM: 1,
      values: new Float32Array(64).fill(v / unit),
    });
    const feet = detectChange(g(10, M_PER_FT), g(10.03, M_PER_FT), {
      verticalUnitToMetres: M_PER_FT,
      horizontalUnitToMetres: 1,
      levelOfDetectionM: 0.1,
    });
    const metres = detectChange(g(10, 1), g(10.03, 1), {
      verticalUnitToMetres: 1,
      horizontalUnitToMetres: 1,
      levelOfDetectionM: 0.1,
    });
    expect(feet.stats.gainVolumeM3).toBe(0);
    expect(metres.stats.gainVolumeM3).toBe(0);
  });

  /**
   * Hillshade consumes an already-scaled slope tangent, so a compound-CRS
   * surface whose slope carried the vertical factor must shade to the same
   * bytes as the all-metre one.
   *
   * The second half records a property that is easy to assume away. Hillshade
   * multiplies the incoming tangent by `zFactor` before the atan, and
   * `hornSlopeAspect` multiplies the same tangent by `zScale`. The two knobs
   * are therefore numerically interchangeable: scaling z at the derivative and
   * exaggerating at the shade produce byte-identical output. Nothing downstream
   * can tell a vertical-unit correction from a cosmetic exaggeration, so the
   * distinction lives entirely in which argument the caller reaches for. Pinned
   * here so the interchangeability is a stated property rather than a surprise.
   */
  test('hillshade matches across vertical units, and zFactor is interchangeable with zScale', () => {
    const metre = hornSlopeAspect(elevationGrid(1), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const compound = hornSlopeAspect(
      elevationGrid(M_PER_FT),
      GRID_N,
      GRID_N,
      CELL_M,
      CELL_M,
      M_PER_FT,
    );
    const shadeM = shadeFromSlopeAspect(
      metre.slope,
      metre.aspect,
      FULL_COVERAGE,
      GRID_N,
      GRID_N,
      {},
    );
    const shadeC = shadeFromSlopeAspect(
      compound.slope,
      compound.aspect,
      FULL_COVERAGE,
      GRID_N,
      GRID_N,
      {},
    );
    // Shade is a 0-255 byte; correct scaling must land on the same byte.
    expect(maxAbsDiff(shadeM.shade, shadeC.shade)).toBe(0);

    // Applying the vertical factor at the shade instead of at the derivative
    // reaches the same bytes, because the two arguments are the same multiply.
    const unscaled = hornSlopeAspect(elevationGrid(M_PER_FT), GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const shadeViaZFactor = shadeFromSlopeAspect(
      unscaled.slope,
      unscaled.aspect,
      FULL_COVERAGE,
      GRID_N,
      GRID_N,
      { zFactor: M_PER_FT },
    );
    expect(maxAbsDiff(shadeM.shade, shadeViaZFactor.shade)).toBe(0);

    // The real negative control: leaving the foot-height slope unscaled at both
    // seams shades differently, so the agreement above is not vacuous.
    const shadeUnscaled = shadeFromSlopeAspect(
      unscaled.slope,
      unscaled.aspect,
      FULL_COVERAGE,
      GRID_N,
      GRID_N,
      {},
    );
    expect(maxAbsDiff(shadeM.shade, shadeUnscaled.shade)).toBeGreaterThan(10);
  });

  /**
   * Contours are cut on the DTM's native Z. The interval is therefore in the
   * grid's own vertical unit, and a metre interval on a foot grid produces a
   * different set of lines. This pins the contract so the interval's unit is
   * never assumed to be metres by a caller.
   */
  test('contour levels are in the grid vertical unit, and the metre equivalent differs', () => {
    const dtm = (unit: number) => ({
      z: elevationGrid(unit),
      cols: GRID_N,
      rows: GRID_N,
      cellSizeM: CELL_M,
      originH1: 0,
      originH2: 0,
      coverage: FULL_COVERAGE,
      confidence: new Float32Array(GRID_N * GRID_N).fill(100),
      counts: new Uint32Array(GRID_N * GRID_N).fill(1),
      interpDistanceCells: new Float32Array(GRID_N * GRID_N),
      crs: null,
      verticalDatum: null,
    });
    const metreLines = contoursAt(dtm(1) as never, { intervalM: 1 });
    const footLines = contoursAt(dtm(M_PER_FT) as never, { intervalM: 1 });
    // Same ground, same numeric interval, different unit: a 1 ft interval cuts
    // ~3.28x as many lines as a 1 m one.
    expect(footLines.levels.length).toBeGreaterThan(metreLines.levels.length * 3);

    // A 1 m physical interval on the foot grid is 1/0.3048 grid units, and then
    // the two agree on the number of lines.
    const footAtMetreInterval = contoursAt(dtm(M_PER_FT) as never, { intervalM: 1 / M_PER_FT });
    expect(Math.abs(footAtMetreInterval.levels.length - metreLines.levels.length)).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('unit integrity: axis convention', () => {
  /**
   * A Y-up cloud (PLY, OBJ, glTF) stores height in Y and ground depth in Z.
   * Reading the extents as if they were Z-up puts the building height into
   * "Depth" and computes density over a vertical cross-section. The reported
   * footprint must be the same physical footprint whichever axis order the
   * source uses.
   *
   * The reference is the axis-aware arithmetic the on-screen Scan Report
   * performs (src/analysis/modules/scanReport.ts): width = X, depth = the
   * non-vertical remaining axis, height = the vertical axis scaled by the
   * VERTICAL unit factor.
   */
  const Y_UP_EXTENTS = { x: 30, y: 8, z: 40 }; // 30 x 40 m footprint, 8 m tall
  const POINTS = 120_000;

  test('report footprint is the same for a Y-up and a Z-up cloud of the same building', () => {
    const zUp = footprintMetres({
      extentX: Y_UP_EXTENTS.x,
      extentY: Y_UP_EXTENTS.z, // depth
      extentZ: Y_UP_EXTENTS.y, // height
      pointCount: POINTS,
      linearUnitToMetres: 1,
      verticalUnitToMetres: 1,
      zUp: true,
    });
    const yUp = footprintMetres({
      extentX: Y_UP_EXTENTS.x,
      extentY: Y_UP_EXTENTS.y,
      extentZ: Y_UP_EXTENTS.z,
      pointCount: POINTS,
      linearUnitToMetres: 1,
      verticalUnitToMetres: 1,
      zUp: false,
    });
    expect(Math.abs(yUp.width - zUp.width)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs(yUp.depth - zUp.depth)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs(yUp.height - zUp.height)).toBeLessThan(LENGTH_METRES_TOL);
    expect(relDiff(yUp.density, zUp.density)).toBeLessThan(DENSITY_RELATIVE_TOL);
  });

  /**
   * The vertical unit factor must land on the vertical axis, whichever axis
   * that is. On a Y-up cloud in a compound frame, applying it to Z scales the
   * ground depth and leaves the height in feet. Both are wrong, and the density is
   * wrong with them.
   */
  test('the vertical unit factor follows the up axis, not the Z slot', () => {
    const yUp = footprintMetres({
      extentX: Y_UP_EXTENTS.x,
      extentY: Y_UP_EXTENTS.y, // height, in feet
      extentZ: Y_UP_EXTENTS.z, // depth, in metres
      pointCount: POINTS,
      linearUnitToMetres: 1,
      verticalUnitToMetres: M_PER_FT,
      zUp: false,
    });
    expect(Math.abs(yUp.height - Y_UP_EXTENTS.y * M_PER_FT)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs(yUp.depth - Y_UP_EXTENTS.z)).toBeLessThan(LENGTH_METRES_TOL);
    expect(relDiff(yUp.density, POINTS / (Y_UP_EXTENTS.x * Y_UP_EXTENTS.z))).toBeLessThan(
      DENSITY_RELATIVE_TOL,
    );
  });

  /**
   * A Z-up source must be byte-identical to the historical behaviour, so the axis
   * awareness above must not have moved the common case.
   */
  test('a Z-up cloud is unaffected by the axis handling', () => {
    const f = footprintMetres({
      extentX: 30,
      extentY: 40,
      extentZ: 8,
      pointCount: POINTS,
      linearUnitToMetres: M_PER_FT,
      verticalUnitToMetres: M_PER_FT,
      zUp: true,
    });
    expect(Math.abs(f.width - 30 * M_PER_FT)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs(f.depth - 40 * M_PER_FT)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs(f.height - 8 * M_PER_FT)).toBeLessThan(LENGTH_METRES_TOL);
  });

  /**
   * Grid derivatives must not care which horizontal axis is rows and which is
   * columns: transposing the grid transposes the slope and leaves every slope
   * VALUE in place. A cell-size mix-up between the two axes shows up here.
   */
  test('transposing the grid transposes the slope without changing any value', () => {
    const z = elevationGrid(1);
    const t = new Float32Array(z.length);
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++) t[c * GRID_N + r] = z[r * GRID_N + c] as number;

    const direct = hornSlope(z, GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const transposed = hornSlope(t, GRID_N, GRID_N, CELL_M, CELL_M, 1);
    const untransposed = new Float32Array(direct.length);
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++)
        untransposed[r * GRID_N + c] = transposed[c * GRID_N + r] as number;
    expect(maxAbsDiff(direct, untransposed)).toBeLessThan(SLOPE_TANGENT_TOL);
  });

  /**
   * Anisotropic cells: an EW cell size that differs from the NS one must be
   * used on the matching axis. Swapping the two arguments changes the slope of
   * any cell whose gradient is not diagonal, which pins the argument order.
   */
  test('the two cell-size arguments are bound to their own axes', () => {
    const z = elevationGrid(1);
    const a = hornSlope(z, GRID_N, GRID_N, 0.5, 2, 1);
    const b = hornSlope(z, GRID_N, GRID_N, 2, 0.5, 1);
    expect(maxAbsDiff(a, b)).toBeGreaterThan(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('unit integrity: cross-path agreement', () => {
  /**
   * Volumetric density feeds the dataset-intelligence tier, and the tier is
   * bucketed against thresholds in points per CUBIC METRE. A foot-CRS bounding
   * box is numerically 35.31x larger than the same ground in metres, so an
   * unconverted volume drops a genuine survey a whole tier or more.
   *
   * The two paths are the static-cloud refresher and the streaming-cloud
   * refresher: the same tier, from the same physical box, computed twice.
   */
  test('the density tier is the same for a metre and a foot bounding box', () => {
    const spanM = { x: 100, y: 100, z: 20 };
    const points = 5_000_000;

    const metreVolume = spanM.x * spanM.y * spanM.z;
    const footVolume =
      (spanM.x / M_PER_FT) * (spanM.y / M_PER_FT) * (spanM.z / M_PER_FT) *
      M_PER_FT * M_PER_FT * M_PER_FT;

    expect(relDiff(metreVolume, footVolume)).toBeLessThan(VOLUME_RELATIVE_TOL);
    expect(classifyDensity({ pointCount: points, bboxVolume: footVolume })).toBe(
      classifyDensity({ pointCount: points, bboxVolume: metreVolume }),
    );
  });

  /**
   * The same tier, computed by the two refreshers that actually build it: one
   * from a static cloud's bounds, one from a streaming cloud's header. Both
   * describe the same physical box in the same foot CRS, so both must reach the
   * same bucket. This is the cross-path form of the check above. The pure
   * classifier agreeing proves nothing if one caller feeds it raw feet.
   */
  test('the static and streaming refreshers agree on the density tier for one foot-CRS box', () => {
    const crs = { linearUnitToMetres: M_PER_FT, verticalUnitToMetres: M_PER_FT };
    // A 100 x 100 x 20 m box, expressed in feet.
    const minFt: [number, number, number] = [0, 0, 0];
    const maxFt: [number, number, number] = [100 / M_PER_FT, 100 / M_PER_FT, 20 / M_PER_FT];
    const points = 5_000_000;

    const seen: unknown[] = [];
    const inspector = {
      setDatasetIntelligence: (s: unknown) => seen.push(s),
      clearDatasetIntelligence: () => {},
    };
    const cards = createInspectorCardRefreshers(inspector as never);

    cards.refreshDatasetIntelligenceFromStaticCloud({
      pointCount: points,
      metadata: { crs },
      bounds: () => ({ min: minFt, max: maxFt }),
    });
    cards.refreshDatasetIntelligenceFromStreamingCloud({
      sourcePointCount: points,
      metadata: { header: { min: minFt, max: maxFt } },
      crs: () => crs,
    });

    expect(seen).toHaveLength(2);
    const tier = (s: unknown): string =>
      classifyDensity(s as { pointCount?: number; bboxVolume?: number });
    expect(tier(seen[1])).toBe(tier(seen[0]));
    // And both must be the tier the physical box actually warrants.
    expect(tier(seen[0])).toBe(classifyDensity({ pointCount: points, bboxVolume: 100 * 100 * 20 }));
  });

  /**
   * The negative control: an unconverted foot volume must land in a different
   * bucket, so the check above is not passing because the thresholds happen to
   * be wide enough to absorb the error.
   */
  test('an unconverted foot bounding box lands in a different density tier', () => {
    const points = 5_000_000;
    const metreVolume = 100 * 100 * 20;
    const rawFootVolume = (100 / M_PER_FT) * (100 / M_PER_FT) * (20 / M_PER_FT);
    expect(classifyDensity({ pointCount: points, bboxVolume: rawFootVolume })).not.toBe(
      classifyDensity({ pointCount: points, bboxVolume: metreVolume }),
    );
  });

  /**
   * The measurement export scales a volume by linear² x vertical, so a compound
   * CRS does not scale height by the horizontal factor. Pinned against the
   * hand-computed physical answer rather than against another code path, so the
   * two cannot drift together.
   */
  test('exported box volume uses linear² x vertical, not linear³', () => {
    const metrics = measurementMetrics(
      { kind: 'box', points: [[0, 0, 0], [10, 20, 5]] } as never,
      [0, 0, 1],
      1, // metre eastings
      M_PER_FT, // foot heights
    );
    expect(Math.abs((metrics.width_m as number) - 10)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs((metrics.depth_m as number) - 20)).toBeLessThan(LENGTH_METRES_TOL);
    expect(Math.abs((metrics.height_m as number) - 5 * M_PER_FT)).toBeLessThan(LENGTH_METRES_TOL);
    // The export rounds to 3 dp, so compare against the same rounding.
    const expected = Number((10 * 20 * 5 * M_PER_FT).toFixed(3));
    expect(Math.abs((metrics.volume_m3 as number) - expected)).toBeLessThan(1e-6);
  });

  /**
   * A single-unit CRS is the case where linear³ and linear² x vertical coincide.
   * Pinning it documents that the divergence above is specific to compound
   * frames, and guards the common path from a regression in either direction.
   */
  test('a single-unit CRS gives the same volume by either scaling rule', () => {
    const metrics = measurementMetrics(
      { kind: 'box', points: [[0, 0, 0], [10, 20, 5]] } as never,
      [0, 0, 1],
      M_PER_FT,
    );
    const linearCubed = Number((10 * 20 * 5 * M_PER_FT ** 3).toFixed(3));
    expect(Math.abs((metrics.volume_m3 as number) - linearCubed)).toBeLessThan(1e-6);
  });

  /**
   * A length that survives a round trip through the branded-unit boundary must
   * come back to the same metres. This is the seam every measurement crosses.
   */
  test('the source-unit to metres boundary round-trips exactly', () => {
    for (const factor of [1, M_PER_FT, M_PER_US_FT]) {
      const nativeLength = 137.25 / factor;
      const back = toMetresIfKnown(sourceUnits(nativeLength), knownUnit(factor));
      expect(back).not.toBeNull();
      expect(Math.abs(raw(back!) - 137.25)).toBeLessThan(LENGTH_METRES_TOL);
    }
  });

  /**
   * The 2 ppm gap between the international and US survey foot must survive the
   * conversion rather than being flattened by a shared constant. Over a 10 km
   * traverse it is 2 cm: small, but real, and a silent collapse to one factor
   * would be undetectable at any single point.
   */
  test('the international and US survey foot stay distinguishable', () => {
    const tenKmInFeet = 10_000 / M_PER_FT;
    const asIntl = tenKmInFeet * M_PER_FT;
    const asUs = tenKmInFeet * M_PER_US_FT;
    expect(Math.abs(asUs - asIntl)).toBeGreaterThan(0.01); // > 1 cm over 10 km
    expect(Math.abs(asUs - asIntl)).toBeLessThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('unit integrity: declared-unit contract', () => {
  /**
   * A unit label must describe the value's actual basis. An unknown scale is
   * the dangerous case: labelling it as metres asserts a conversion nobody
   * performed.
   */
  test('an unknown vertical scale is never labelled metres', () => {
    expect(verticalUnitSuffix(null)).toBe(' (vertical unit unverified)');
    expect(verticalUnitSuffix(undefined)).toBe(' (vertical unit unverified)');
    expect(verticalUnitSuffix(0)).toBe(' (vertical unit unverified)');
    expect(verticalUnitSuffix(Number.NaN)).toBe(' (vertical unit unverified)');
    expect(verticalUnitSuffix(1)).toBe(' m');
    expect(verticalUnitSuffix(M_PER_FT)).toBe(' ft');
    expect(verticalUnitSuffix(M_PER_US_FT)).toBe(' ft');
  });

  /** The label must track the factor, so a foot value can never read "m". */
  test('the vertical unit label tracks the metres-per-unit factor', () => {
    expect(verticalUnitLabel(1)).toBe('m');
    expect(verticalUnitLabel(M_PER_FT)).toBe('ft');
    expect(verticalUnitLabel(M_PER_US_FT)).toBe('ft');
    expect(verticalUnitLabel(0.9144)).toBe('units'); // a yard is neither
  });

  /**
   * The horizontal label has a different documented policy: a geographic frame
   * reads degrees, a foot CRS reads ft, and an unresolved frame keeps the
   * standing metre default. Pinned so the two policies stay deliberate rather
   * than drifting into each other.
   */
  test('the horizontal unit label distinguishes geographic, foot and default frames', () => {
    expect(horizontalUnitLabel({ isGeographic: true })).toBe('degrees');
    expect(horizontalUnitLabel({ linearUnit: 'foot' })).toBe('ft');
    expect(horizontalUnitLabel({ linearUnit: 'us-survey-foot' })).toBe('ft');
    expect(horizontalUnitLabel({ linearUnit: 'metre' })).toBe('m');
    expect(horizontalUnitLabel({})).toBe('m');
  });

  /**
   * The scan-report renderer's label family follows the same rule as
   * `verticalUnitSuffix`: an unresolved unit is reported as unresolved, not as
   * metres. Pinned so the two cannot drift back apart.
   */
  test('the scan-report renderer reports an unknown linear unit as unresolved', () => {
    expect(linearUnitOf(undefined)).toBe('unknown');
    expect(linearUnitOf(null)).toBe('unknown');
    expect(linearUnitOf('foot')).toBe('foot');
    expect(linearUnitOf('US survey foot')).toBe('foot');
    expect(linearUnitOf('metre')).toBe('metre');
    expect(linearUnitLabel('unknown')).toBe('units');
    expect(linearUnitLabel('unknown')).not.toBe('m');
    expect(linearUnitLabel('metre')).toBe('m');
    expect(linearUnitLabel('foot')).toBe('ft');
    // Both families refuse to assert metres for an unresolved unit.
    expect(verticalUnitSuffix(null)).not.toBe(' m');
  });

  /**
   * An unknown scale must not be convertible at all. The discriminated union is
   * the type-level guard, and this pins its runtime half.
   */
  test('an unknown linear scale yields no metre value', () => {
    expect(toMetresIfKnown(sourceUnits(100), unknownUnit())).toBeNull();
    expect(raw(toMetresIfKnown(sourceUnits(100), knownUnit(M_PER_FT))!)).toBeCloseTo(30.48, 10);
  });

  /** A scale that cannot be a real conversion factor must be refused, not used. */
  test('a non-physical unit scale is refused at construction', () => {
    expect(() => knownUnit(0)).toThrow(RangeError);
    expect(() => knownUnit(-1)).toThrow(RangeError);
    expect(() => knownUnit(Number.NaN)).toThrow(RangeError);
    expect(() => knownUnit(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  /**
   * The exact factors are the foundation every check above rests on. Pinned
   * against their definitions so a "simplification" to a rounded constant is a
   * test failure rather than a 2 ppm drift nobody notices.
   */
  test('the conversion factors are the exact defined values', () => {
    expect(UNIT_FACTORS.M_PER_FT).toBe(0.3048);
    expect(UNIT_FACTORS.M_PER_US_FT).toBe(1200 / 3937);
    expect(UNIT_FACTORS.DEG_PER_RAD).toBe(180 / Math.PI);
    expect(UNIT_FACTORS.M_PER_FT).not.toBe(UNIT_FACTORS.M_PER_US_FT);
  });
});

/**
 * UNCOVERED. Quantities whose unit cannot be checked from Node.
 *
 * Named rather than tested, because a check that runs in an environment where
 * the quantity does not exist would pass without evidence.
 *
 *  - GPU terrain derivatives (src/terrain/engine/gpuBackend.ts). The WebGPU
 *    backend takes the same cell-metres and zScale arguments as the CPU one,
 *    but Node has no adapter, so the engine falls back to CPU and any check
 *    here would be testing the CPU path twice. The engine ships an equivalence
 *    probe (PROBE_Z_SCALE, PROBE_ANISO_CELL_X/Y) that runs in the browser; that
 *    is where GPU/CPU unit agreement is established, not here.
 *  - Render-space lengths and the measurement HUD (src/render/). Values are
 *    read back from three.js world transforms, which need a WebGL context.
 *  - Colorbar and legend tick labels, and the on-canvas scan report
 *    (src/export/ScanReportRenderer.ts drawing paths). They require a 2D canvas
 *    context; only the pure label helpers are covered above.
 *  - PDF report page composition (src/report/ReportPdfRenderer.ts). The unit
 *    strings it prints come from the pure builders covered above, but the
 *    rendered page is not inspected here.
 *  - Octree node spacing as surfaced in the streaming panel (src/main.ts). It
 *    lives inside the DOM-bound panel refresher and is not importable; see the
 *    suite report for the defect noted there.
 */
