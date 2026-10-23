/**
 * terrainAccessProfileForm.ts — pure parse/validate for the mobility-profile
 * form, kept apart from the DOM so the rules governing what makes a profile
 * usable are unit-testable without a browser.
 *
 * ── WHY THE FORM IS DEGREES BUT THE PROFILE IS TANGENTS ─────────────────────
 * `terrainAccessTypes.ts` documents why `TerrainAccessProfile.maxLongitudinalGrade`
 * / `maxCrossSlope` are rise/run tangents: comparing a tangent against a
 * tangent needs no trigonometry in the A* hot path. A form field asking a
 * person to type a tangent is asking them to do that trigonometry themselves,
 * silently, which is exactly the kind of hidden unit conversion §21 of the
 * governing prompt asks a Terrain Access UI not to have. So the form's own
 * fields are DEGREES (the unit label sits next to every one of them) and this
 * module does the one conversion, once, in an auditable place.
 *
 * ── EXAMPLES, NEVER A HIDDEN DEFAULT ─────────────────────────────────────────
 * The form opens blank: every required field is empty (see
 * `EMPTY_TERRAIN_ACCESS_PROFILE_FORM`) and nothing is pre-filled until the
 * reader picks one of the example profiles in {@link TERRAIN_ACCESS_EXAMPLES}.
 * Picking one fills every required field visibly, in the same inputs a typed
 * value goes into, and every field stays editable. The profile name says
 * "(example)", the line under the buttons says the values are examples to
 * confirm for the reader's own platform, not a rating or a safety limit, and
 * the parsed profile records which example it started from and whether any
 * limit or policy was changed (`TerrainAccessProfile.origin`), so the run
 * record and the export say the same. Picking an example never runs anything:
 * the reader still applies the profile. Every limit that reaches a run is a
 * value shown in the form when it was applied, or the form refuses to build
 * a profile at all.
 *
 * Pure: no DOM.
 */

import {
  validateProfile, type ProfileProblem, type TerrainAccessProfile, type TerrainAccessProfileOrigin,
} from '../../simulation/terrainAccess/terrainAccessTypes';

/** The example profiles the form offers; see {@link TERRAIN_ACCESS_EXAMPLES}. */
export type TerrainAccessExampleId = 'walker' | 'atv' | '4x4';

/** Every field of the form, as the raw strings a text input holds. */
export interface TerrainAccessProfileFormValues {
  readonly name: string;
  readonly maxLongitudinalGradeDeg: string;
  readonly maxCrossSlopeDeg: string;
  readonly maxStepHeightM: string;
  readonly maxRuggednessEnabled: boolean;
  readonly maxRuggedness: string;
  readonly vehicleWidthM: string;
  readonly vehicleLengthEnabled: boolean;
  readonly vehicleLengthM: string;
  readonly minimumTerrainConfidence: string;
  readonly unknownPolicy: 'block' | 'penalize';
  readonly obstacleHeightEnabled: boolean;
  readonly obstacleHeightThresholdM: string;
  readonly evidenceGapPolicy: 'conservative' | 'exploratory';
  /** The example the fields were last filled from, or null for a form filled by hand. */
  readonly example: TerrainAccessExampleId | null;
}

/** Blank form: every required field empty, no field pre-filled with a number
 * that could be read as a recommendation. The form's initial state. */
export const EMPTY_TERRAIN_ACCESS_PROFILE_FORM: TerrainAccessProfileFormValues = Object.freeze({
  name: '',
  maxLongitudinalGradeDeg: '',
  maxCrossSlopeDeg: '',
  maxStepHeightM: '',
  maxRuggednessEnabled: false,
  maxRuggedness: '',
  vehicleWidthM: '',
  vehicleLengthEnabled: false,
  vehicleLengthM: '',
  minimumTerrainConfidence: '',
  unknownPolicy: 'block',
  obstacleHeightEnabled: false,
  obstacleHeightThresholdM: '',
  // Allow and disclose: the run card and the record state which was used.
  evidenceGapPolicy: 'exploratory',
  example: null,
});

