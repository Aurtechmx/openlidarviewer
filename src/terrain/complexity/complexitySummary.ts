/**
 * complexitySummary.ts
 *
 * Pure-data leaf — the compact, presentation-ready summary of the two
 * literature-defined terrain-complexity metrics, computed ONCE per
 * analysis run inside the terrain core (off the interactive path — the
 * worker or its main-thread fallback), never eagerly at scan attach:
 *
 *   - VRM per Sappington, Longshore & Thompson (2007), doi:10.2193/2005-723
 *     — slope-DECOUPLED ruggedness in [0, 1], summarised as median + IQR
 *     over the valid cells (never a bare mean).
 *   - TPI + six-class slope position per Weiss (2001) — the dominant
 *     landform class over the valid cells, with its share.
 *
 * Everything here is DERIVED and every figure states its window and its
 * units: the VRM window in cells AND ground metres, the TPI radius in
 * cells AND ground metres, TPI in the grid's own Z units (it scales
 * linearly with Z), VRM dimensionless by construction. The confidence is
 * the more conservative of the two cores' derived envelopes — computed
 * from data support (valid fraction × window support), never asserted.
 *
 * DENSITY-RELIABILITY CAVEAT (cited). Münzinger, Prechtel & Behnisch
 * (2022, doi:10.1016/j.ufug.2022.127637) report ≥ 4 pts/m² as the
 * density needed for reliable detailed vegetation/terrain structure from
 * airborne scans; LaRue et al. (doi:10.5281/zenodo.6463393) evidence the
 * sensitivity of structural-complexity metrics to point density. Below
 * that threshold the summary still computes — the caveat WARNS, it does
 * not block — but it says plainly that the outputs are indicative.
 *
 * Display strings (`vrmText`, `tpiText`, `detail`) are composed HERE, in
 * the lazily-loaded analysis chunk, so the always-loaded card/panel/
 * provenance surfaces render passthrough strings instead of carrying
 * their own formatting weight — and so every surface prints the same
 * words (no drift).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { computeVRM } from './vectorRuggedness';
import { computeTPI, TPI_CLASS, type TpiClassName } from './terrainPositionIndex';
import type { ComplexityMetaInput } from './complexityEnvelope';

/**
 * VRM display bands over the median. Sappington et al. (2007) observed
 * landscape VRM (3×3) from ~0 (flat and even steep-but-smooth terrain)
 * to ~0.4 in the most broken terrain, with moderately rugged terrain in
 * the low hundredths. These cut-points are a coarse DISPLAY banding of
 * that observed range, not a standard classification — which is why the
 * numeric median + IQR always accompanies the label.
 */
export const VRM_BAND_THRESHOLDS = { moderate: 0.002, high: 0.02, veryHigh: 0.1 } as const;

/** Display band derived from the VRM median (see {@link VRM_BAND_THRESHOLDS}). */
export type ComplexityBand = 'low' | 'moderate' | 'high' | 'very-high';

/** Band from a VRM median, or null when the median is not finite. */
export function vrmBand(median: number): ComplexityBand | null {
  if (!Number.isFinite(median)) return null;
  if (median < VRM_BAND_THRESHOLDS.moderate) return 'low';
  if (median < VRM_BAND_THRESHOLDS.high) return 'moderate';
  if (median < VRM_BAND_THRESHOLDS.veryHigh) return 'high';
  return 'very-high';
}

/** Human label for a band. */
export function complexityBandLabel(b: ComplexityBand | null): string {
  switch (b) {
    case 'low': return 'Low';
    case 'moderate': return 'Moderate';
    case 'high': return 'High';
    case 'very-high': return 'Very High';
    default: return '—';
  }
}

/**
 * The density threshold below which the reliability caveat attaches:
 * ≥ 4 pts/m² per Münzinger et al. (2022), doi:10.1016/j.ufug.2022.127637.
 */
export const COMPLEXITY_DENSITY_THRESHOLD_PTS_M2 = 4;

