/**
 * contourCopy.ts
 *
 * the honest-UX layer as pure data. One source of truth for
 * the user-facing wording and value formatting the Analyse panel will
 * render, so the copy is unit-testable and consistent everywhere (the
 * same pattern as `COPY_VIEW_LINK_LABEL`).
 *
 * Two principles drive every string here, for honest reporting:
 *   1. Plain language. A first-time visitor (a farmer, a site manager, a
 *      student) should understand the label without GIS vocabulary. So
 *      "find the ground under the trees", not "ground classification".
 *   2. Honesty WITH confidence, not just disclaimers. A wall of "—"
 *      reads as broken; pair every value with how sure we are, and every
 *      absence with why. `formatHonestValue` enforces that shape.
 *
 * Voice: plain English, no marketing filler. A unit test guards against the
 * usual offenders.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import { EVIDENCE_THRESHOLDS, type ContourDisplayGrade } from '../ground/cellConfidence';
import type { IntervalOption, IntervalGateResult } from './intervalGate';
import type { ClassificationScope } from '../validate/ValidationReport';

/** Plain-language names for the Analyse features. */
export const ANALYSE_LABELS = {
  groundClassification: 'Find the ground under the trees',
  contours: 'Elevation contour lines',
  confidenceMap: 'Where the data is strong or weak',
  validation: 'How accurate this surface is',
} as const;

/** One-line plain descriptions, for tooltips / subtitles. */
export const ANALYSE_DESCRIPTIONS = {
  groundClassification:
    'Separates the bare earth from trees, buildings, and noise so the ground shape is what you see.',
  contours:
    'Lines that join points of equal height. Close lines mean steep ground; wide lines mean flat ground.',
  confidenceMap:
    'Green where there are plenty of points to trust, fading where the scan is thin or blocked.',
  validation:
    'We hide some known ground points, rebuild the surface, and measure how far off it was.',
} as const;

/** Questions the contours actually help answer — lead with these, not the technique. */
export const WHAT_THIS_ANSWERS: ReadonlyArray<string> = [
  'How steep is this slope?',
  'Where would water collect or drain?',
  'Where is a flat spot to build or stand?',
  'How much does the ground rise across this site?',
];

/**
 * Plain-language tooltips for the jargon metrics the Analyse panel
 * surfaces as bare abbreviations (Details expander + status chips). One
 * source of truth so the wording stays honest and consistent — fitness-
 * for-use voice, never a survey-grade claim. The panel imports these and
 * attaches them as hover hints (the same affordance the Inspector's
 * DatasetIntelligenceCard uses for its row tooltips).
 */
export const METRIC_TOOLTIPS = {
  rmse:
    'RMSE — the typical vertical error of the surface, measured against ' +
    'withheld ground checks.',
  nva:
    'NVA-style (hold-out) — the ASPRS 2014 non-vegetated vertical accuracy ' +
    'FORMULA (1.96 × RMSEz) applied to internally withheld ground points, ' +
    'NOT independent survey checkpoints.',
  vva:
    'VVA-style (hold-out) — the ASPRS vegetated vertical accuracy FORMULA ' +
    '(95th percentile), computed over ALL hold-out residuals, NOT ' +
    'vegetated-class checkpoints.',
  densityReference:
    'USGS density reference — which 3DEP nominal-pulse-density floor the ' +
    'measured GROUND-return density clears, as context only. Ground-return ' +
    'density is not nominal pulse density (NPD/ANPD), so this is a reference ' +
    'threshold, never a USGS 3DEP quality-level determination.',
  crs:
    'CRS — coordinate reference system; exports are not georeferenced ' +
    'without it.',
  verticalDatum:
    'Vertical datum — the elevation reference; without it, heights are ' +
    'not tied to a known zero.',
} as const;

/**
 * What the spatially-blocked hold-out figure means beside the random one, for
 * the treatments the two figures ACTUALLY ran under.
 *
 * Three claims were removed from the original wording. It said the blocked pass
 * predicts "across a real gap" — the withheld blocks are data the scan has. It
 * said the blocked figure "runs larger" — a tendency under spatial
 * autocorrelation, not an identity, and not something this project measures. And
 * it called the random figure "optimistic because withheld points sit among
 * their neighbours", attributing the difference to geometry alone.
 *
 * The replacement then asserted the SMRF case for every scan: random
 * re-classifies on the training points, blocked keeps the whole-cloud mask. That
 * is false on the trusted-survey path, where both use the source's own class-2
 * set and no classifier runs at all — so the text announced a treatment
 * difference that did not exist, and hid that this path gives the CLEANER
 * contrast of the two. The wording is now derived from the two scopes.
 */
export function blockedRmseHint(
  randomScope: ClassificationScope,
  blockedScope: ClassificationScope,
): string {
  // ONE treatment sentence, shared with the PDF report. This function carried
  // its own wording of the same three-way case beside blockedTreatmentContrast,
  // so the screen and the document already described one comparison in two
  // spellings the day both were written.
  return 'Spatially-blocked cross-validation: the surface is rebuilt with whole blocks '
    + 'withheld and scored on them, so it measures sensitivity to withholding '
    + 'contiguous geometry rather than scattered points. '
    + `${blockedTreatmentContrast(randomScope, blockedScope)} `
    + 'Both are data-quality diagnostics, not field-checkpoint accuracy.';
}

