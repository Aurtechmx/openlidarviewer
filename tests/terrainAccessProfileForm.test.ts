/**
 * terrainAccessProfileForm.test.ts: the mobility-profile form's own parse/
 * validate rules — required fields, numeric parsing, the degrees→tangent
 * conversion, that the form opens blank (§21), and that an example profile
 * fills it only when picked, is labelled as an example and is recorded as one.
 */
import { describe, expect, it } from 'vitest';

import {
  describeProfileProblem,
  EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
  parseTerrainAccessProfileForm,
  profileOriginText,
  TERRAIN_ACCESS_EXAMPLES,
  TERRAIN_ACCESS_EXAMPLES_NOTE,
  terrainAccessExampleForm,
  type TerrainAccessExampleId,
  type TerrainAccessProfileFormValues,
} from '../src/ui/fieldSimulation/terrainAccessProfileForm';
import { validateProfile, type TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';

const tan = (deg: number): number => Math.tan((deg * Math.PI) / 180);

const FILLED: TerrainAccessProfileFormValues = {
  ...EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
  name: 'Illustrative — confirm for your platform',
  maxLongitudinalGradeDeg: '20',
  maxCrossSlopeDeg: '15',
  maxStepHeightM: '0.3',
  vehicleWidthM: '1.8',
  minimumTerrainConfidence: '60',
};

describe('EMPTY_TERRAIN_ACCESS_PROFILE_FORM', () => {
  it('is the initial state: no value in any required field and no example picked (§21)', () => {
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.example).toBeNull();
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.name).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxLongitudinalGradeDeg).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxCrossSlopeDeg).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxStepHeightM).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.vehicleWidthM).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.minimumTerrainConfidence).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxRuggednessEnabled).toBe(false);
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.vehicleLengthEnabled).toBe(false);
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.obstacleHeightEnabled).toBe(false);
    // No example's numbers hide in the blank form.
    for (const ex of TERRAIN_ACCESS_EXAMPLES) {
      expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM).not.toEqual(terrainAccessExampleForm(ex.id));
    }
  });

  it('refuses to build a profile with every field blank', () => {
    const result = parseTerrainAccessProfileForm(EMPTY_TERRAIN_ACCESS_PROFILE_FORM);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.problems.map((p) => p.field);
      expect(fields).toContain('name');
      expect(fields).toContain('maxLongitudinalGradeDeg');
      expect(fields).toContain('maxCrossSlopeDeg');
      expect(fields).toContain('maxStepHeightM');
      expect(fields).toContain('vehicleWidthM');
      expect(fields).toContain('minimumTerrainConfidence');
    }
  });

  it('accepts a fully declared profile and converts degrees to tangents', () => {
    const result = parseTerrainAccessProfileForm(FILLED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.name).toBe(FILLED.name);
      expect(result.profile.maxLongitudinalGrade).toBeCloseTo(Math.tan((20 * Math.PI) / 180), 10);
      expect(result.profile.maxCrossSlope).toBeCloseTo(Math.tan((15 * Math.PI) / 180), 10);
      expect(result.profile.maxStepHeight).toBe(0.3);
      expect(result.profile.vehicleWidth).toBe(1.8);
      expect(result.profile.minimumTerrainConfidence).toBe(60);
      expect(result.profile.maxRuggedness).toBeNull();
      expect(result.profile.vehicleLength).toBeNull();
      expect(result.profile.obstacleHeightThreshold).toBeNull();
      expect(result.profile.unknownPolicy).toBe('block');
      // Typed by hand: no origin key at all, so the record is unchanged.
      expect('origin' in result.profile).toBe(false);
    }
  });

  it('rejects a non-numeric value in a required field', () => {
    const result = parseTerrainAccessProfileForm({ ...FILLED, maxStepHeightM: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.field === 'maxStepHeightM')).toBe(true);
    }
  });

  it('only requires the optional-toggle fields when their toggle is enabled', () => {
    const withRuggedness = parseTerrainAccessProfileForm({
      ...FILLED, maxRuggednessEnabled: true, maxRuggedness: '',
    });
    expect(withRuggedness.ok).toBe(false);
    if (!withRuggedness.ok) expect(withRuggedness.problems.some((p) => p.field === 'maxRuggedness')).toBe(true);

    const enabledAndFilled = parseTerrainAccessProfileForm({
      ...FILLED, maxRuggednessEnabled: true, maxRuggedness: '0.5',
    });
    expect(enabledAndFilled.ok).toBe(true);
    if (enabledAndFilled.ok) expect(enabledAndFilled.profile.maxRuggedness).toBe(0.5);
  });

  it('rejects an out-of-range cross-field value via validateProfile (e.g. confidence > 100)', () => {
    const result = parseTerrainAccessProfileForm({ ...FILLED, minimumTerrainConfidence: '150' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.field === 'minimumTerrainConfidence')).toBe(true);
  });

  it('accepts a degree limit only strictly between 0° and 90°, and says so in degrees', () => {
    // 190° has the tangent of 10°, 270° is effectively no limit and 100° a
    // negative tangent: each would apply a limit other than the one typed.
    for (const raw of ['190', '270', '100', '90', '0', '-20', '1e3', '-170']) {
      for (const field of ['maxLongitudinalGradeDeg', 'maxCrossSlopeDeg'] as const) {
        const result = parseTerrainAccessProfileForm({ ...FILLED, [field]: raw });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0].field).toBe(field);
        const text = describeProfileProblem(result.problems[0]);
        expect(text).toMatch(/must be more than 0° and less than 90°; got -?[\d.]+°$/);
        expect(text).not.toMatch(/finite value|tangent/);
      }
    }
    for (const raw of ['0.5', '20', '89.9']) {
      expect(parseTerrainAccessProfileForm({ ...FILLED, maxLongitudinalGradeDeg: raw, maxCrossSlopeDeg: raw }).ok).toBe(true);
    }
    const one = parseTerrainAccessProfileForm({ ...FILLED, maxLongitudinalGradeDeg: '190' });
    if (!one.ok) expect(describeProfileProblem(one.problems[0])).toBe('Max longitudinal grade must be more than 0° and less than 90°; got 190°');
  });

  it('reports vehicle length and obstacle height only when their toggles are on', () => {
    const result = parseTerrainAccessProfileForm({
      ...FILLED,
      vehicleLengthEnabled: true, vehicleLengthM: '4.5',
      obstacleHeightEnabled: true, obstacleHeightThresholdM: '2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.vehicleLength).toBe(4.5);
      expect(result.profile.obstacleHeightThreshold).toBe(2);
    }
  });

  it('honours the penalize unknown policy', () => {
    const result = parseTerrainAccessProfileForm({ ...FILLED, unknownPolicy: 'penalize' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.unknownPolicy).toBe('penalize');
  });
});

