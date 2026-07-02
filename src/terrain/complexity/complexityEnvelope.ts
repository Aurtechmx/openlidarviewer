/**
 * complexityEnvelope.ts
 *
 * Pure-data leaf — the honesty envelope for the terrain-complexity
 * metrics (TPI, VRM). Every complexity result carries the
 * `TerrainCoverageMeta` fields (src/terrain/TerrainContracts.ts):
 * coverage mode, source/analyzed point counts, a 0–100 confidence, and
 * ordered warnings.
 *
 * CONFIDENCE IS DERIVED, NEVER ASSERTED. It is computed from observable
 * data support only:
 *
 *   validFraction     = valid cells / total cells      (void fraction is
 *                       1 − validFraction)
 *   meanWindowSupport = mean over valid cells of
 *                       (valid window members / full window size)
 *                       — captures both border truncation (edge
 *                       fraction) and NoData holes eating windows
 *   confidence        = round(100 · validFraction · meanWindowSupport)
 *
 * A grid with no valid cells has confidence 0. There is no floor, no
 * hardcoded default, and nothing here can output a number the inputs do
 * not justify — the same falsifiability rule the DTM confidence layer
 * follows (cellConfidence.ts) and the v0.3.10 honesty pass enforced.
 *
 * Point counts are a PASSTHROUGH of the source product's own envelope
 * (e.g. `DtmGrid.sourcePointCount` / `analyzedPointCount`): a raster
 * metric cannot re-derive how many points built the raster. When the
 * caller supplies none, both report 0 — "no points claimed" — rather
 * than an invented count.
 *
 * Warning order (appended after any core-specific warnings, stable):
 *   1. coverage-mode caveat (resident-only / sampled), when applicable
 *   2. void-fraction caveat, when voids exist
 * Core warnings (parameter fallbacks, window truncation) precede these.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainCoverageMode } from '../TerrainContracts';

/**
 * Provenance passthrough from the product the metric was computed over
 * (typically a `DtmGrid`). Everything is optional; omissions degrade to
 * the honest defaults documented on {@link finaliseComplexityEnvelope}.
 */
export interface ComplexityMetaInput {
  /** How thoroughly the SOURCE product walked its cloud. Default 'full'. */
  readonly coverage?: TerrainCoverageMode;
  /** Points the source product declared. Default 0 (no points claimed). */
  readonly sourcePointCount?: number;
  /** Points the source product actually walked. Default 0. */
  readonly analyzedPointCount?: number;
}

/** Data-support observations a core hands to the envelope. */
export interface ComplexitySupport {
  /** Total cells in the grid. */
  readonly cellCount: number;
  /** Cells that produced a finite metric value. */
  readonly validCellCount: number;
  /**
   * Mean of (valid window members / full window size) over valid cells,
   * in [0, 1]. 0 when there are no valid cells.
   */
  readonly meanWindowSupport: number;
}

/** The TerrainCoverageMeta fields every complexity result carries. */
export interface ComplexityEnvelope {
  readonly coverage: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  /** 0–100, derived from {@link ComplexitySupport} — see the header. */
  readonly confidence: number;
}

/**
 * Derive the 0–100 confidence from data support alone.
 * `round(100 · validFraction · meanWindowSupport)`, clamped to [0, 100];
 * 0 when the grid is empty or nothing is valid.
 */
export function deriveComplexityConfidence(support: ComplexitySupport): number {
  const { cellCount, validCellCount, meanWindowSupport } = support;
  if (!(cellCount > 0) || !(validCellCount > 0)) return 0;
  const validFraction = Math.min(1, validCellCount / cellCount);
  const windowSupport =
    Number.isFinite(meanWindowSupport) && meanWindowSupport > 0
      ? Math.min(1, meanWindowSupport)
      : 0;
  const c = Math.round(100 * validFraction * windowSupport);
  return c < 0 ? 0 : c > 100 ? 100 : c;
}

/**
 * Build the envelope and append the ordered envelope warnings to
 * `warnings` (mutated in place; core warnings keep their position).
 */
export function finaliseComplexityEnvelope(
  support: ComplexitySupport,
  meta: ComplexityMetaInput | undefined,
  warnings: string[],
): ComplexityEnvelope {
  const coverage: TerrainCoverageMode = meta?.coverage ?? 'full';
  if (coverage === 'resident-only') {
    warnings.push('source coverage resident-only — complexity may refine as nodes stream in');
  } else if (coverage === 'sampled') {
    warnings.push('source coverage sampled — complexity reflects the sampled subset only');
  }
  const voids = support.cellCount - support.validCellCount;
  if (support.cellCount > 0 && voids > 0) {
    const pct = Math.round((100 * voids) / support.cellCount);
    warnings.push(
      `${voids} of ${support.cellCount} cells (${pct}%) are voids or invalid — summarised over the ${support.validCellCount} valid cells only`,
    );
  }
  const src = meta?.sourcePointCount;
  const ana = meta?.analyzedPointCount;
  return {
    coverage,
    sourcePointCount: Number.isFinite(src) && (src as number) >= 0 ? Math.round(src as number) : 0,
    analyzedPointCount:
      Number.isFinite(ana) && (ana as number) >= 0 ? Math.round(ana as number) : 0,
    confidence: deriveComplexityConfidence(support),
  };
}
