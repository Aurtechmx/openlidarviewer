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

import { EVIDENCE_THRESHOLDS, type EvidenceGrade } from '../ground/cellConfidence';
import type { IntervalOption, IntervalGateResult } from './intervalGate';

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
  qualityLevel:
    'USGS 3DEP Quality Level — the level the surface meets on point ' +
    'density and vertical accuracy together. Estimated: the RMSEz leg is ' +
    'measured on internally withheld points (hold-out), not the independent ' +
    'checkpoints a 3DEP assessment requires.',
  crs:
    'CRS — coordinate reference system; exports are not georeferenced ' +
    'without it.',
  verticalDatum:
    'Vertical datum — the elevation reference; without it, heights are ' +
    'not tied to a known zero.',
} as const;

/** What each evidence grade means, in plain words. */
export const GRADE_MEANING: Record<EvidenceGrade, string> = {
  solid: 'measured terrain',
  dashed: 'interpolated — fewer points here',
  gap: 'no reliable data — shown as a break',
};

/** The standard provenance line on every Analyse export. */
export const NOT_SURVEY_GRADE =
  'Not survey-grade unless validated against ground-truth control.';

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