/**
 * The cited density-reliability caveat, or null when the density meets the
 * threshold (or is unknown — an unknown density earns no confident caveat).
 * A warning, never a block: the metrics still compute and render.
 */
export function densityReliabilityCaveat(densityPerM2: number | null | undefined): string | null {
  if (densityPerM2 == null || !Number.isFinite(densityPerM2) || densityPerM2 <= 0) return null;
  if (densityPerM2 >= COMPLEXITY_DENSITY_THRESHOLD_PTS_M2) return null;
  const d = densityPerM2 >= 10 ? Math.round(densityPerM2).toString() : densityPerM2.toFixed(1);
  return (
    `point density ${d} pts/m² is below the ≥4 pts/m² reliability threshold ` +
    'reported for detailed terrain/vegetation complexity (Münzinger et al. 2022, ' +
    'doi:10.1016/j.ufug.2022.127637); treat complexity as indicative'
  );
}

/**
 * The slope/aspect convention every complexity figure rests on — stamped
 * into report + export provenance so the parameters are reproducible.
 */
export const SLOPE_ASPECT_CONVENTION_NOTE =
  'Slope/aspect per Horn (1981) 3×3 on the DTM grid; slope as rise/run tangent, ' +
  'aspect downslope in the math frame (CCW from east). VRM per Sappington et al. ' +
  '(2007); TPI and slope-position classes per Weiss (2001).';

/** Target TPI neighbourhood radius in ground metres (see {@link pickTpiRadiusCells}). */
export const TPI_TARGET_RADIUS_M = 10;

/**
 * TPI radius in CELLS aiming for a ~{@link TPI_TARGET_RADIUS_M} m
 * neighbourhood at this grid's cell size, clamped to [2, 10] cells so a
 * very fine grid stays affordable and a very coarse one keeps a real
 * neighbourhood. The ACHIEVED radius (cells and metres) is always
 * reported — the target is an aim, never a claim.
 */
export function pickTpiRadiusCells(cellMetres: number): number {
  if (!Number.isFinite(cellMetres) || cellMetres <= 0) return 2;
  return Math.max(2, Math.min(10, Math.round(TPI_TARGET_RADIUS_M / cellMetres)));
}

/** Human name for a TPI class code (Weiss 2001 six-class slope position). */
export function tpiClassLabel(name: TpiClassName): string {
  switch (name) {
    case 'valley': return 'valley';
    case 'lower': return 'lower slope';
    case 'middle': return 'middle slope';
    case 'flat': return 'flat';
    case 'upper': return 'upper slope';
    case 'ridge': return 'ridge';
    default: return 'no data';
  }
}

/** Inputs for {@link summariseTerrainComplexity} — all already computed by the core. */
export interface ComplexitySummaryInput {
  /** DTM heights, row-major (filled where coverage > 0). */
  readonly z: ArrayLike<number>;
  /** Per-cell coverage mask (0 none / 1 interpolated / 2 measured). */
  readonly coverage: ArrayLike<number>;
  readonly cols: number;
  readonly rows: number;
  /** Horn slope grid (rise/run tangent) from the core's derivative pass. */
  readonly slope: ArrayLike<number>;
  /** Horn aspect grid (radians, math frame, downslope) from the same pass. */
  readonly aspect: ArrayLike<number>;
  /** East–west cell size in METRES (cos φ-corrected for geographic frames). */
  readonly cellMetresX: number;
  /** North–south cell size in METRES. */
  readonly cellMetresY: number;
  /** Metres per source vertical unit (labels TPI's Z units). Default 1. */
  readonly verticalUnitToMetres?: number;
  /** Provenance passthrough (coverage mode + point counts) for the envelope. */
  readonly meta?: ComplexityMetaInput;
  /** Scan-scaled ground density in pts/m², for the cited reliability caveat. */
  readonly groundDensityPerM2?: number | null;
}

/**
 * The compact summary the UI, report and export provenance all render.
 * Plain data (numbers + strings) so it structured-clones through the
 * terrain worker unchanged.
 */
