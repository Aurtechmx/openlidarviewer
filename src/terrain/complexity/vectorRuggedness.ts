/**
 * vectorRuggedness.ts
 *
 * Pure-data leaf — Vector Ruggedness Measure (VRM), implemented from the
 * primary literature:
 *
 *   Sappington, J. M., Longshore, K. M., & Thompson, D. B. (2007).
 *   "Quantifying Landscape Ruggedness for Animal Habitat Analysis:
 *   A Case Study Using Bighorn Sheep in the Mojave Desert."
 *   Journal of Wildlife Management 71(5), 1419–1426.
 *   doi:10.2193/2005-723
 *
 * No third-party implementation was consulted or ported. Definition: each
 * cell contributes a unit vector normal to its surface, decomposed from
 * slope angle θ and aspect; over a moving window of n valid cells the
 * resultant R = √(Σx² + Σy² + Σz²), and
 *
 *   VRM = 1 − R/n   ∈ [0, 1]
 *
 * 0 = all normals parallel (flat OR a constant plane — VRM is
 * slope-independent by construction, which is its advantage over total
 * curvature / TRI-style measures); → 1 as normals decohere.
 *
 * INPUT CONVENTION — this module does NOT recompute derivatives. It
 * consumes the EXISTING `hornSlopeAspect` grids
 * (src/terrain/ground/terrainDerivatives.ts):
 *   - `slope` is the rise/run TANGENT m (dimensionless), so
 *     sinθ = m/√(1+m²), cosθ = 1/√(1+m²) — no atan needed;
 *   - `aspect` α is in RADIANS in the MATH frame — CCW from EAST, π/2 =
 *     north — pointing DOWNSLOPE (atan2(−dz/dy, −dz/dx) on our
 *     northing-up grids). The unit downslope direction in (east, north)
 *     components is therefore (cos α, sin α), and the upward unit normal is
 *
 *       n_east  = sinθ · cos α
 *       n_north = sinθ · sin α
 *       n_up    = cosθ
 *
 *     Mapping to Sappington's decomposition x = sinθ·sin(A),
 *     y = sinθ·cos(A), z = cosθ (A = compass aspect azimuth, clockwise
 *     from north, downslope): A = 90° − α, so sin A = cos α and
 *     cos A = sin α — the same vector with relabelled horizontal axes;
 *     R and VRM are unchanged. This is exactly (−p, −q, 1)/√(1+p²+q²)
 *     for gradient (p, q). The `aspect = 0` sentinel on flat cells is
 *     harmless: sinθ = 0 there, so the horizontal part vanishes.
 *
 * VRM is DIMENSIONLESS and unit-independent: slope tangents are already
 * unit-free (same Z and XY units cancel; `hornSlopeAspect` takes per-axis
 * cell sizes to guarantee that), so the same surface in feet or metres
 * yields the same VRM. The window size is in CELLS (odd edge length; 3 ⇒
 * the 3×3 neighbourhood Sappington used).
 *
 * EDGES & NODATA. The window SHRINKS at the grid border (only in-bounds
 * cells are summed) and NEVER wraps. Invalid cells — non-finite slope or
 * aspect, or masked out by the optional validity mask — are skipped both
 * as centres (their VRM is NaN) and as window members (n counts only
 * valid cells). A valid centre always has n ≥ 1 (itself), so VRM there is
 * defined; a window of one cell has R = n = 1 → VRM 0, honestly reported
 * as a truncated window.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { quantileSorted } from '../quantile';
import {
  finaliseComplexityEnvelope,
  type ComplexityEnvelope,
  type ComplexityMetaInput,
} from './complexityEnvelope';

/** Options for {@link computeVRM}. */
export interface VrmParams {
  /**
   * Moving-window edge length in CELLS. Must be an odd integer ≥ 1
   * (3 = the 3×3 neighbourhood of Sappington et al. 2007). Invalid
   * values fall back to 3 with a warning.
   */
  readonly windowCells: number;
  /**
   * Optional validity mask (nonzero = usable), e.g. `DtmGrid.coverage`,
   * so cells the DTM withheld never contribute a normal. Without it,
   * validity is "slope and aspect both finite".
   */
  readonly valid?: ArrayLike<number>;
  /**
   * Provenance passthrough from the source product (e.g. `DtmGrid`):
   * coverage mode + point counts for the honesty envelope. Omitted →
   * 'full' coverage, 0 points claimed (see complexityEnvelope.ts).
   */
  readonly meta?: ComplexityMetaInput;
}

/** Median + interquartile range (type-7 quantiles) — never a bare number. */
export interface VrmSummary {
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly iqr: number;
}

const NO_SUMMARY: VrmSummary = { median: NaN, p25: NaN, p75: NaN, iqr: NaN };

/**
 * Result of {@link computeVRM}. VRM is dimensionless, in [0, 1]. Carries
 * the `TerrainCoverageMeta` honesty fields (coverage, source/analyzed
 * point counts, derived 0–100 confidence, ordered warnings) via
 * {@link ComplexityEnvelope}.
 */