/** One example starting profile, in the form's own units. */
export interface TerrainAccessExample {
  readonly id: TerrainAccessExampleId;
  /** The button's text, and the start of the profile name. */
  readonly label: string;
  /** Degrees. */
  readonly maxLongitudinalGradeDeg: number;
  /** Degrees. */
  readonly maxCrossSlopeDeg: number;
  /** Metres. */
  readonly maxStepHeightM: number;
  /** Metres. */
  readonly vehicleWidthM: number;
  /** 0–100. */
  readonly minimumTerrainConfidence: number;
}

const frozenExample = (e: TerrainAccessExample): TerrainAccessExample => Object.freeze(e);

/**
 * The example starting profiles: moderate figures for general off-path use,
 * for the reader to confirm for their own platform. None is a rating, a test
 * result or a figure from one vehicle's specification. Each leaves every
 * optional limit off, blocks weak-evidence cells and keeps the form's default
 * evidence-gap policy, so an example sets nothing the five required fields
 * and the name do not show.
 *
 * Basis:
 *  - Walker: general off-path walking, not an accessibility limit (a ramp
 *    standard's 1:12, about 4.8°, would block most open ground). 20° (36%)
 *    is a steep but walkable climb on open ground; 15° (27%) across a slope
 *    keeps a margin on loose or wet ground; 0.30 m is a high single step-up
 *    (a stair riser is about 0.18 m); 0.6 m is adult shoulder width (about
 *    0.45 m) with room for arm swing. Minimum confidence 40, below the
 *    vehicles' 50, since a person picks their own footing.
 *  - ATV: 20° (36%) is a moderate climb for a quad bike. Its high centre of
 *    gravity and narrow track make side slopes the main rollover risk, so the
 *    cross slope (12°, 21%) is set below the grade. 0.20 m stays under a
 *    typical ATV's ground clearance (about 0.25 m); 1.2 m is a typical
 *    utility ATV's overall width.
 *  - 4x4 vehicle: 25° (47%) is a moderate climb for a four-wheel-drive
 *    vehicle, with the cross slope (15°, 27%) set lower for the same rollover
 *    reason. 0.30 m is below the radius of a typical off-road tyre (about
 *    0.37 m), the usual rule-of-thumb ceiling for a wheel climbing a ledge;
 *    2.0 m is a full-size 4x4's body width.
 *
 * The step limit is compared with the height difference between neighbouring
 * cells, so on a coarse grid it also limits grade.
 */
export const TERRAIN_ACCESS_EXAMPLES: readonly TerrainAccessExample[] = Object.freeze([
  frozenExample({
    id: 'walker', label: 'Walker',
    maxLongitudinalGradeDeg: 20, maxCrossSlopeDeg: 15, maxStepHeightM: 0.3, vehicleWidthM: 0.6, minimumTerrainConfidence: 40,
  }),
  frozenExample({
    id: 'atv', label: 'ATV',
    maxLongitudinalGradeDeg: 20, maxCrossSlopeDeg: 12, maxStepHeightM: 0.2, vehicleWidthM: 1.2, minimumTerrainConfidence: 50,
  }),
  frozenExample({
    id: '4x4', label: '4x4 vehicle',
    maxLongitudinalGradeDeg: 25, maxCrossSlopeDeg: 15, maxStepHeightM: 0.3, vehicleWidthM: 2.0, minimumTerrainConfidence: 50,
  }),
]);

/** The line shown under the example buttons. */
export const TERRAIN_ACCESS_EXAMPLES_NOTE = 'Example values to confirm for your own platform, not a rating or a safety limit.';

function exampleById(id: string): TerrainAccessExample | null {
  return TERRAIN_ACCESS_EXAMPLES.find((e) => e.id === id) ?? null;
}

/** The profile name an example fills in: "Walker (example)". */
export function terrainAccessExampleName(example: TerrainAccessExample): string {
  return `${example.label} (example)`;
}

