import {
  TierAdaptation,
  STEP_DOWN_FPS,
  STEP_UP_FPS,
  STEP_DOWN_HOLD_MS,
  STEP_UP_HOLD_MS,
  tierStepUp,
  tierStepDown,
} from '../src/render/streaming/tierAdaptation';

// --- runtime FPS adaptation -------------------------------

test('tierStepDown and tierStepUp respect the floor and the cap', () => {
  expect(tierStepDown('high')).toBe('medium');
  expect(tierStepDown('medium')).toBe('low');
  expect(tierStepDown('low')).toBeNull();
  expect(tierStepUp('low')).toBe('medium');
  expect(tierStepUp('medium')).toBe('high');
  expect(tierStepUp('high')).toBeNull();
});

test('sustained low FPS for ≥ 3 s steps the tier down', () => {
  let clock = 0;
  const adapt = new TierAdaptation('high', { now: () => clock });
  expect(adapt.recordFps(15)).toBe('high'); // arms the timer
  clock = 1_500;
  expect(adapt.recordFps(15)).toBe('high'); // half-way through the hold
  clock = STEP_DOWN_HOLD_MS + 1;
  expect(adapt.recordFps(15)).toBe('medium'); // threshold tripped
});

test('a brief FPS dip (<3 s) does NOT step the tier down', () => {
  let clock = 0;
  const adapt = new TierAdaptation('high', { now: () => clock });
  adapt.recordFps(15);
  clock = STEP_DOWN_HOLD_MS - 1;
  expect(adapt.recordFps(15)).toBe('high');
  // FPS recovers into the hysteresis band — timer must clear.
  clock += 100;
  expect(adapt.recordFps(35)).toBe('high');
  // Another below-threshold reading later re-arms from scratch.
  clock += 100;
  adapt.recordFps(15);
  clock += STEP_DOWN_HOLD_MS - 1;
  expect(adapt.recordFps(15)).toBe('high'); // still under hold, no step
});

test('sustained high FPS for ≥ 10 s steps the tier up', () => {
  let clock = 0;
  const adapt = new TierAdaptation('low', { now: () => clock });
  expect(adapt.recordFps(60)).toBe('low'); // arms
  clock = STEP_UP_HOLD_MS / 2;
  expect(adapt.recordFps(60)).toBe('low'); // half-way
  clock = STEP_UP_HOLD_MS + 1;
  expect(adapt.recordFps(60)).toBe('medium'); // tripped
});

test('step-up holds at the cap — high stays high even on sustained great FPS', () => {
  let clock = 0;
  const adapt = new TierAdaptation('high', { now: () => clock });
  clock = STEP_UP_HOLD_MS + 100;
  adapt.recordFps(60);
  expect(adapt.recordFps(60)).toBe('high');
});

test('step-down holds at the floor — low stays low even on sustained low FPS', () => {
  let clock = 0;
  const adapt = new TierAdaptation('low', { now: () => clock });
  clock = STEP_DOWN_HOLD_MS + 100;
  adapt.recordFps(10);
  expect(adapt.recordFps(10)).toBe('low');
});

test('FPS in the hysteresis band clears both timers — no oscillation', () => {
  let clock = 0;
  const adapt = new TierAdaptation('high', { now: () => clock });
  // Arm the step-down timer halfway, then a comfortable mid-FPS clears it.
  adapt.recordFps(15);
  clock = STEP_DOWN_HOLD_MS - 200;
  adapt.recordFps(STEP_DOWN_FPS + (STEP_UP_FPS - STEP_DOWN_FPS) / 2); // = 37
  // Even at the full hold time later, nothing has actually held.
  clock = STEP_DOWN_HOLD_MS * 2;
  expect(adapt.recordFps(15)).toBe('high'); // re-armed, but nowhere near 3 s in
});

test('setTier overrides current tier and resets both timers', () => {
  let clock = 0;
  const adapt = new TierAdaptation('high', { now: () => clock });
  adapt.recordFps(15); // arms below-timer
  clock = STEP_DOWN_HOLD_MS / 2;
  adapt.setTier('low');
  expect(adapt.currentTier).toBe('low');
  // After setTier, the new tier's step-up timer must arm from scratch.
  clock += 10;
  adapt.recordFps(60);
  clock += STEP_UP_HOLD_MS - 1;
  expect(adapt.recordFps(60)).toBe('low');
});
