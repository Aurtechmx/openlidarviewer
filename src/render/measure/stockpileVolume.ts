/**
 * stockpileVolume.ts
 *
 * The stockpile / earthworks vertical: a cut-fill volume for a footprint
 * polygon that ships with an AUDITABLE confidence band, not a bare number.
 *
 * Every cloud-volume tool reports "1,254 m³" and stops. A stockpile volume
 * is a financial figure (inventory valuation, earthworks payment), and the
 * honest version is "1,254 m³ ± 41 (±3.3%), and here is exactly why."
 *
 * The band combines two independent, defensible error sources and shows the
 * math behind each:
 *
 *   1. SAMPLING error — the point-sample estimator integrates the mean
 *      thickness over the footprint. The standard error of that mean is
 *      σ(thickness) / √N over the N points inside the polygon, so the
 *      1σ volume error is  area · σ(thickness) / √N. Sparse footprints have
 *      a larger band; this is the "density" honesty the Scan Intelligence
 *      panel already preaches, made quantitative.
 *      INDEPENDENCE ASSUMPTION: the √N reduction treats per-point thickness
 *      residuals as spatially INDEPENDENT. Real scan noise is correlated
 *      (scan lines, registration drift, surface texture), so the true
 *      sampling error can exceed this term — a caveat states so on every
 *      result, mirroring the change-detection module's wording.
 *
 *   2. BASE-PLANE error — the whole pile sits on a reference height. If that
 *      base is uncertain by σ_base metres (how noisy/sloped the surrounding
 *      ground is), the volume shifts by  area · σ_base. For a flat-topped
 *      pile on bumpy ground this is usually the DOMINANT term — exactly the
 *      assumption a black-box number hides.
 *
 * Combined in quadrature (assumes the two sources are independent):
 *   σ_V = √(σ_sample² + σ_base²).
 *
 * Pure of three.js and the DOM — unit-testable in Node. Built on the existing
 * `volumeCutFill` estimator (reused for fill / cut / footprint / density) plus
 * a single extra pass for the per-point thickness variance.
 */

import type { Vec3 } from '../navMath';
import {
  horizontalBasis,
  horizontalProjection,
  pointInPolygon2D,
  volumeCutFill,
} from './volume';
import type { PolygonValidity } from './polygonHygiene';
import { WelfordStats } from '../../process/numerics';

/** How the base (reference) height under the pile is chosen. */
export type BasePlaneMode =
  /** Lowest `basePercentile` of the inside heights — the surrounding ground. */
  | 'lowest-percentile'
  /** An explicit reference height supplied by the analyst. */
  | 'explicit';

/** Confidence tier derived from relative error + coverage. */
export type StockpileConfidence = 'high' | 'medium' | 'low';

export interface StockpileInput {
  /** Footprint polygon, render-space vertices in placement order. */
  readonly polygon: ReadonlyArray<Vec3>;
  /** Interleaved x/y/z positions (length 3·N). Pass the resident subset. */
  readonly positions: Float32Array;
  /** World up vector. Defaults to `[0, 0, 1]`. */
  readonly up?: Vec3;
  /** Base-plane selection. Defaults to lowest-percentile at 0.05. */
  readonly base?: {
    readonly mode: BasePlaneMode;
    /** For `lowest-percentile`: fraction in (0,1). Default 0.05. */
    readonly percentile?: number;
    /** For `explicit`: the reference height in render-space metres. */
    readonly z?: number;
  };
  /**
   * True when the loaded cloud was voxel-reduced to fit the device budget, so
   * the inside points are a representative sample of a denser survey. Adds an
   * honesty caveat; the ± band already widens with the smaller resident N.
   */
  readonly sourceReduced?: boolean;
  /**
   * Horizontal `linearUnitToMetres` for the source CRS (feet ⇒ 0.3048). Used
   * ONLY to evaluate the density confidence bar in points/m² — the footprint,
   * volume and band figures stay in native units and are converted for display
   * downstream. Defaults to 1 (already metres), so a metric project is
   * unchanged.
   */
  readonly linearUnitToMetres?: number;
  /**
   * Whether the horizontal unit is actually KNOWN, so a points/m² density is a
   * real figure rather than an assumption. Defaults to true — a metric project
   * or any caller that has resolved its CRS. Pass false for an unknown CRS:
   * `linearUnitToMetres` still defaults to 1 for the display conversion, but the
   * density bar is then only an assumed points/m², so it must not be allowed to
   * award HIGH confidence. Omission cannot be read as "unknown" — most callers
   * omit it precisely because they mean known metres.
   */
  readonly densityUnitKnown?: boolean;
}

