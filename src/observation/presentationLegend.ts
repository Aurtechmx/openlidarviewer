/**
 * presentationLegend.ts — OB-PR-01/04/05, OB-UI-03: the presentation
 * vocabulary that never touches a canonical byte.
 *
 * Pure: no DOM, `three` or `ui/` imports (OB-INT-01). Nothing here reads a
 * `PointCloud` or a ledger row array — it only names how a colour mode,
 * legend, range and probe line are built from values `render/observation/`
 * and `ui/observatory/` (later phases) supply.
 *
 * OB-PR-04: colour is never the only carrier. Every {@link ObservationState}
 * gets a glyph distinct from the others (checked below), so a legend or a
 * probe reads correctly in greyscale or under a colour-vision deficiency —
 * the same discipline `ui/stateChip.ts` applies to the separate
 * measured/preview/... vocabulary. This module cannot import that one (it is
 * DOM-adjacent); the two glyph sets are deliberately independent.
 */
import { OBSERVATION_STATES, type ObservationState } from './types';
import type { ObservationStateDecision } from './stateTable';
import type { ObservationStrengthComponents } from './strength';

// ---------------------------------------------------------------------------
// OB-PR-01 — colour modes
// ---------------------------------------------------------------------------

/** The three per-point colour modes OB-PR-01 names. */
export type ObservationColorMode = 'observationState' | 'observationStrength' | 'observationHitFraction';

/** Which strength component a caller selected, when the mode is `observationStrength` (SPEC §2.5). */
export type StrengthComponentId = keyof ObservationStrengthComponents;

export const STRENGTH_COMPONENT_IDS: readonly StrengthComponentId[] = [
  'sources',
  'angularSpread',
  'incidence',
  'rangeFit',
  'consistency',
];

// ---------------------------------------------------------------------------
// OB-PR-04 — legend: glyph + word, one per state, none shared
// ---------------------------------------------------------------------------

/** One shape-distinct glyph per {@link ObservationState} — none repeats. */
export const OBSERVATION_STATE_GLYPH: Readonly<Record<ObservationState, string>> = {
  SURFACE: '●',
  PARTIAL: '◐',
  OBSERVED_EMPTY: '○',
  CONFLICT: '✱',
  SHADOWED: '▲',
  NO_RETURN_PATH: '△',
  UNADDRESSED: '□',
  NOT_READ: '⊘',
  OUTSIDE_DOMAIN: '·',
};

/** The word shown beside the glyph. */
export const OBSERVATION_STATE_LABEL: Readonly<Record<ObservationState, string>> = {
  SURFACE: 'Surface',
  PARTIAL: 'Partial',
  OBSERVED_EMPTY: 'Observed empty',
  CONFLICT: 'Conflict',
  SHADOWED: 'Shadowed',
  NO_RETURN_PATH: 'No return path',
  UNADDRESSED: 'Unaddressed',
  NOT_READ: 'Not read',
  OUTSIDE_DOMAIN: 'Outside domain',
};

/** Categorical palette, one flat RGB triple (0-1) per state — colour reinforces, never carries alone (OB-PR-04). */
export const OBSERVATION_STATE_RGB: Readonly<Record<ObservationState, readonly [number, number, number]>> = {
  SURFACE: [0.86, 0.86, 0.9],
  PARTIAL: [0.62, 0.78, 0.42],
  OBSERVED_EMPTY: [0.2, 0.45, 0.85],
  CONFLICT: [0.95, 0.2, 0.2],
  SHADOWED: [0.35, 0.35, 0.4],
  NO_RETURN_PATH: [0.6, 0.5, 0.2],
  UNADDRESSED: [0.15, 0.15, 0.18],
  NOT_READ: [0.9, 0.55, 0.05],
  OUTSIDE_DOMAIN: [0.05, 0.05, 0.06],
};

/** One legend entry. */
export interface LegendEntry {
  readonly state: ObservationState;
  readonly glyph: string;
  readonly label: string;
  readonly rgb: readonly [number, number, number];
}

/**
 * The `observationState` legend, in {@link OBSERVATION_STATES} order — every
 * state listed, including ones with zero voxels in the current field
 * (OB-PR-01: "legend lists every state including empty ones").
 */
export function observationStateLegend(): readonly LegendEntry[] {
  return OBSERVATION_STATES.map((state) => ({
    state,
    glyph: OBSERVATION_STATE_GLYPH[state],
    label: OBSERVATION_STATE_LABEL[state],
    rgb: OBSERVATION_STATE_RGB[state],
  }));
}

// ---------------------------------------------------------------------------
// OB-PR-05 — fixed ranges for bounded quantities
// ---------------------------------------------------------------------------

/** A closed range `[min, max]`. */
export interface FixedRange {
  readonly min: number;
  readonly max: number;
}

/** Hit fraction and every strength component are bounded to [0, 1] (OB-PR-05) — never adaptive. */
export const BOUNDED_UNIT_RANGE: FixedRange = { min: 0, max: 1 };

/**
 * The declared range for a colour mode. `observationState` is categorical
 * and carries no range at all (OB-PR-05: "categorical states have no
 * range"); the other two modes are bounded to [0, 1] and never adapt.
 */
export function fixedRangeFor(mode: ObservationColorMode): FixedRange | null {
  if (mode === 'observationState') return null;
  return BOUNDED_UNIT_RANGE;
}

// ---------------------------------------------------------------------------
// OB-UI-03 — voxel probe text
// ---------------------------------------------------------------------------

/** One source's row in the probe, matching OB-UI-03's worked example. */
export interface ProbeSourceLine {
  readonly sourceIndex: number;
  readonly hit: number;
  readonly pass: number;
  readonly behind: number;
  /** Metres to the nearest blocker behind this voxel, or `null` when none was recorded. */
  readonly nearestBlockerMetres: number | null;
}

/** Everything OB-UI-03's example prints for one voxel. */
export interface ProbeContent {
  readonly decision: ObservationStateDecision;
  readonly perSource: readonly ProbeSourceLine[];
  readonly methodTag: string;
  readonly basis: string;
}

/**
 * Renders a voxel probe as plain text, in the order OB-UI-03's worked
 * example shows: state, rule, then one line per source. Pure formatting only
 * — every figure passed in already carries its own unit or is unitless by
 * construction (a count), so nothing here invents one.
 */
export function formatProbeText(content: ProbeContent): string {
  const lines: string[] = [];
  lines.push(`State: ${content.decision.state}`);
  lines.push(`Rule: ${content.decision.detail}`);
  for (const s of content.perSource) {
    const blocker = s.nearestBlockerMetres === null ? 'n/a' : `${s.nearestBlockerMetres.toFixed(2)} m`;
    lines.push(
      `Station ${s.sourceIndex + 1}  hit ${s.hit}  pass ${s.pass}  behind ${s.behind}   nearest blocker ${blocker}`,
    );
  }
  lines.push(`Method: ${content.methodTag}`);
  lines.push(`Basis: ${content.basis}`);
  return lines.join('\n');
}
