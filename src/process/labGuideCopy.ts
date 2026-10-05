/**
 * labGuideCopy.ts
 *
 * The plain-language copy the three labs share with the Analyse home: one
 * purpose line per lab, its numbered stages, and the readiness checklist
 * rule. Pure and DOM-free, so the home row, the lab header and the unit
 * tests read the same strings.
 */

import { interpolatedShareText, type FlowTerrainCaveat } from './flowTerrainCaveat';

export type LabId = 'flow-pulse' | 'terrain-access' | 'observatory';

export const LAB_NAME: Readonly<Record<LabId, string>> = {
  'flow-pulse': 'Flow Pulse',
  'terrain-access': 'Terrain Access',
  observatory: 'Observatory',
};

/** One line: what the lab is for, shown at its top and on its Analyse home row. */
export const LAB_PURPOSE: Readonly<Record<LabId, string>> = {
  'flow-pulse': 'See which way water would run downhill over the ground surface, and which area drains to a point. Counts cells, not rainfall.',
  'terrain-access': 'Screen a possible route over the ground for a vehicle or walker you describe. Not a safety guarantee.',
  observatory: 'Shows what the scanner saw from each setup, what was hidden behind objects, and where another setup would help.',
};

/** The numbered stages shown at the top of each lab, in order. */
export const LAB_STAGES: Readonly<Record<LabId, readonly string[]>> = {
  'flow-pulse': ['Ground surface', 'Flow routed', 'Pick a cell', 'Read or export'],
  'terrain-access': ['Ground surface', 'Describe the vehicle', 'Pick start and goal', 'Run the route', 'Read or export'],
  observatory: ['Scanner setups', 'Run', 'Read the evidence'],
};

/** The Observatory's refusal and home-row text when the scan declares no stations. */
export const NEEDS_STATIONS = 'Needs scanner setups (station positions), for example from PTX files.';

/** The text the lab shows in place of a refusal when the ground surface is missing. */
export const NEEDS_GROUND = 'This lab reads the ground surface, which comes from a terrain run. Run terrain analysis, then come back here.';

export interface ReadinessItem {
  readonly label: string;
  readonly met: boolean;
  /** Blocks the run when not met; a non-blocking item only changes what is reported. */
  readonly blocking: boolean;
  /** One sentence shown beside the item. */
  readonly note: string;
  /** Not checked yet: it waits on an earlier item. */
  readonly pending?: boolean;
}

/**
 * The prerequisites a Field Simulation lab checks before its controls. The
 * units rule matches each runner: Terrain Access refuses without known units,
 * Flow Pulse still routes and withholds the area figures.
 */
export function labReadiness(
  lab: 'flow-pulse' | 'terrain-access',
  ground: boolean,
  unitsKnown: boolean,
  groundCaveat: FlowTerrainCaveat | null = null,
): ReadinessItem[] {
  const ta = lab === 'terrain-access';
  return [
    groundItem(ground, groundCaveat),
    {
      label: 'Units known',
      met: ground && unitsKnown,
      blocking: ta,
      pending: !ground,
      note: !ground
        ? 'Checked once the ground surface exists.'
        : unitsKnown
          ? 'Distances and heights are in known units.'
          : ta
            ? 'Missing: grades and distances need known units. Assign a coordinate system to the scan.'
            : 'Not known: areas are withheld; cell counts still work. A scan in geographic degrees with no known latitude does not run.',
    },
  ];
}

/**
 * The ground-surface row. A terrain run whose surface verdict is Blocked or
 * Preview exists but is not usable, so the row reads as not met (the "!"
 * glyph) without blocking: the lab still routes and labels the result.
 */
function groundItem(ground: boolean, caveat: FlowTerrainCaveat | null): ReadinessItem {
  const label = 'Ground surface (terrain run)';
  if (!ground) return { label, met: false, blocking: true, note: 'Missing: no terrain run yet.' };
  if (caveat) {
    return { label, met: false, blocking: false, note: `${caveat.verdict} terrain run: ${interpolatedShareText(caveat)}.` };
  }
  return { label, met: true, blocking: true, note: 'Read from the latest terrain run.' };
}

/** The first blocking item not met, or null when the lab can run. */
export function firstBlocker(items: readonly ReadinessItem[]): ReadinessItem | null {
  return items.find((i) => i.blocking && !i.met) ?? null;
}

/** A tangent grade in degrees, one decimal, for display next to the tangent value. */
export function tangentToDegrees(tangent: number): string {
  return `${(Math.atan(tangent) * 180 / Math.PI).toFixed(1)}°`;
}

/** Plain labels for the Observatory's state codes; the codes stay beside them. */
export const OBSERVATION_PLAIN: Readonly<Record<string, string>> = {
  SURFACE: 'Surface: most beams through here hit something',
  PARTIAL: 'Partial: some evidence, not clearly solid or empty',
  OBSERVED_EMPTY: 'Observed empty: beams passed through with no hits',
  CONFLICT: 'Conflict: one setup reads solid, another reads empty',
  SHADOWED: 'Shadowed: behind something the scanner hit',
  NO_RETURN_PATH: 'No return: a beam was fired here but nothing came back',
  UNADDRESSED: 'Unaddressed: no setup reached here',
  NOT_READ: 'Not read: beams reached here but were not decoded',
  OUTSIDE_DOMAIN: 'Outside: beyond the area this run covers',
};
