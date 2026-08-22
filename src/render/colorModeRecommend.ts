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

/** A colour-mode suggestion with a short, modest rationale. */
export interface ColorModeRecommendation {
  readonly mode: ColorMode;
  readonly reason: string;
}

/**
 * The colour modes worth suggesting for a first look, richest-first, each
 * paired with the reason it wins. Deliberately narrow: the analysis-gated
 * overlays (coverage / confidence) and the vector / scalar modes (normal,
 * gpsTime, returnNumber, density) are absent because an opening default should
 * read plainly, not surprise the analyst with an encoding they didn't ask for.
 */
const CANDIDATES: readonly ColorModeRecommendation[] = [
  { mode: 'rgb', reason: 'true colour — the scan carries per-point RGB' },
  { mode: 'classification', reason: 'classified scan — the ASPRS classes read the structure' },
  { mode: 'intensity', reason: 'intensity — return strength shows surface detail' },
];

/**
 * The always-available fallback. Elevation derives from position, which every
 * cloud has, so `cloudSupportsColorMode` can never reject it — a scan with no
 * colour, class, or intensity channel still gets an honest height ramp.
 */
const FALLBACK: ColorModeRecommendation = {
  mode: 'elevation',
  reason: 'coloured by height — the reliable default when no richer channel exists',
};

/**
 * The fallback when RGB is present but too uniform to read.
 *
 * A distinct reason from {@link FALLBACK}, because "this scan has no colour" and
 * "this scan's colour is a blank sheet" are different facts, and only the second
 * leaves a channel the user may still want to select.
 */
const UNIFORM_RGB_FALLBACK: ColorModeRecommendation = {
  mode: 'elevation',
  reason: 'coloured by height — the scan carries RGB, but too uniform to read',
};

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

  for (const candidate of CANDIDATES) {
    if (candidate.mode === 'rgb' && rgbUniform) continue;
    if (cloudSupportsColorMode(facts, candidate.mode)) return candidate;
  }
  return rgbUniform ? UNIFORM_RGB_FALLBACK : FALLBACK;
}
