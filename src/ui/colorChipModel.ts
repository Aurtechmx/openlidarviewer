/**
 * colorChipModel.ts
 *
 * Pure descriptor for the Inspector's colour-mode chip rail. Splitting the
 * "which chips, in what state" decision out of the DOM-building method makes the
 * load-bearing rule — the Coverage chip is always shown but DISABLED until a
 * terrain-analysis confidence grid exists — unit-testable without constructing
 * the whole Inspector (which needs a real DOM).
 *
 * Pure: no DOM, no three.js. Deterministic.
 */

import type { ColorMode } from '../render/colorModes';

/** Tooltip shown on the Coverage chip while it is disabled (no analysis yet). */
export const COVERAGE_DISABLED_TITLE = 'Run terrain analysis first';

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
 * analysis-gated `'coverage'` chip ALWAYS appended last so the feature is
 * discoverable. Coverage is disabled (and never active) until `coverageAvailable`.
 *
 * Any `'coverage'` entry already in `modes` is ignored — coverage is appended
 * here exactly once, regardless of input, so callers can pass the raw
 * `availableModes(cloud)` list safely.
 */
export function buildColorChipModel(
  modes: ReadonlyArray<ColorMode>,
  active: ColorMode,
  coverageAvailable: boolean,
): ColorChipDescriptor[] {
  const out: ColorChipDescriptor[] = [];
  for (const mode of modes) {
    if (mode === 'coverage') continue; // appended once below
    out.push({ mode, active: mode === active, disabled: false });
  }
  const coverageDisabled = !coverageAvailable;
  out.push({
    mode: 'coverage',
    // A disabled chip is never highlighted as active, even if `active` is
    // 'coverage' (e.g. a restored session that named coverage before analysis).
    active: !coverageDisabled && active === 'coverage',
    disabled: coverageDisabled,
  });
  return out;
}