describe('describeProfileProblem', () => {
  it('names every problem of an empty form by its on-screen label', () => {
    const parsed = parseTerrainAccessProfileForm(EMPTY_TERRAIN_ACCESS_PROFILE_FORM);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const lines = parsed.problems.map(describeProfileProblem);
    expect(lines).toContain('Profile name is required');
    expect(lines).toContain('Max longitudinal grade is required');
    for (const line of lines) expect(line).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b/);
  });

  it('falls back to the key for a field it does not know', () => {
    expect(describeProfileProblem({ field: 'other', reason: 'is odd' })).toBe('other is odd');
  });
});

/** The example values this release states a basis for, in the form's units. */
const STATED: Record<TerrainAccessExampleId, readonly [string, number, number, number, number, number]> = {
  walker: ['Walker', 20, 15, 0.3, 0.6, 40],
  atv: ['ATV', 20, 12, 0.2, 1.2, 50],
  '4x4': ['4x4 vehicle', 25, 15, 0.3, 2.0, 50],
};

function parsedExample(id: TerrainAccessExampleId, over: Partial<TerrainAccessProfileFormValues> = {}): TerrainAccessProfile {
  const result = parseTerrainAccessProfileForm({ ...terrainAccessExampleForm(id), ...over });
  if (!result.ok) throw new Error(result.problems.map(describeProfileProblem).join('; '));
  return result.profile;
}

