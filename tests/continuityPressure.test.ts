import { describe, it, expect } from 'vitest';
import { nextTierUnderPressure } from '../src/render/continuity/continuityPressure';
import { TIER_ORDER, type ContinuityTier } from '../src/render/continuity/continuityTier';
import {
  FPS_PRESSURE_HIGH_MS,
  FPS_PRESSURE_LOW_MS,
  FPS_PRESSURE_HIGH_HOLD_MS,
  FPS_PRESSURE_LOW_HOLD_MS,
} from '../src/render/streaming/streamingBudget';

const slow = (ms: number) => ({ aboveHighMs: ms, belowLowMs: 0 });
const fast = (ms: number) => ({ aboveHighMs: 0, belowLowMs: ms });
const steady = { aboveHighMs: 0, belowLowMs: 0 };

describe('the shared pressure band', () => {
  // A band that touched or crossed would leave no neutral zone, and the
  // controller would flip on every frame that straddled the line.
  it('leaves a neutral zone between backing off and recovering', () => {
    expect(FPS_PRESSURE_LOW_MS).toBeLessThan(FPS_PRESSURE_HIGH_MS);
  });

  // Conceding fast and recovering slowly is what stops a controller hunting.
  it('recovers more slowly than it concedes', () => {
    expect(FPS_PRESSURE_LOW_HOLD_MS).toBeGreaterThan(FPS_PRESSURE_HIGH_HOLD_MS);
  });
});

describe('tier under pressure', () => {
  it('holds while the frames are unremarkable', () => {
    for (const tier of TIER_ORDER) {
      expect(nextTierUnderPressure(tier, 'full', steady)).toBe(tier);
    }
  });

  it('holds until the back-off hold has actually elapsed', () => {
    expect(nextTierUnderPressure('full', 'full', slow(FPS_PRESSURE_HIGH_HOLD_MS - 1))).toBe('full');
    expect(nextTierUnderPressure('full', 'full', slow(FPS_PRESSURE_HIGH_HOLD_MS))).toBe('closure');
  });

  it('holds until the recovery hold has actually elapsed', () => {
    expect(nextTierUnderPressure('sizing', 'full', fast(FPS_PRESSURE_LOW_HOLD_MS - 1))).toBe(
      'sizing',
    );
    expect(nextTierUnderPressure('sizing', 'full', fast(FPS_PRESSURE_LOW_HOLD_MS))).toBe('closure');
  });

  // One bad second should not cost every capability at once.
  it('gives ground one rung at a time', () => {
    let tier: ContinuityTier = 'full';
    const walk: ContinuityTier[] = [tier];
    for (let i = 0; i < 5; i++) {
      tier = nextTierUnderPressure(tier, 'full', slow(FPS_PRESSURE_HIGH_HOLD_MS));
      walk.push(tier);
    }
    expect(walk).toEqual(['full', 'closure', 'sizing', 'source', 'source', 'source']);
  });

  it('climbs back one rung at a time and stops at the ceiling', () => {
    let tier: ContinuityTier = 'source';
    const walk: ContinuityTier[] = [tier];
    for (let i = 0; i < 4; i++) {
      tier = nextTierUnderPressure(tier, 'full', fast(FPS_PRESSURE_LOW_HOLD_MS));
      walk.push(tier);
    }
    expect(walk).toEqual(['source', 'sizing', 'closure', 'full', 'full']);
  });

  // A backend that cannot carry something does not become able to by going fast.
  it('never promotes past what the backend can carry', () => {
    expect(nextTierUnderPressure('sizing', 'sizing', fast(FPS_PRESSURE_LOW_HOLD_MS * 10))).toBe(
      'sizing',
    );
    expect(nextTierUnderPressure('closure', 'closure', fast(FPS_PRESSURE_LOW_HOLD_MS))).toBe(
      'closure',
    );
  });

  it('clamps a tier already above the ceiling, whatever the frames are doing', () => {
    for (const input of [steady, slow(10_000), fast(10_000)]) {
      expect(nextTierUnderPressure('full', 'sizing', input)).toBe('sizing');
    }
  });

  it('cannot fall below the bottom rung', () => {
    expect(nextTierUnderPressure('source', 'full', slow(FPS_PRESSURE_HIGH_HOLD_MS * 10))).toBe(
      'source',
    );
  });

  // The asymmetry doing its job: a device that alternates between a qualifying
  // slow spell and a qualifying fast one loses ground rather than oscillating
  // around a single tier, because the slow side is reached far sooner.
  it('does not sit on a rung it cannot sustain', () => {
    let tier: ContinuityTier = 'full';
    for (let i = 0; i < 3; i++) {
      tier = nextTierUnderPressure(tier, 'full', slow(FPS_PRESSURE_HIGH_HOLD_MS));
      tier = nextTierUnderPressure(tier, 'full', fast(FPS_PRESSURE_LOW_HOLD_MS - 1));
    }
    expect(tier).toBe('source');
  });
});