/**
 * The "show the math" breakdown — every input behind the number and band.
 *
 * UNIT CONTRACT: like the parent {@link StockpileVolumeResult}, every magnitude
 * here is in the cloud's NATIVE render/source linear units (areas ×lin², volumes
 * ×lin³, lengths ×lin). The presenter converts at the display/export boundary.
 * The `m²` / `m³` / `m` in the per-field comments below name the DIMENSION, not a
 * pre-converted metre value — for a foot-CRS these are ft², ft³, ft.
 */
export interface StockpileBreakdown {
  /** Footprint area on the horizontal plane, m². */
  readonly footprintArea: number;
  /** Points whose XY projection fell inside the footprint. */
  readonly pointsInPolygon: number;
  /**
   * Sample density inside the footprint, points per NATIVE horizontal-unit²
   * (divide by (linearUnitToMetres)² for pts/m²). The presenter converts.
   */
  readonly densityNative: number;
  /** Base reference height used, render-space metres. */
  readonly baseZ: number;
  /** How the base was chosen. */
  readonly baseMode: BasePlaneMode;
  /** 1σ uncertainty of the base height, m (0 for an explicit base). */
  readonly baseUncertainty: number;
  /** Mean pile thickness above the base across inside points, m. */
  readonly meanThickness: number;
  /** Std of the per-point thickness, m. */
  readonly thicknessStdDev: number;
  /** 1σ volume error from point sampling, m³. */
  readonly samplingError: number;
  /** 1σ volume error from base-plane uncertainty, m³. */
  readonly basePlaneError: number;
}

/**
 * UNIT CONTRACT: every magnitude here is in the cloud's NATIVE (render / source)
 * linear units — volumes in native³, areas in native², lengths in native — NOT
 * metres. `stockpilePresenter` converts to metres at display/export by ×lin,
 * ×lin², ×lin³ (lin = linearUnitToMetres). For a metre-based CRS native == m;
 * for a state-plane-feet cloud native == feet. Do not treat these as m³.
 */
export interface StockpileVolumeResult {
  /** Stockpile volume above the base (fill), native units³ (×lin³ → m³). ≥ 0. */
  readonly volume: number;
  /** Material below the base inside the footprint (cut), native units³. ≥ 0. */
  readonly cut: number;
  /** Combined 1σ uncertainty on `volume`, native units³. */
  readonly sigma: number;
  /** Volume − 1σ, native units³ (clamped at 0). */
  readonly low: number;
  /** Volume + 1σ, native units³. */
  readonly high: number;
  /** sigma / volume (0 when volume is 0). */
  readonly relativeError: number;
  /** Confidence tier. */
  readonly confidence: StockpileConfidence;
  /**
   * Whether the horizontal unit was known when grading. When false the density
   * bar is an assumed points/m², so HIGH confidence was withheld and the
   * presenter labels the density row as unit-unknown rather than claiming m².
   */
  readonly densityUnitKnown: boolean;
  /** The auditable input breakdown. */
  readonly breakdown: StockpileBreakdown;
  /** Polygon-hygiene verdict; non-`ok` returns zeros. */
  readonly validity: PolygonValidity;
  /** Plain-language honesty notes for the report / panel. */
  readonly caveats: ReadonlyArray<string>;
}

/** Sparse-footprint floor: below this, the band is unreliable, not just wide. */
const MIN_RELIABLE_POINTS = 100;

function isZUp(up: Vec3): boolean {
  return Math.abs(up[2] - 1) < 1e-6 && Math.abs(up[0]) < 1e-6 && Math.abs(up[1]) < 1e-6;
}

/** Linear-interpolated percentile of a finite, already-sorted ascending array. */
function percentileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const idx = Math.max(0, Math.min(1, p)) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

/**
 * Compute a stockpile volume with an auditable confidence band.
 *
 * Reuses `volumeCutFill` for the fill/cut/area/density/validity figures, then
 * makes one extra pass over the inside points to derive the thickness variance
 * (sampling error) and the base-height noise (base-plane error).
 */
