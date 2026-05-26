import {
  qualityForTier,
  streamingProfileForTier,
} from '../src/render/streaming/streamingProfile';

// --- Phase 9 Task 28 — device-profile tiers ---------------------------------

test('qualityForTier maps low / medium / high to the matching quality preset', () => {
  expect(qualityForTier('low')).toBe('low');
  expect(qualityForTier('medium')).toBe('balanced');
  expect(qualityForTier('high')).toBe('high');
});

test('streamingProfileForTier — low tier turns EDL and fade-in off, picks the low budget', () => {
  const desktop = streamingProfileForTier('low', false);
  expect(desktop.tier).toBe('low');
  expect(desktop.quality).toBe('low');
  expect(desktop.edlDefault).toBe(false);
  expect(desktop.fadeIn).toBe(false);
  expect(desktop.budgets.pointBudget).toBeGreaterThan(0);
});

test('streamingProfileForTier — medium tier enables EDL and fade-in on desktop', () => {
  const desktop = streamingProfileForTier('medium', false);
  expect(desktop.tier).toBe('medium');
  expect(desktop.quality).toBe('balanced');
  expect(desktop.edlDefault).toBe(true);
  expect(desktop.fadeIn).toBe(true);
});

test('streamingProfileForTier — mobile drops fade-in even on the high tier', () => {
  const mobileHigh = streamingProfileForTier('high', true);
  expect(mobileHigh.quality).toBe('high');
  expect(mobileHigh.edlDefault).toBe(true); // EDL stays — it's cheap on a phone GPU now
  expect(mobileHigh.fadeIn).toBe(false); // fade-in is always off on mobile
});

test('streamingProfileForTier — high tier has a larger point budget than medium', () => {
  const high = streamingProfileForTier('high', false);
  const medium = streamingProfileForTier('medium', false);
  expect(high.budgets.pointBudget).toBeGreaterThan(medium.budgets.pointBudget);
});

test('streamingProfileForTier — mobile budgets are smaller than desktop budgets', () => {
  const desktop = streamingProfileForTier('medium', false);
  const mobile = streamingProfileForTier('medium', true);
  expect(mobile.budgets.pointBudget).toBeLessThan(desktop.budgets.pointBudget);
  expect(mobile.budgets.maxConcurrentDecodes).toBeLessThanOrEqual(
    desktop.budgets.maxConcurrentDecodes,
  );
});