export interface TerrainComplexitySummary {
  /** VRM median over valid cells — dimensionless, [0, 1]. */
  readonly vrmMedian: number;
  readonly vrmP25: number;
  readonly vrmP75: number;
  readonly vrmIqr: number;
  /** VRM moving-window edge length in cells (3 = Sappington's 3×3). */
  readonly vrmWindowCells: number;
  /** VRM window edge in ground metres, or null when cell metres are unknown. */
  readonly vrmWindowGroundM: number | null;
  /** TPI median over valid cells, in the grid's Z units. */
  readonly tpiMedian: number;
  readonly tpiIqr: number;
  /** TPI neighbourhood radius in cells (Euclidean, centre excluded). */
  readonly tpiRadiusCells: number;
  /** TPI radius in ground metres, or null when cell metres are unknown. */
  readonly tpiRadiusGroundM: number | null;
  /** Dominant Weiss slope-position class, or null when classes are absent. */
  readonly tpiDominantClass: TpiClassName | null;
  /** Share of valid classified cells in the dominant class (0 when none). */
  readonly tpiDominantFraction: number;
  /** Display band from the VRM median, or null when nothing was measurable. */
  readonly band: ComplexityBand | null;
  /** Human label for {@link band} ('—' when null). */
  readonly bandLabel: string;
  /** Z-unit label TPI values are expressed in ('m', 'ft', or 'z-units'). */
  readonly zUnitLabel: string;
  /** Derived 0–100 confidence — min of the two cores' envelopes. */
  readonly confidence: number;
  /** Cells that produced a finite VRM. */
  readonly validCellCount: number;
  /** Total cells in the grid. */
  readonly cellCount: number;
  /** 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈1.5 m), dimensionless' */
  readonly vrmText: string;
  /** 'dominant class middle slope (58% of valid cells), radius 5 cells (≈7.5 m), TPI in m' */
  readonly tpiText: string;
  /** One-line combined display string for the card tooltip / panel line. */
  readonly detail: string;
  /** The reproducibility convention note ({@link SLOPE_ASPECT_CONVENTION_NOTE}). */
  readonly slopeAspectConvention: string;
  /** Scan-scaled ground density the caveat was judged against, or null. */
  readonly groundDensityPerM2: number | null;
  /** Ordered caveats: deduped core warnings, then the density caveat. */
  readonly warnings: ReadonlyArray<string>;
}

const fmtVrm = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : '—');
const fmtZ = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');
const fmtGroundM = (v: number | null): string =>
  v != null && Number.isFinite(v) ? `≈${v >= 10 ? Math.round(v).toString() : v.toFixed(1)} m` : 'ground size unknown';

/** Z-unit label from the vertical unit scale (metres / US-or-intl feet / other). */
function zUnit(verticalUnitToMetres: number | undefined): string {
  const v = verticalUnitToMetres ?? 1;
  if (!Number.isFinite(v) || v <= 0 || Math.abs(v - 1) < 1e-9) return 'm';
  if (Math.abs(v - 0.3048) < 5e-4) return 'ft';
  return 'z-units';
}

/**
 * Compute the terrain-complexity summary over an analysed DTM grid.
 * Returns null when nothing was measurable (no valid cells) so callers
 * render an honest "—" instead of a fabricated band. Deterministic.
 */
