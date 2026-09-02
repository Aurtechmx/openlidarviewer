/**
 * colorModeRecommend.ts
 *
 * A cheap, honest "recommended colour" heuristic: pick the colour mode that
 * best shows a freshly loaded scan from the attributes it actually carries.
 * True colour reads most naturally when the scan has it; failing that, an
 * ASPRS classification tells the richest story; failing that, intensity shows
 * surface detail; and every scan can always fall back to elevation, which
 * derives from position alone. It is a suggestion, not a claim — the reason
 * string keeps it modest.
 *
 * Pure — no DOM, no three.js — unit-tested in Node. Mirrors the shape and doc
 * style of `camera/recommendView.ts`.
 */

import type { ColorMode } from './colorModes';
import { cloudSupportsColorMode, type ColorModeCloudFacts } from './colorModeSupport';
import { readRgbReadability } from './rgbReadability';
import { classificationCoverage } from './class/classificationCoverage';
import { isDerivedColorMode } from './colorModeProvenance';

/** A colour-mode suggestion with a short, modest rationale. */
export interface ColorModeRecommendation {
  readonly mode: ColorMode;
  readonly reason: string;
  /**
   * True when the colour on screen is a palette this viewer applied to a
   * scalar, false when it is the colour the scan itself recorded per point.
   *
   * Only `rgb` is measured colour. Height, intensity and class all render
   * through a ramp or a class palette chosen here, so the hue carries no
   * radiometric meaning and must never be read as an attribute of the survey.
   * A caller that shows the resulting mode is expected to say so: a derived
   * ramp presented without that qualifier invites the viewer to treat a
   * rendering choice as measured data.
   */
  readonly derived: boolean;
}

/** Stamp `derived` from the single shared predicate, so the two never drift. */
const withProvenance = (
  r: Omit<ColorModeRecommendation, 'derived'>,
): ColorModeRecommendation => ({ ...r, derived: isDerivedColorMode(r.mode) });

/**
 * The colour modes worth suggesting for a first look, richest-first, each
 * paired with the reason it wins. Deliberately narrow: the analysis-gated
 * overlays (coverage / confidence) and the vector / scalar modes (normal,
 * gpsTime, returnNumber, density) are absent because an opening default should
 * read plainly, not surprise the analyst with an encoding they didn't ask for.
 */
const CANDIDATES: readonly ColorModeRecommendation[] = (
  [
    { mode: 'rgb', reason: 'true colour — the scan carries per-point RGB' },
    { mode: 'classification', reason: 'classified scan — the ASPRS classes read the structure' },
    { mode: 'intensity', reason: 'intensity — return strength shows surface detail' },
  ] satisfies ReadonlyArray<Omit<ColorModeRecommendation, 'derived'>>
).map(withProvenance);

/**
 * The share of points that must carry a real producer class before
 * classification is worth opening into.
 *
 * Below this the class channel is present and renderable but nearly all one
 * colour, which is the same failure the RGB readability check guards against.
 * The value is a judgement, not a measurement: two fifths classified is enough
 * for the classes to shape what the analyst sees, and an airborne tile whose
 * only producer class is a thin ground return sits far below it.
 */
const MIN_CLASSIFIED_FRACTION = 0.4;

/**
 * The always-available fallback. Elevation derives from position, which every
 * cloud has, so `cloudSupportsColorMode` can never reject it — a scan with no
 * colour, class, or intensity channel still gets an honest height ramp.
 */
const FALLBACK: ColorModeRecommendation = withProvenance({
  mode: 'elevation',
  reason: 'coloured by height — the reliable default when no richer channel exists',
});

/**
 * The fallback when RGB is present but too uniform to read.
 *
 * A distinct reason from {@link FALLBACK}, because "this scan has no colour" and
 * "this scan's colour is a blank sheet" are different facts, and only the second
 * leaves a channel the user may still want to select.
 */
const UNIFORM_RGB_FALLBACK: ColorModeRecommendation = withProvenance({
  mode: 'elevation',
  reason: 'coloured by height — the scan carries RGB, but too uniform to read',
});

/**
 * The fallback when a classification channel is present but almost nothing in
 * it is classified.
 *
 * An airborne tile typically carries a full class array in which all but a few
 * per cent of points are ASPRS 0 or 1, so opening into classification paints
 * the scene one flat grey and reads as a broken render rather than as absent
 * labelling. Height is preferred over intensity here even though intensity
 * ranks higher in {@link CANDIDATES}: airborne intensity is uncalibrated and
 * often low in contrast, whereas a height ramp derives from position, is
 * always present, and shows terrain immediately. Class stays selectable; it
 * just stops being the opening choice.
 */
const DEGENERATE_CLASS_FALLBACK: ColorModeRecommendation = withProvenance({
  mode: 'elevation',
  reason: 'coloured by height — the scan carries classes, but too few points are classified to read',
});

/**
 * True when `facts` carries a classification array whose points are almost all
 * unclassified (ASPRS 0 Created / 1 Unclassified).
 *
 * The class array's own length is the denominator: it is index-aligned with the
 * points, so it counts exactly the points the class view would colour.
 */
function classificationTooSparseToRead(facts: ColorModeCloudFacts): boolean {
  const cls = facts.classification;
  if (cls == null || cls.length === 0) return false;
  const { producer } = classificationCoverage(cls, cls.length);
  return producer / cls.length < MIN_CLASSIFIED_FRACTION;
}

/**
 * Recommend a colour mode for a scan from the attributes it carries (`facts`
 * are the cloud's own attribute arrays — RGB, classification, intensity, …).
 * Deterministic and conservative: prefer RGB, then classification, then
 * intensity, and otherwise fall back to elevation.
 *
 * Every candidate is gated through {@link cloudSupportsColorMode}, so the
 * result is NEVER a mode the cloud cannot render — asking the renderer for a
 * missing channel produces a uniform wash the user reads as a broken render
 * rather than as absent data.
 */
export function recommendColorMode(facts: ColorModeCloudFacts): ColorModeRecommendation {
  // RGB is measured, not merely counted: a colour array in which every point is
  // within a few levels of white is present, renderable and unreadable, and
  // opening a scan into it shows a blank sheet. The mode stays selectable; it
  // just stops being the opening choice.
  const rgbUniform =
    cloudSupportsColorMode(facts, 'rgb') &&
    readRgbReadability(facts.colors).verdict === 'uniform';

  // Classification is measured the same way, and for the same reason: a class
  // array that labels almost nothing is present and renderable but paints one
  // flat colour. Checked before the loop because the answer is not "try the
  // next channel down" but "take the height ramp", per DEGENERATE_CLASS_FALLBACK.
  const classUnreadable = classificationTooSparseToRead(facts);

  for (const candidate of CANDIDATES) {
    if (candidate.mode === 'rgb' && rgbUniform) continue;
    if (candidate.mode === 'classification') {
      if (classUnreadable) return DEGENERATE_CLASS_FALLBACK;
      if (cloudSupportsColorMode(facts, candidate.mode)) return candidate;
      continue;
    }
    if (cloudSupportsColorMode(facts, candidate.mode)) return candidate;
  }
  return rgbUniform ? UNIFORM_RGB_FALLBACK : FALLBACK;
}
