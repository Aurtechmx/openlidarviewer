/**
 * terrainAccessProfileForm.test.ts: the mobility-profile form's own parse/
 * validate rules — required fields, numeric parsing, the degrees→tangent
 * conversion, and that no field ships a preset value (§21).
 */
import { describe, expect, it } from 'vitest';

import {
  describeProfileProblem,
  EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
  parseTerrainAccessProfileForm,
  type TerrainAccessProfileFormValues,
} from '../src/ui/fieldSimulation/terrainAccessProfileForm';

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
  it('has no preset value in any required numeric field (§21: no preset presented as safe)', () => {
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.name).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxLongitudinalGradeDeg).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxCrossSlopeDeg).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxStepHeightM).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.vehicleWidthM).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.minimumTerrainConfidence).toBe('');
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.maxRuggednessEnabled).toBe(false);
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.vehicleLengthEnabled).toBe(false);
    expect(EMPTY_TERRAIN_ACCESS_PROFILE_FORM.obstacleHeightEnabled).toBe(false);
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