export interface VrmResult extends ComplexityEnvelope {
  /** VRM per cell, row-major; NaN where the centre cell is invalid. */
  readonly vrm: Float32Array;
  /** Robust summary (median + IQR) of the per-cell VRM distribution. */
  readonly summary: VrmSummary;
  /** Cells whose VRM is finite. */
  readonly validCellCount: number;
  /** Total cells in the grid. */
  readonly cellCount: number;
  /**
   * Valid cells whose window held fewer than windowCells² valid members
   * (grid border or NoData neighbours) — their VRM rests on less support.
   */
  readonly truncatedWindowCount: number;
  /**
   * Mean of (valid window members / full window size) over valid cells,
   * in [0, 1] — the data-support term behind `confidence`.
   */
  readonly meanWindowSupport: number;
  /** Ordered caveats (shrunken windows, parameter fallbacks…). */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Compute per-cell VRM over the existing Horn slope/aspect grids
 * (row-major, length cols×rows). See the header for the exact convention
 * mapping. Deterministic; O(cells × window²).
 */
export function computeVRM(
  slope: ArrayLike<number>,
  aspect: ArrayLike<number>,
  cols: number,
  rows: number,
  params: VrmParams,
): VrmResult {
  const warnings: string[] = [];
  const n = cols > 0 && rows > 0 ? cols * rows : 0;
  const vrm = new Float32Array(n).fill(NaN);

  let window = params.windowCells;
  if (!Number.isInteger(window) || window < 1 || window % 2 === 0) {
    warnings.push(`windowCells invalid (${String(params.windowCells)}); using 3`);
    window = 3;
  }
  const half = (window - 1) / 2;
  const fullWindow = window * window;

  if (n === 0 || slope.length < n || aspect.length < n) {
    if (n > 0) warnings.push('slope/aspect shorter than cols×rows — no cells analysed');
    warnings.push('empty grid — no VRM computed');
    return emptyVrmResult(vrm, n, warnings, params.meta);
  }

  const valid = params.valid;

  // Precompute the unit normal per cell from the Horn tangent + math-frame
  // downslope aspect (see header). Invalid cells get a NaN normal.
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const nz = new Float64Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = slope[i];
    const a = aspect[i];
    if ((valid != null && valid[i] === 0) || !Number.isFinite(m) || !Number.isFinite(a)) continue;
    const inv = 1 / Math.sqrt(1 + m * m); // cosθ
    const sinTheta = m * inv;
    nx[i] = sinTheta * Math.cos(a); // east
    ny[i] = sinTheta * Math.sin(a); // north
    nz[i] = inv; // up
    ok[i] = 1;
  }

  let validCellCount = 0;
  let truncatedWindowCount = 0;
  let supportSum = 0; // Σ (count / fullWindow) over valid cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (ok[i] === 0) continue; // invalid centre → NaN
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      const r0 = Math.max(0, row - half);
      const r1 = Math.min(rows - 1, row + half);
      const c0 = Math.max(0, col - half);
      const c1 = Math.min(cols - 1, col + half); // shrink, never wrap
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const j = r * cols + c;
          if (ok[j] === 0) continue; // NoData member skipped, n counts valid only
          sx += nx[j];
          sy += ny[j];
          sz += nz[j];
          count++;
        }
      }
      // count ≥ 1 (the centre itself is valid).
      if (count < fullWindow) truncatedWindowCount++;
      supportSum += count / fullWindow;
      const resultant = Math.sqrt(sx * sx + sy * sy + sz * sz);
      // Unit vectors ⇒ R ≤ n; clamp float-error excursions to keep [0, 1].
      const v = 1 - resultant / count;
      vrm[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      validCellCount++;
    }
  }

  if (validCellCount === 0) {
    warnings.push('no valid cells — VRM undefined everywhere');
    return emptyVrmResult(vrm, n, warnings, params.meta);
  }

  if (truncatedWindowCount > 0) {
    warnings.push(
      `${truncatedWindowCount} of ${validCellCount} windows truncated at grid border or NoData — edge VRM rests on fewer normals`,
    );
  }

  const finite: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(vrm[i])) finite.push(vrm[i]);
  finite.sort((a, b) => a - b);
  const p25 = quantileSorted(finite, 0.25);
  const p75 = quantileSorted(finite, 0.75);

  const meanWindowSupport = supportSum / validCellCount;
  const envelope = finaliseComplexityEnvelope(
    { cellCount: n, validCellCount, meanWindowSupport },
    params.meta,
    warnings,
  );

  return {
    ...envelope,
    vrm,
    summary: { median: quantileSorted(finite, 0.5), p25, p75, iqr: p75 - p25 },
    validCellCount,
    cellCount: n,
    truncatedWindowCount,
    meanWindowSupport,
    warnings,
  };
}

function emptyVrmResult(
  vrm: Float32Array,
  cellCount: number,
  warnings: string[],
  meta: ComplexityMetaInput | undefined,
): VrmResult {
  const envelope = finaliseComplexityEnvelope(
    { cellCount, validCellCount: 0, meanWindowSupport: 0 },
    meta,
    warnings,
  );
  return {
    ...envelope,
    vrm,
    summary: NO_SUMMARY,
    validCellCount: 0,
    cellCount,
    truncatedWindowCount: 0,
    meanWindowSupport: 0,
    warnings,
  };
}
