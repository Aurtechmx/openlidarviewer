import {
  deviceTier,
  deviceCaps,
  RENDER_BUDGET_BASIS,
  TIER_SLOWDOWN,
  type DeviceTier,
  type DeviceSignals,
} from '../src/render/deviceProfile';

describe('deviceTier — desktop', () => {
  test('ample memory and cores → high', () => {
    expect(deviceTier({ deviceMemoryGB: 8, hardwareConcurrency: 16, isMobile: false }))
      .toBe('high');
  });

  test('mid memory → medium', () => {
    expect(deviceTier({ deviceMemoryGB: 4, hardwareConcurrency: 8, isMobile: false }))
      .toBe('medium');
  });

  test('low memory → low', () => {
    expect(deviceTier({ deviceMemoryGB: 2, hardwareConcurrency: 4, isMobile: false }))
      .toBe('low');
  });

  test('few cores pull an 8 GB machine down to medium', () => {
    expect(deviceTier({ deviceMemoryGB: 8, hardwareConcurrency: 4, isMobile: false }))
      .toBe('medium');
  });

  test('unreported memory falls back to medium (capable machines unpunished)', () => {
    expect(deviceTier({ hardwareConcurrency: 8, isMobile: false })).toBe('medium');
  });

  test('unreported memory with very few cores → low', () => {
    expect(deviceTier({ hardwareConcurrency: 2, isMobile: false })).toBe('low');
  });
});

describe('deviceTier — mobile', () => {
  test('a phone is never high', () => {
    expect(deviceTier({ deviceMemoryGB: 8, hardwareConcurrency: 16, isMobile: true }))
      .toBe('medium');
  });

  test('a well-equipped phone is medium', () => {
    expect(deviceTier({ deviceMemoryGB: 6, hardwareConcurrency: 6, isMobile: true }))
      .toBe('medium');
  });

  test('a modest phone is low', () => {
    expect(deviceTier({ deviceMemoryGB: 4, hardwareConcurrency: 4, isMobile: true }))
      .toBe('low');
  });

  test('a phone with no reported signals is low', () => {
    expect(deviceTier({ isMobile: true })).toBe('low');
  });
});

describe('deviceCaps — render budget', () => {
  test('a capable desktop gets the high-tier 3M budget', () => {
    expect(deviceCaps({ deviceMemoryGB: 16, hardwareConcurrency: 16, isMobile: false }))
      .toEqual({ tier: 'high', renderBudget: 3_000_000 });
  });

  test('a mid desktop gets 2M', () => {
    expect(deviceCaps({ deviceMemoryGB: 8, hardwareConcurrency: 4, isMobile: false }))
      .toEqual({ tier: 'medium', renderBudget: 2_000_000 });
  });

  test('a low desktop is degraded to 1.2M', () => {
    const caps = deviceCaps({ deviceMemoryGB: 2, hardwareConcurrency: 2, isMobile: false });
    expect(caps.tier).toBe('low');
    expect(caps.renderBudget).toBe(1_200_000);
  });

  test('a normal phone keeps the 1.5M mobile budget', () => {
    const caps = deviceCaps({ deviceMemoryGB: 6, hardwareConcurrency: 6, isMobile: true });
    expect(caps.renderBudget).toBe(1_500_000);
  });

  test('a low-end phone is degraded to 0.8M', () => {
    const caps = deviceCaps({ isMobile: true });
    expect(caps.tier).toBe('low');
    expect(caps.renderBudget).toBe(800_000);
  });
});

/**
 * The desktop ladder is derived, not picked: each rung is the point count that
 * holds RENDER_BUDGET_BASIS.frameMs on a device of that class, given the
 * measured per-point frame cost and the tier's slowdown against the reference
 * GPU. These pin that arithmetic and the ordering it implies.
 */
describe('render budget ladder', () => {
  const DESKTOP: Record<DeviceTier, DeviceSignals> = {
    high: { deviceMemoryGB: 16, hardwareConcurrency: 16, isMobile: false },
    medium: { deviceMemoryGB: 8, hardwareConcurrency: 4, isMobile: false },
    low: { deviceMemoryGB: 2, hardwareConcurrency: 2, isMobile: false },
  };
  const MOBILE: Record<DeviceTier, DeviceSignals> = {
    high: { deviceMemoryGB: 16, hardwareConcurrency: 16, isMobile: true },
    medium: { deviceMemoryGB: 6, hardwareConcurrency: 6, isMobile: true },
    low: { isMobile: true },
  };
  const budget = (s: DeviceSignals): number => deviceCaps(s).renderBudget;

  test('desktop budgets decrease strictly from high to low', () => {
    expect(budget(DESKTOP.high)).toBeGreaterThan(budget(DESKTOP.medium));
    expect(budget(DESKTOP.medium)).toBeGreaterThan(budget(DESKTOP.low));
  });

  test('mobile budgets never increase from high to low', () => {
    expect(budget(MOBILE.high)).toBeGreaterThanOrEqual(budget(MOBILE.medium));
    expect(budget(MOBILE.medium)).toBeGreaterThanOrEqual(budget(MOBILE.low));
  });

  test('every mobile rung stays under its desktop counterpart', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(budget(MOBILE[tier])).toBeLessThan(budget(DESKTOP[tier]));
    }
  });

  test('each desktop rung buys the documented frame time on its own class', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      const frameMs =
        (budget(DESKTOP[tier]) * TIER_SLOWDOWN[tier] * RENDER_BUDGET_BASIS.nsPerPointPerFrame) / 1e6;
      expect(frameMs).toBeCloseTo(RENDER_BUDGET_BASIS.frameMs, 6);
    }
  });

  test('on the reference GPU the rungs cost 16.8, 11.2 and 6.7 ms', () => {
    const referenceMs = (tier: DeviceTier): number =>
      (budget(DESKTOP[tier]) * RENDER_BUDGET_BASIS.nsPerPointPerFrame) / 1e6;
    expect(referenceMs('high')).toBeCloseTo(16.8, 1);
    expect(referenceMs('medium')).toBeCloseTo(11.2, 1);
    expect(referenceMs('low')).toBeCloseTo(6.7, 1);
  });

  test('the documented frame time is interactive', () => {
    expect(1000 / RENDER_BUDGET_BASIS.frameMs).toBeGreaterThan(55);
  });
});