/**
 * The treatment-contrast sentence alone, for surfaces that supply their own
 * surrounding prose (the PDF report). Same derivation as
 * {@link blockedRmseHint}, so the screen and the document never describe one
 * comparison two different ways.
 */
export function blockedTreatmentContrast(
  randomScope: ClassificationScope,
  blockedScope: ClassificationScope,
): string {
  if (randomScope === blockedScope) {
    return randomScope === 'fixed-source-classification'
      ? 'Both use the source ground classification and neither runs a classifier, so the '
        + 'contrast changes withholding geometry while holding classification treatment fixed.'
      : 'Both use the same ground classification, so the contrast changes withholding '
        + 'geometry alone.';
  }
  return `The two are not like-for-like: the random hold-out uses ${scopeWords(randomScope)} `
    + `and the blocked pass uses ${scopeWords(blockedScope)}, so they estimate different `
    + 'quantities and neither is guaranteed the larger.';
}

/** Plain-language name for a classification treatment, for the hint above. */
function scopeWords(scope: ClassificationScope): string {
  if (scope === 'train-only') return 'ground re-classified on the training points only';
  if (scope === 'fixed-source-classification') return 'the source ground classification';
  return 'the whole-cloud ground classification';
}

/**
 * What each DISPLAY grade means, in plain words. The grade is a CONFIDENCE band
 * (how firmly the line is drawn), not source provenance: a solid line is
 * high-confidence terrain, not a claim that every point under it was measured.
 * Source provenance (measured vs interpolated) is carried separately as typed
 * evidence.
 */
export const GRADE_MEANING: Record<ContourDisplayGrade, string> = {
  solid: 'high-confidence terrain (firm line)',
  dashed: 'lower-confidence terrain (dashed)',
  gap: 'no reliable data — shown as a break',
};

/**
 * The standard provenance line on every Analyse export. Aliases the canonical
 * {@link NOT_SURVEY_GRADE_NOTE} so the panel footer and the export writers
 * state the limitation in exactly one wording.
 */
export { NOT_SURVEY_GRADE_NOTE as NOT_SURVEY_GRADE } from '../export/exportNotes';

/** A plain confidence word for a 0..100 number, aligned to the grade thresholds. */
export function confidenceWord(confidence: number): 'high' | 'moderate' | 'low' {
  if (!Number.isFinite(confidence) || confidence < EVIDENCE_THRESHOLDS.dashed) return 'low';
  if (confidence < EVIDENCE_THRESHOLDS.solid) return 'moderate';
  return 'high';
}

/** Inputs to {@link formatHonestValue}. */
export interface HonestValueParams {
  /** The number to show, or null/NaN when there is no signal. */
  readonly value: number | null;
  /** 0..100 confidence, when known. */
  readonly confidence?: number | null;
  /** Unit suffix, e.g. "m" or "%". */
  readonly units?: string;
  /** Decimal places. Default 2. */
  readonly digits?: number;
  /** Why the value is missing, shown when absent. */
  readonly reasonWhenAbsent?: string;
}

/** A renderable, honest value: a number with confidence, or an explained "—". */
export interface HonestValueDisplay {
  /** "12.30 m" or "—". */
  readonly text: string;
  /** "92% confident (high)" or null when no confidence is known. */
  readonly confidenceText: string | null;
  /** True when no value exists. */
  readonly isAbsent: boolean;
  /** Reason shown alongside an absent value. */
  readonly detail: string | null;
}

/**
 * Format a value the honest way: never a number without its confidence,
 * never a blank without a reason. This is the single function the UI
 * uses so there is no path to render a bare, unqualified figure.
 */
export function formatHonestValue(p: HonestValueParams): HonestValueDisplay {
  const digits = p.digits ?? 2;
  const units = p.units ? ` ${p.units}` : '';
  if (p.value == null || !Number.isFinite(p.value)) {
    return {
      text: '—',
      confidenceText: null,
      isAbsent: true,
      detail: p.reasonWhenAbsent ?? 'No data for this yet.',
    };
  }
  let confidenceText: string | null = null;
  if (p.confidence != null && Number.isFinite(p.confidence)) {
    const c = Math.round(p.confidence);
    confidenceText = `${c}% confident (${confidenceWord(p.confidence)})`;
  }
  return {
    text: `${p.value.toFixed(digits)}${units}`,
    confidenceText,
    isAbsent: false,
    detail: null,
  };
}

/** Plain-language line for one interval option from the gate. */
export function describeIntervalOption(option: IntervalOption, unit = 'm'): string {
  if (option.supported) return `${option.intervalM} ${unit} contours`;
  return `${option.intervalM} ${unit} — unavailable (${option.reason})`;
}

/** Plain-language recommendation from a full gate result. */
export function recommendIntervalText(gate: IntervalGateResult, unit = 'm'): string {
  if (gate.recommendedM == null) {
    return 'No contour interval is reliable for this scan yet.';
  }
  return `Suggested: ${gate.recommendedM} ${unit} contours for this scan.`;
}