describe('example profiles', () => {
  it('offers Walker, ATV and 4x4 vehicle, in that order, with the stated values', () => {
    expect(TERRAIN_ACCESS_EXAMPLES.map((e) => e.label)).toEqual(['Walker', 'ATV', '4x4 vehicle']);
    for (const ex of TERRAIN_ACCESS_EXAMPLES) {
      const [label, grade, cross, step, width, confidence] = STATED[ex.id];
      expect([ex.label, ex.maxLongitudinalGradeDeg, ex.maxCrossSlopeDeg, ex.maxStepHeightM, ex.vehicleWidthM, ex.minimumTerrainConfidence])
        .toEqual([label, grade, cross, step, width, confidence]);
    }
  });

  it.each(Object.keys(STATED) as TerrainAccessExampleId[])('%s fills a form that validates with exactly its values, as tangents', (id) => {
    const [label, grade, cross, step, width, confidence] = STATED[id];
    const form = terrainAccessExampleForm(id);
    expect(form.example).toBe(id);
    expect(form.name).toBe(`${label} (example)`);
    const profile = parsedExample(id);
    expect(profile).toEqual({
      name: `${label} (example)`,
      maxLongitudinalGrade: tan(grade),
      maxCrossSlope: tan(cross),
      maxStepHeight: step,
      maxRuggedness: null,
      vehicleWidth: width,
      vehicleLength: null,
      minimumTerrainConfidence: confidence,
      unknownPolicy: 'block',
      obstacleHeightThreshold: null,
      evidenceGapPolicy: EMPTY_TERRAIN_ACCESS_PROFILE_FORM.evidenceGapPolicy,
      origin: { example: id, edited: false },
    });
    expect(validateProfile(profile)).toEqual([]);
  });

  it('marks the origin edited when a limit or policy changes, not when only the name does', () => {
    expect(parsedExample('walker', { name: 'My walk' }).origin).toEqual({ example: 'walker', edited: false });
    // The same number written differently is not an edit.
    expect(parsedExample('walker', { maxLongitudinalGradeDeg: '20.0' }).origin?.edited).toBe(false);
    expect(parsedExample('walker', { maxLongitudinalGradeDeg: '18' }).origin).toEqual({ example: 'walker', edited: true });
    expect(parsedExample('atv', { vehicleWidthM: '1.3' }).origin?.edited).toBe(true);
    expect(parsedExample('4x4', { minimumTerrainConfidence: '60' }).origin?.edited).toBe(true);
    expect(parsedExample('4x4', { maxRuggednessEnabled: true, maxRuggedness: '0.5' }).origin?.edited).toBe(true);
    expect(parsedExample('atv', { unknownPolicy: 'penalize' }).origin?.edited).toBe(true);
    expect(parsedExample('atv', { evidenceGapPolicy: 'conservative' }).origin?.edited).toBe(true);
  });

  it('a filled example still refuses an invalid edit, field by field', () => {
    const result = parseTerrainAccessProfileForm({ ...terrainAccessExampleForm('walker'), maxStepHeightM: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map(describeProfileProblem)).toContain('Max step height is required');
  });

  it('says in one line that the values are examples to confirm, never a rating or a limit to rely on', () => {
    expect(TERRAIN_ACCESS_EXAMPLES_NOTE).toBe('Example values to confirm for your own platform, not a rating or a safety limit.');
    expect(TERRAIN_ACCESS_EXAMPLES_NOTE).not.toMatch(/\bsafe\b/i);
    for (const ex of TERRAIN_ACCESS_EXAMPLES) expect(terrainAccessExampleForm(ex.id).name).toMatch(/\(example\)$/);
  });

  it('describes the origin in words, and nothing for a profile typed by hand', () => {
    expect(profileOriginText(parsedExample('walker'))).toBe('Walker example, no value changed');
    expect(profileOriginText(parsedExample('4x4', { maxCrossSlopeDeg: '10' }))).toBe('4x4 vehicle example, then edited');
    expect(profileOriginText(parsedExample('walker', { example: null }))).toBeNull();
    expect(profileOriginText(undefined)).toBeNull();
  });

  it('validateProfile refuses a malformed origin', () => {
    const profile = parsedExample('walker');
    expect(validateProfile({ ...profile, origin: { example: '', edited: false } }).map((p) => p.field)).toEqual(['origin']);
    expect(validateProfile({ ...profile, origin: { example: 'walker' } as never }).map((p) => p.field)).toEqual(['origin']);
  });
});
