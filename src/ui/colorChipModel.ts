/**
 * colorChipModel.ts
 *
 * Pure descriptor for the Inspector's colour-mode chip rail. Splitting the
 * "which chips, in what state" decision out of the DOM-building method makes the
 * load-bearing rule — the analysis-gated chips (Coverage, and its
 * colourblind-safe twin Confidence) are always shown but DISABLED until a
 * terrain-analysis confidence grid exists — unit-testable without constructing
 * the whole Inspector (which needs a real DOM).
 *
 * Pure: no DOM, no three.js. Deterministic.
 */

import type { ColorMode } from '../render/colorModes';

/** Tooltip shown on a gated chip while it is disabled (no analysis yet). */
export const COVERAGE_DISABLED_TITLE = 'Run terrain analysis first';

/**
 * The analysis-gated trust-overlay modes, in rail order. Both sample the same
 * DTM-confidence grid, so they share one availability gate.
 */
export const ANALYSIS_GATED_MODES: ReadonlyArray<ColorMode> = ['coverage', 'confidence'];

/** One chip in the colour-mode rail. */
export interface ColorChipDescriptor {
  readonly mode: ColorMode;
  /** True when this chip is the active colour mode (never true while disabled). */
  readonly active: boolean;
  /** True when the chip is shown greyed-out and ignores clicks. */
  readonly disabled: boolean;
}

/**
 * Build the chip rail for `modes` (the per-cloud data-driven modes), with the
 * analysis-gated `'coverage'` + `'confidence'` chips ALWAYS appended last so
 * the features are discoverable. Both are disabled (and never active) until
 * `coverageAvailable` — they read the same post-analysis grid.
 *
 * Any gated entry already in `modes` is ignored — each is appended here
 * exactly once, regardless of input, so callers can pass the raw
 * `availableModes(cloud)` list safely.
 */
export function buildColorChipModel(
  modes: ReadonlyArray<ColorMode>,
  active: ColorMode,
  coverageAvailable: boolean,
): ColorChipDescriptor[] {
  const out: ColorChipDescriptor[] = [];
  for (const mode of modes) {
    if (ANALYSIS_GATED_MODES.includes(mode)) continue; // appended once below
    out.push({ mode, active: mode === active, disabled: false });
  }
  const disabled = !coverageAvailable;
  for (const mode of ANALYSIS_GATED_MODES) {
    out.push({
      mode,
      // A disabled chip is never highlighted as active, even if `active` names
      // it (e.g. a restored session that named coverage before analysis).
      active: !disabled && active === mode,
      disabled,
    });
  }
  return out;
}
