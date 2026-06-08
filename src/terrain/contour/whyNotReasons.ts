/**
 * whyNotReasons.ts
 *
 * The "Why? / How to improve" engine. When a surface reads short of fully-good,
 * this explains — in plain language, WITH the measured figure — exactly what is
 * holding it back, and pairs each cause with one actionable fix. It reads only
 * data the gate / assessment already computed; it never invents a number and
 * never claims survey-grade.
 *
 * Each emitted `Cause` is keyed (so duplicates collapse) and carries the honest
 * figure; each `Fix` is a concrete next step a field operator can take. Only the
 * causes that actually apply (against the gate ratios + flags + thresholds) are
 * emitted — a clean, ready, georeferenced result emits nothing.
 *
 * Pure data: no DOM, deterministic.
 */

import type { AnalyseContoursResult } from './analyseContours';

/** A plain-language reason a surface is held back, carrying the measured figure. */
export interface Cause {
  /** Stable key so a cause is never emitted twice. */
  readonly key: string;
  /** The reason, in plain language, including the honest figure. */
  readonly text: string;
}

/** An actionable suggestion to improve the surface. */
export interface Fix {
  /** Stable key (matches the cause it answers) so a fix is never repeated. */
  readonly key: string;
  /** The concrete next step. */
  readonly text: string;
}

/** The combined explanation: ordered causes paired with their fixes. */
export interface Limitations {
  readonly causes: Cause[];
  readonly fixes: Fix[];
}

// Thresholds. These mirror the gate / assessment so the "Why?" surface never
// disagrees with the verdict it explains.
/** Interpolation fraction above which the grid is "mostly guessed" enough to flag. */
const HIGH_INTERP_FRACTION = 0.4;
/** Empty-cell fraction above which there are real holes worth flagging. */
const HIGH_EMPTY_FRACTION = 0.4;
/** Edge-risk fraction above which too much surface is a long reach from data. */
const HIGH_EDGE_FRACTION = 0.15;
/** Mean confidence (0..100) below which confidence is "low". */
const LOW_CONFIDENCE = 55;
/** Ground-return ratio below which the classifier saw too little bare earth. */
const LOW_GROUND_RATIO = 0.1;

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;
const finite = (n: number | null | undefined): number =>
  n != null && Number.isFinite(n) ? n : NaN;

/**
 * Explain why an analysed surface sits short of fully-good, and how to improve
 * it. Emits only the causes that genuinely apply; deduplicates by key; keeps
 * every figure honest (straight from the gate, never fabricated).
 */
export function explainLimitations(result: AnalyseContoursResult): Limitations {
  const q = result.quality;
  const acc = result.accuracyStandards;
  const coverageMode = result.dtm?.coverageMode ?? q.coverageMode;

  const causes: Cause[] = [];
  const fixes: Fix[] = [];
  const seen = new Set<string>();

  const emit = (key: string, cause: string, fix: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    causes.push({ key, text: cause });
    fixes.push({ key, text: fix });
  };

  // ── high interpolation ────────────────────────────────────────────────
  const interpFrac = finite(q.interpolatedCellRatio);
  if (Number.isFinite(interpFrac) && interpFrac > HIGH_INTERP_FRACTION) {
    emit(
      'interpolation',
      `${pct(interpFrac)} of the surface is interpolated, not measured.`,
      'Fly lower, increase overlap, or scan more densely so more of the ground is a real return.',
    );
  }

  // ── low measured coverage / high empty ratio ──────────────────────────
  const emptyFrac = finite(q.emptyCellRatio);
  if (Number.isFinite(emptyFrac) && emptyFrac > HIGH_EMPTY_FRACTION) {
    emit(
      'empty',
      `${pct(emptyFrac)} of the grid has no data at all.`,
      'Extend coverage over the gaps and fly more passes so the grid fills in.',
    );
  }

  // ── high edge risk ────────────────────────────────────────────────────
  const edgeFrac = finite(q.edgeRiskRatio);
  if (Number.isFinite(edgeFrac) && edgeFrac > HIGH_EDGE_FRACTION) {
    emit(
      'edge',
      `${pct(edgeFrac)} of cells are a long interpolation from real returns.`,
      'Extend capture past the area of interest so the edges sit on measured ground.',
    );
  }

  // ── low ground visibility / low mean confidence ───────────────────────
  const groundRatio = finite(q.groundPointRatio);
  const meanConf = finite(q.meanCellConfidence);
  const lowGround = Number.isFinite(groundRatio) && groundRatio < LOW_GROUND_RATIO;
  const lowConf = Number.isFinite(meanConf) && meanConf < LOW_CONFIDENCE;
  if (lowGround || lowConf) {
    const text = lowGround
      ? `Ground returns are sparse — only ${pct(groundRatio)} of returns reached bare earth.`
      : 'Ground returns are low-confidence here.';
    emit(
      'ground-visibility',
      text,
      'Improve ground visibility: reduce occlusion and vegetation, and capture more angles.',
    );
  }

  // ── RMSE not validated ────────────────────────────────────────────────
  const rmse = finite(acc?.rmseZM);
  if (!Number.isFinite(rmse)) {
    emit(
      'rmse',
      'Vertical accuracy could not be validated for this scan.',
      'Add ground-control or check points so the vertical error can be measured.',
    );
  }

  // ── CRS unknown ───────────────────────────────────────────────────────
  if (!q.crsKnown) {
    emit(
      'crs',
      'The coordinate system (CRS) is unknown.',
      'Assign or provide the CRS so the surface is georeferenced.',
    );
  }

  // ── vertical datum unknown ────────────────────────────────────────────
  if (!q.datumKnown) {
    emit(
      'datum',
      'The vertical datum is unknown.',
      'Provide the vertical datum so heights are referenced to a known surface.',
    );
  }

  // ── resident-only / sampled coverage ──────────────────────────────────
  if (coverageMode === 'resident-only' || coverageMode === 'sampled') {
    emit(
      'coverage',
      'Only part of the cloud was analysed (a partial / sampled walk).',
      'Let the full cloud stream in, or load the full scan, then re-run the analysis.',
    );
  }

  return { causes, fixes };
}
