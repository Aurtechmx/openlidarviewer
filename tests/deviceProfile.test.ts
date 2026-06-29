import { deviceTier, deviceCaps } from '../src/render/deviceProfile';

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
  test('a capable desktop gets the high-tier 6M budget', () => {
    expect(deviceCaps({ deviceMemoryGB: 16, hardwareConcurrency: 16, isMobile: false }))
      .toEqual({ tier: 'high', renderBudget: 6_000_000 });
  });

  test('a mid desktop keeps the conservative 4M budget', () => {
    // medium tier (capable RAM but fewer cores) stays at the canonical cap.
    expect(deviceCaps({ deviceMemoryGB: 8, hardwareConcurrency: 4, isMobile: false }))
      .toEqual({ tier: 'medium', renderBudget: 4_000_000 });
  });

  test('a low desktop is degraded to 2M', () => {
    const caps = deviceCaps({ deviceMemoryGB: 2, hardwareConcurrency: 2, isMobile: false });
    expect(caps.tier).toBe('low');
    expect(caps.renderBudget).toBe(2_000_000);
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