/**
 * The form as one example fills it: the name and every required field set,
 * every optional limit off and empty, the policies at the form's defaults.
 */
export function terrainAccessExampleForm(id: TerrainAccessExampleId): TerrainAccessProfileFormValues {
  const example = exampleById(id);
  if (!example) throw new RangeError(`terrainAccessExampleForm: unknown example "${id}"`);
  return Object.freeze({
    ...EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
    name: terrainAccessExampleName(example),
    maxLongitudinalGradeDeg: String(example.maxLongitudinalGradeDeg),
    maxCrossSlopeDeg: String(example.maxCrossSlopeDeg),
    maxStepHeightM: String(example.maxStepHeightM),
    vehicleWidthM: String(example.vehicleWidthM),
    minimumTerrainConfidence: String(example.minimumTerrainConfidence),
    example: id,
  });
}

/** One field's problem — either "not a usable number" or a cross-field reason
 * from {@link validateProfile}. */
export interface TerrainAccessProfileFormProblem {
  readonly field: string;
  readonly reason: string;
}

export type TerrainAccessProfileFormResult =
  | { readonly ok: true; readonly profile: TerrainAccessProfile }
  | { readonly ok: false; readonly problems: readonly TerrainAccessProfileFormProblem[] };

/** Parse one required numeric field, `null` and a problem when it is not a finite number. */
function parseRequired(field: string, raw: string, problems: TerrainAccessProfileFormProblem[]): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    problems.push({ field, reason: 'is required' });
    return null;
  }
  const v = Number(trimmed);
  if (!Number.isFinite(v)) {
    problems.push({ field, reason: `must be a number; got "${raw}"` });
    return null;
  }
  return v;
}

const degToTan = (deg: number): number => Math.tan((deg * Math.PI) / 180);

/** Whether any limit or policy of `profile` differs from what `example` filled in. The name is not compared. */
function editedFromExample(profile: TerrainAccessProfile, example: TerrainAccessExample): boolean {
  const blank = EMPTY_TERRAIN_ACCESS_PROFILE_FORM;
  return profile.maxLongitudinalGrade !== degToTan(example.maxLongitudinalGradeDeg)
    || profile.maxCrossSlope !== degToTan(example.maxCrossSlopeDeg)
    || profile.maxStepHeight !== example.maxStepHeightM
    || profile.vehicleWidth !== example.vehicleWidthM
    || profile.minimumTerrainConfidence !== example.minimumTerrainConfidence
    || profile.maxRuggedness !== null
    || profile.vehicleLength !== null
    || profile.obstacleHeightThreshold !== null
    || profile.unknownPolicy !== blank.unknownPolicy
    || profile.evidenceGapPolicy !== blank.evidenceGapPolicy;
}

/**
 * Parse and validate the form. Every required field is checked for being a
 * finite number before {@link validateProfile}'s own cross-field/range checks
 * run, so a reader sees "this field is empty" separately from "this field's
 * value is out of range". A form filled from an example yields a profile
 * whose `origin` names the example and says whether any limit was changed.
 */
