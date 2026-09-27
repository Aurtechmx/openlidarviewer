import { describe, expect, it } from 'vitest';
import { calibrationLevel, frameBudgetPolicy, TARGET_FRAME_MS, type FrameBudgetInput } from '../src/render/perf/frameBudgetGovernor';
import { CALIBRATION_FRAMES, CALIBRATION_MAX_MS, CALIBRATION_MIN_FRAMES, GovernorWiring } from '../src/render/perf/governorWiring';

const MOVING: FrameBudgetInput = {
  phase: 'moving', tweening: true, recentMedianMs: 8, recentHighMs: 9,
  pendingGpuNodes: 0, streamingBacklog: 0, continuityPending: false, mobileTier: false,
};

describe('calibrationLevel', () => {
  it('maps warm-up p95 onto the governor load levels', () => {
    expect(calibrationLevel(TARGET_FRAME_MS)).toBe(0);
    expect(calibrationLevel(20)).toBe(1);
    expect(calibrationLevel(TARGET_FRAME_MS * 2)).toBe(1);
    expect(calibrationLevel(60)).toBe(2);
  });

  it('starts motion from the calibrated level and restores when still', () => {
    expect(frameBudgetPolicy(MOVING).renderScale).toBe(1);
    expect(frameBudgetPolicy({ ...MOVING, calibratedLevel: 1 })).toMatchObject({ renderScale: 0.8, pointBudgetFraction: 0.7 });
    expect(frameBudgetPolicy({ ...MOVING, calibratedLevel: 2 })).toMatchObject({ renderScale: 0.6, pointBudgetFraction: 0.4 });
    expect(frameBudgetPolicy({ ...MOVING, calibratedLevel: 2, presentationMoving: false })).toMatchObject({ renderScale: 1, pointBudgetFraction: 1 });
  });
});

describe('GovernorWiring warm-up', () => {
  it('is off unless asked for', () => {
    const g = new GovernorWiring(false);
    g.frame('coverage', false, 0);
    for (let i = 0; i < 40; i++) g.frameMs(60);
    expect(g.calibratedLevel).toBeNull();
  });

  it('waits for a load, then picks from the first frames only', () => {
    const g = new GovernorWiring(false, true);
    for (let i = 0; i < 40; i++) g.frameMs(60); // empty viewer, no load yet
    g.frame('full-refine', false, 1000);
    expect(g.calibratedLevel).toBeNull();
    g.frame('coverage', false, 1000);
    for (let i = 0; i < CALIBRATION_FRAMES - 1; i++) g.frameMs(10);
    expect(g.calibratedLevel).toBeNull();
    g.frameMs(10);
    expect(g.calibratedLevel).toBe(0);
    for (let i = 0; i < 40; i++) g.frameMs(80);
    expect(g.calibratedLevel).toBe(0);
  });

  it('ends on the time bound and skips a pick with too few frames', () => {
    const g = new GovernorWiring(false, true);
    g.uploadLimits({ maxNodes: 4 }, 3);
    g.frame('full-refine', false, 0);
    const slow = CALIBRATION_MAX_MS / (CALIBRATION_MIN_FRAMES - 2);
    for (let i = 0; i < CALIBRATION_MIN_FRAMES - 2; i++) g.frameMs(slow);
    expect(g.calibratedLevel).toBe(0);
  });
});