export function stockpileVolume(input: StockpileInput): StockpileVolumeResult {
  const up = input.up ?? ([0, 0, 1] as Vec3);
  const baseMode: BasePlaneMode = input.base?.mode ?? 'lowest-percentile';
  const basePct = input.base?.percentile ?? 0.05;
  // Known unless the caller explicitly says the unit is unknown (see the input
  // field's contract — omission means known metres, not unknown).
  const densityUnitKnown = input.densityUnitKnown ?? true;

  // First gather the inside heights — we need them to choose the base plane
  // and to estimate its uncertainty before we can integrate thickness.
  const zUp = isZUp(up);
  const projPoly = input.polygon.map((p) => horizontalProjection(p, up));
  // Projection basis and up length are loop-invariant; hoist them so the
  // gather below inlines the general-up projection as scalar dot products
  // instead of allocating per point.
  const basis = horizontalBasis(up);
  const upLen = Math.hypot(up[0], up[1], up[2]) || 1;
  const n = input.positions.length / 3;
  const insideHeights: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = input.positions[i * 3];
    const py = input.positions[i * 3 + 1];
    const pz = input.positions[i * 3 + 2];
    if (!Number.isFinite(pz)) continue;
    let hx: number;
    let hy: number;
    if (zUp || basis.zAligned) {
      hx = px;
      hy = py;
    } else {
      hx = px * basis.east[0] + py * basis.east[1] + pz * basis.east[2];
      hy = px * basis.north[0] + py * basis.north[1] + pz * basis.north[2];
    }
    if (!pointInPolygon2D(hx, hy, projPoly)) continue;
    insideHeights.push(zUp ? pz : (px * up[0] + py * up[1] + pz * up[2]) / upLen);
  }

  // Choose the base height.
  let baseZ: number;
  let baseUncertainty: number;
  if (baseMode === 'explicit') {
    baseZ = input.base?.z ?? 0;
    baseUncertainty = 0;
  } else {
    if (insideHeights.length === 0) {
      baseZ = 0;
      baseUncertainty = 0;
    } else {
      const sorted = Float64Array.from(insideHeights).sort();
      baseZ = percentileSorted(sorted, basePct);
      // Base-plane uncertainty has TWO parts, and the band is only honest if it
      // carries both:
      //
      //   1. Random scatter — the std of the "ground band" (lowest 25% of inside
      //      heights, the points sitting on the surrounding ground). How noisy
      //      the apron is.
      //   2. Systematic mis-fit — a single HORIZONTAL base under sloped or
      //      uneven ground biases EVERY thickness the same direction, so it
      //      cannot be averaged away by more points (a Type-B systematic term in
      //      GUM language). Point scatter alone misses it. We bound it by how far
      //      the representative ground level — the ground band's MEAN — sits
      //      above the chosen low-percentile base: the amount the flat base is
      //      systematically too low across the footprint. Flat ground ⇒ this gap
      //      ≈ 0 and scatter governs; a sloped apron ⇒ it dominates, widening the
      //      band honestly instead of reporting a confidently-narrow number.
      //
      // Take the larger of the two so the systematic term sets a floor the
      // random term can never shrink below.
      const groundCount = Math.max(1, Math.floor(sorted.length * 0.25));
      const groundBand = sorted.subarray(0, groundCount);
      const groundScatter = stdDev(groundBand);
      let groundSum = 0;
      for (let i = 0; i < groundBand.length; i++) groundSum += groundBand[i];
      const groundMean = groundSum / groundBand.length;
      const baseBias = Math.max(0, groundMean - baseZ);
      baseUncertainty = Math.max(groundScatter, baseBias);
    }
  }

  // Reuse the existing estimator for fill/cut/area/density/validity.
  const v = volumeCutFill({
    polygon: input.polygon,
    referenceZ: baseZ,
    up,
    positions: input.positions,
  });

  const inN = v.pointsInPolygon;
  if (v.validity !== 'ok' || inN === 0) {
    return zeroResult(v.validity ?? 'ok', v.footprintArea, baseMode, baseZ, densityUnitKnown);
  }

  // Per-point thickness above the base (clamped at 0 — the fill contribution),
  // mean and std for the sampling-error term. Welford streams both in one pass
  // with no cancellation — the naive Σt²/n − mean² form loses the variance
  // entirely for a tall pile with a smooth top (spread tiny next to the mean).
  // fill = area · mean(thickness).
  const thickness = new WelfordStats();
  for (const z of insideHeights) thickness.push(Math.max(0, z - baseZ));
  const m = insideHeights.length || 1;
  const meanThk = thickness.mean;
  const stdThk = thickness.populationStd;

  const area = v.footprintArea;
  // Standard error of the mean thickness × area. The √N must be taken over the
  // SAME population the thickness σ was computed on — the `m` finite inside
  // heights — not `inN`. The two coincide (volumeCutFill also excludes
  // non-finite-z inside points), but using `m` keeps σ and √N self-consistent
  // regardless of how volumeCutFill counts.
  const samplingError = m > 0 ? (area * stdThk) / Math.sqrt(m) : 0;
  const basePlaneError = area * baseUncertainty;
  const sigma = Math.hypot(samplingError, basePlaneError);

  const volume = v.fill;
  const relativeError = volume > 0 ? sigma / volume : 0;
  // `v.densityNative` is points per NATIVE horizontal-unit². The confidence bar is a
  // points/m² threshold, so convert before grading — otherwise a dense foot
  // survey (≈11 pts/m² per pt/ft²) is graded as if 1 pt/ft² were 1 pt/m² and
  // wrongly downgraded. m² per native² = linearUnitToMetres².
  const lin = input.linearUnitToMetres ?? 1;
  const densityPerM2 = lin > 0 ? v.densityNative / (lin * lin) : v.densityNative;
  const confidence = gradeConfidence(relativeError, inN, densityPerM2, densityUnitKnown);
  const caveats = buildCaveats(
    confidence,
    inN,
    relativeError,
    baseMode,
    baseUncertainty,
    input.sourceReduced ?? false,
  );

  return {
    volume,
    cut: v.cut,
    sigma,
    low: Math.max(0, volume - sigma),
    high: volume + sigma,
    relativeError,
    confidence,
    densityUnitKnown,
    breakdown: {
      footprintArea: area,
      pointsInPolygon: inN,
      densityNative: v.densityNative,
      baseZ,
      baseMode,
      baseUncertainty,
      meanThickness: meanThk,
      thicknessStdDev: stdThk,
      samplingError,
      basePlaneError,
    },
    validity: 'ok',
    caveats,
  };
}