export function parseTerrainAccessProfileForm(values: TerrainAccessProfileFormValues): TerrainAccessProfileFormResult {
  const problems: TerrainAccessProfileFormProblem[] = [];

  const name = values.name.trim();
  if (name === '') problems.push({ field: 'name', reason: 'is required' });

  const maxLongitudinalGradeDeg = parseRequired('maxLongitudinalGradeDeg', values.maxLongitudinalGradeDeg, problems);
  const maxCrossSlopeDeg = parseRequired('maxCrossSlopeDeg', values.maxCrossSlopeDeg, problems);
  const maxStepHeightM = parseRequired('maxStepHeightM', values.maxStepHeightM, problems);
  const vehicleWidthM = parseRequired('vehicleWidthM', values.vehicleWidthM, problems);
  const minimumTerrainConfidence = parseRequired('minimumTerrainConfidence', values.minimumTerrainConfidence, problems);

  let maxRuggedness: number | null = null;
  if (values.maxRuggednessEnabled) {
    maxRuggedness = parseRequired('maxRuggedness', values.maxRuggedness, problems);
  }

  let vehicleLength: number | null = null;
  if (values.vehicleLengthEnabled) {
    vehicleLength = parseRequired('vehicleLengthM', values.vehicleLengthM, problems);
  }

  let obstacleHeightThreshold: number | null = null;
  if (values.obstacleHeightEnabled) {
    obstacleHeightThreshold = parseRequired('obstacleHeightThresholdM', values.obstacleHeightThresholdM, problems);
  }

  const example = values.example == null ? null : exampleById(values.example);
  if (values.example != null && !example) problems.push({ field: 'example', reason: `is not a known example; got "${values.example}"` });

  if (problems.length > 0) return { ok: false, problems };

  const limits: TerrainAccessProfile = {
    name,
    maxLongitudinalGrade: degToTan(maxLongitudinalGradeDeg as number),
    maxCrossSlope: degToTan(maxCrossSlopeDeg as number),
    maxStepHeight: maxStepHeightM as number,
    maxRuggedness,
    vehicleWidth: vehicleWidthM as number,
    vehicleLength,
    minimumTerrainConfidence: minimumTerrainConfidence as number,
    unknownPolicy: values.unknownPolicy,
    obstacleHeightThreshold,
    evidenceGapPolicy: values.evidenceGapPolicy,
  };
  const origin: TerrainAccessProfileOrigin | null = example
    ? { example: example.id, edited: editedFromExample(limits, example) }
    : null;
  // Absent rather than undefined for a profile entered by hand, so its record is unchanged.
  const profile: TerrainAccessProfile = origin ? { ...limits, origin } : limits;

  const crossFieldProblems: readonly ProfileProblem[] = validateProfile(profile);
  if (crossFieldProblems.length > 0) {
    return { ok: false, problems: crossFieldProblems.map((p) => ({ field: p.field, reason: p.reason })) };
  }

  return { ok: true, profile };
}

/** The on-screen label for a problem's field key, from either the form or the profile validator. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Profile name',
  maxLongitudinalGradeDeg: 'Max longitudinal grade',
  maxLongitudinalGrade: 'Max longitudinal grade',
  maxCrossSlopeDeg: 'Max cross slope',
  maxCrossSlope: 'Max cross slope',
  maxStepHeightM: 'Max step height',
  maxStepHeight: 'Max step height',
  vehicleWidthM: 'Vehicle width',
  vehicleWidth: 'Vehicle width',
  minimumTerrainConfidence: 'Minimum terrain confidence',
  maxRuggedness: 'Max ruggedness (VRM)',
  vehicleLengthM: 'Vehicle length',
  vehicleLength: 'Vehicle length',
  obstacleHeightThresholdM: 'Obstacle height threshold',
  obstacleHeightThreshold: 'Obstacle height threshold',
  unknownPolicy: 'Weak-evidence policy',
  evidenceGapPolicy: 'Evidence-gap policy',
  example: 'Example',
  origin: 'Example',
};

/** A problem as the form shows it: "Vehicle width is required". Unknown keys fall back to the key. */
export function describeProfileProblem(problem: { readonly field: string; readonly reason: string }): string {
  return `${FIELD_LABELS[problem.field] ?? problem.field} ${problem.reason}`;
}

/**
 * Where a recorded profile's values came from, in words: "Walker example, no
 * value changed". Null for a profile entered by hand or a record without the
 * field. Reads the record's own profile, so it takes `unknown`.
 */
export function profileOriginText(profile: unknown): string | null {
  const origin = (profile as { readonly origin?: Partial<TerrainAccessProfileOrigin> } | null)?.origin;
  if (!origin || typeof origin.example !== 'string') return null;
  const label = exampleById(origin.example)?.label ?? origin.example;
  return `${label} example, ${origin.edited === true ? 'then edited' : 'no value changed'}`;
}
