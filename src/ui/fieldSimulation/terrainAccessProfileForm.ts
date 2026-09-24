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
 * ── NO PRESET PRESENTED AS SAFE ──────────────────────────────────────────────
 * Every field here is required and blank by default (see
 * `EMPTY_TERRAIN_ACCESS_PROFILE_FORM`); there is no "load a default profile"
 * button and no vehicle preset (a "light UTV", a "wheelchair", etc.) that
 * would otherwise silently smuggle unreviewed numbers into a run and imply
 * they were validated for the reader's actual platform. Every limit in the
 * form is exactly the value the reader typed, or the form refuses to build a
 * profile from it at all.
 *
 * Pure: no DOM.
 */

import { validateProfile, type ProfileProblem, type TerrainAccessProfile } from '../../simulation/terrainAccess/terrainAccessTypes';

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
}

/** Blank form: every required field empty, no field pre-filled with a number
 * that could be read as a recommendation. */
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
});

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

/**
 * Parse and validate the form. Every required field is checked for being a
 * finite number before {@link validateProfile}'s own cross-field/range checks
 * run, so a reader sees "this field is empty" separately from "this field's
 * value is out of range".
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

  if (problems.length > 0) return { ok: false, problems };

  const profile: TerrainAccessProfile = {
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
  };

  const crossFieldProblems: readonly ProfileProblem[] = validateProfile(profile);
  if (crossFieldProblems.length > 0) {
    return { ok: false, problems: crossFieldProblems.map((p) => ({ field: p.field, reason: p.reason })) };
  }

  return { ok: true, profile };
}