function stdDev(values: ArrayLike<number>): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

function gradeConfidence(
  relErr: number,
  pointsInPolygon: number,
  densityPerM2: number,
  densityUnitKnown: boolean,
): StockpileConfidence {
  if (pointsInPolygon < MIN_RELIABLE_POINTS) return 'low';
  // HIGH is the only tier that rests on the points/m² density bar. When the
  // horizontal unit is unknown that figure is an assumption (native² read as
  // m²), so it cannot earn HIGH — the grade falls back to the relative-error
  // tiers, which need no unit.
  if (densityUnitKnown && relErr <= 0.05 && densityPerM2 >= 5) return 'high';
  if (relErr <= 0.15) return 'medium';
  return 'low';
}

function buildCaveats(
  confidence: StockpileConfidence,
  pointsInPolygon: number,
  relErr: number,
  baseMode: BasePlaneMode,
  baseUncertainty: number,
  sourceReduced: boolean,
): string[] {
  const out: string[] = [];
  if (pointsInPolygon < MIN_RELIABLE_POINTS) {
    out.push(
      `Only ${pointsInPolygon} points fell inside the footprint — the volume is indicative, not measured.`,
    );
  }
  if (sourceReduced) {
    out.push(
      'This cloud was reduced to fit your device, so the inside points are a representative sample of a denser survey — the ± band reflects that thinner sample.',
    );
  }
  if (relErr > 0.15) {
    out.push(
      `The ±${(relErr * 100).toFixed(0)}% band is wide; treat the volume as an estimate and validate against ground control.`,
    );
  }
  if (baseMode === 'lowest-percentile') {
    out.push(
      `Base plane was inferred from the lowest ground points inside the footprint (±${baseUncertainty.toFixed(2)} m); set an explicit base if you have a surveyed datum.`,
    );
  }
  out.push('Point-sample estimate over a horizontal base plane; not a triangulated surface-to-surface volume.');
  // Mirrors changeUncertainty's spatial-correlation caveat: the √N in the
  // sampling-error term assumes independent residuals, which scan noise
  // (scan lines, registration drift) routinely violates.
  out.push(
    'Point-sampling noise is assumed spatially independent; the true error is larger if it is correlated.',
  );
  if (confidence === 'high') {
    out.unshift('Dense, even coverage with a clean base — suitable for a documented stockpile figure once validated.');
  }
  return out;
}

function zeroResult(
  validity: PolygonValidity,
  footprintArea: number,
  baseMode: BasePlaneMode,
  baseZ: number,
  densityUnitKnown: boolean,
): StockpileVolumeResult {
  return {
    volume: 0,
    cut: 0,
    sigma: 0,
    low: 0,
    high: 0,
    relativeError: 0,
    confidence: 'low',
    densityUnitKnown,
    breakdown: {
      footprintArea,
      pointsInPolygon: 0,
      densityNative: 0,
      baseZ,
      baseMode,
      baseUncertainty: 0,
      meanThickness: 0,
      thicknessStdDev: 0,
      samplingError: 0,
      basePlaneError: 0,
    },
    validity,
    caveats:
      validity === 'ok'
        ? ['No points fell inside the footprint.']
        : [`Footprint is not usable (${validity}).`],
  };
}
