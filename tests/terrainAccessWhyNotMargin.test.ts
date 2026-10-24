/**
 * terrainAccessWhyNotMargin.test.ts: when every move out of a cell exceeds an
 * edge limit, the why-not inspector names the move that misses by the
 * smallest excess relative to its own limit. A step excess is in metres and a
 * grade or cross-slope excess is a tangent, so comparing them raw ranked
 * them by unit rather than by how close each move came.
 */
import { describe, expect, it } from 'vitest';

import {
  nodeEligibility, prepareTerrainAccessFeatures, whyNotEligible,
} from '../src/simulation/terrainAccess/traversabilityCost';
import { gridOf, PERMISSIVE } from './helpers/terrainAccessFixtures';

/**
 * A 4×1 strip around cell 1. The move west climbs a 0.05 m ledge (nothing
 * beyond it to explain the rise) over a 0.01 m limit (0.04 m over, 4× the
 * limit). The move east is level, with the ledge behind it and flat ground
 * ahead, so it has no step, but reads a 0.6 Horn grade at its end cell over a
 * 0.5 limit (0.1 over, 0.2× the limit). Raw, 0.04 < 0.1 named the step;
 * relative, the grade is closer.
 */
function strip(maxStepHeight: number) {
  const grid = gridOf([[0.05, 0, 0, 0]]);
  const profile = { ...PERMISSIVE, maxStepHeight, maxLongitudinalGrade: 0.5, maxCrossSlope: 10 };
  const features = prepareTerrainAccessFeatures(grid, profile);
  features.gradient.east.fill(0);
  features.gradient.north.fill(0);
  features.gradient.east[2] = 0.6;
  const eligibility = nodeEligibility(grid, features, profile);
  return { grid, features, eligibility, profile };
}

describe('why-not closest miss compares margins relative to each limit', () => {
  it('names the grade miss (0.2× over) rather than the step miss (4× over)', () => {
    const { grid, features, eligibility, profile } = strip(0.01);
    expect(eligibility.blocked[1]).toBe(0);
    const out = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(out.eligible).toBe(false);
    expect(out.category).toBe('blocked');
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0].reason).toBe('longitudinal-grade');
  });

  it('names the step miss when it is the relatively closer one', () => {
    // 0.05 m over a 0.045 m limit is 0.11× over, closer than the grade's 0.2×.
    const { grid, features, eligibility, profile } = strip(0.045);
    const out = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(out.reasons[0].reason).toBe('step-height');
  });

  it('a 0 m step limit still yields a named miss, never a missing reason', () => {
    // Both moves carry a step (west 0.05 m; east a 0.02 m rise between a
    // ledge behind and a 0.02 m drop ahead) over a 0 m step limit, so each
    // excess is infinite relative to the limit.
    const grid = gridOf([[0.05, 0, 0.02, 0]]);
    const profile = { ...PERMISSIVE, maxStepHeight: 0, maxLongitudinalGrade: 0.5, maxCrossSlope: 10 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    features.gradient.east.fill(0);
    features.gradient.north.fill(0);
    const eligibility = nodeEligibility(grid, features, profile);
    const out = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(out.eligible).toBe(false);
    expect(out.reasons[0].reason).toBe('step-height');
  });
});