export function summariseTerrainComplexity(
  input: ComplexitySummaryInput,
): TerrainComplexitySummary | null {
  const { cols, rows } = input;
  const n = cols > 0 && rows > 0 ? cols * rows : 0;
  if (n === 0) return null;

  // Mean cell size in metres for the window/radius ground statements; null
  // (stated as unknown) when the caller could not resolve metres.
  const cx = input.cellMetresX;
  const cy = input.cellMetresY;
  const cellMetres =
    Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0 ? (cx + cy) / 2 : null;

  // VRM over the EXISTING Horn grids — 3×3, the Sappington et al. window.
  const vrm = computeVRM(input.slope, input.aspect, cols, rows, {
    windowCells: 3,
    valid: input.coverage,
    meta: input.meta,
  });
  if (vrm.validCellCount === 0) return null;

  // TPI over the DTM heights, radius aimed at ~10 m and honestly reported.
  const radiusCells = pickTpiRadiusCells(cellMetres ?? Number.NaN);
  const tpi = computeTPI(input.z, cols, rows, {
    radiusCells,
    slope: input.slope,
    valid: input.coverage,
    meta: input.meta,
  });

  // Dominant Weiss class over the valid classified cells.
  let dominantClass: TpiClassName | null = null;
  let dominantFraction = 0;
  if (tpi.classes) {
    const counts = new Uint32Array(7);
    let classified = 0;
    for (let i = 0; i < tpi.classes.length; i++) {
      const c = tpi.classes[i];
      if (c === 0) continue;
      counts[c]++;
      classified++;
    }
    if (classified > 0) {
      let best = 1;
      for (let c = 2; c <= 6; c++) if (counts[c] > counts[best]) best = c;
      const names = Object.keys(TPI_CLASS) as TpiClassName[];
      dominantClass = names.find((k) => TPI_CLASS[k] === best) ?? null;
      dominantFraction = counts[best] / classified;
    }
  }

  const band = vrmBand(vrm.summary.median);
  const bandLabel = complexityBandLabel(band);
  const zUnitLabel = zUnit(input.verticalUnitToMetres);
  const vrmWindowGroundM = cellMetres != null ? 3 * cellMetres : null;
  const tpiRadiusGroundM = cellMetres != null ? radiusCells * cellMetres : null;
  // The more conservative of the two derived envelopes — never asserted.
  const confidence = Math.min(vrm.confidence, tpi.confidence);

  const vrmText =
    `median ${fmtVrm(vrm.summary.median)} [IQR ${fmtVrm(vrm.summary.iqr)}], ` +
    `3×3-cell window (${fmtGroundM(vrmWindowGroundM)}), dimensionless`;
  const tpiText =
    (dominantClass != null
      ? `dominant class ${tpiClassLabel(dominantClass)} (${Math.round(dominantFraction * 100)}% of valid cells), `
      : 'dominant class not derived, ') +
    `median ${fmtZ(tpi.summary.median)} [IQR ${fmtZ(tpi.summary.iqr)}] ${zUnitLabel}, ` +
    `radius ${radiusCells} cells (${fmtGroundM(tpiRadiusGroundM)})`;
  const detail =
    `VRM ${vrmText}; TPI ${tpiText}; derived, confidence ${confidence}/100`;

  // Ordered caveats: the two cores' warnings deduped (they share the
  // envelope wording for coverage mode / voids), then the cited density
  // reliability caveat when the scan is thinner than the threshold.
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const w of [...vrm.warnings, ...tpi.warnings]) {
    if (seen.has(w)) continue;
    seen.add(w);
    warnings.push(w);
  }
  const density =
    input.groundDensityPerM2 != null && Number.isFinite(input.groundDensityPerM2) && input.groundDensityPerM2 > 0
      ? input.groundDensityPerM2
      : null;
  const caveat = densityReliabilityCaveat(density);
  if (caveat) warnings.push(caveat);

  return {
    vrmMedian: vrm.summary.median,
    vrmP25: vrm.summary.p25,
    vrmP75: vrm.summary.p75,
    vrmIqr: vrm.summary.iqr,
    vrmWindowCells: 3,
    vrmWindowGroundM,
    tpiMedian: tpi.summary.median,
    tpiIqr: tpi.summary.iqr,
    tpiRadiusCells: radiusCells,
    tpiRadiusGroundM,
    tpiDominantClass: dominantClass,
    tpiDominantFraction: dominantFraction,
    band,
    bandLabel,
    zUnitLabel,
    confidence,
    validCellCount: vrm.validCellCount,
    cellCount: n,
    vrmText,
    tpiText,
    detail,
    slopeAspectConvention: SLOPE_ASPECT_CONVENTION_NOTE,
    groundDensityPerM2: density,
    warnings,
  };
}
