import { describe, expect, it } from 'vitest';

import {
  DPR_PRESSURE_STEP,
  MIN_COMMIT_SCALE,
  SWITCH_THRESHOLDS,
  TARGET_FRAME_MS,
  UNLOADED_POLICY,
  frameBudgetPolicy,
  frameLoad,
  type FrameBudgetInput,
} from '../src/render/perf/frameBudgetGovernor';
import type { RefinementPhase } from '../src/render/refinementPhase';

/** A frame that is comfortably inside budget with nothing waiting on it. */
function input(over: Partial<FrameBudgetInput> = {}): FrameBudgetInput {
  return {
    phase: 'full-refine',
    tweening: false,
    recentMedianMs: TARGET_FRAME_MS,
    recentHighMs: TARGET_FRAME_MS,
    pendingGpuNodes: 0,
    streamingBacklog: 0,
    continuityPending: false,
    mobileTier: false,
    ...over,
  };
}

/** The frame time that produces a given load through the median alone. */
function msForLoad(load: number): number {
  return TARGET_FRAME_MS + load * TARGET_FRAME_MS * 2;
}

describe('frameLoad', () => {
  it('is zero at and under the target frame time', () => {
    expect(frameLoad(input({ recentMedianMs: TARGET_FRAME_MS }))).toBe(0);
    expect(frameLoad(input({ recentMedianMs: 4 }))).toBe(0);
  });

  it('saturates at twice the target rather than growing without bound', () => {
    expect(frameLoad(input({ recentMedianMs: msForLoad(1) }))).toBeCloseTo(1, 6);
    expect(frameLoad(input({ recentMedianMs: 400 }))).toBe(1);
  });

  it('counts a single high frame at half the weight of the median', () => {
    const spikeOnly = frameLoad(input({ recentHighMs: msForLoad(1) }));
    expect(spikeOnly).toBeCloseTo(0.5, 6);
    // The same frame time as a median carries twice as far, which is the
    // whole point of the weighting.
    expect(frameLoad(input({ recentMedianMs: msForLoad(1) }))).toBeGreaterThan(spikeOnly);
  });

  it('reads a non-finite measurement as unloaded rather than as overload', () => {
    expect(frameLoad(input({ recentMedianMs: Number.NaN, recentHighMs: Number.NaN }))).toBe(0);
  });

  it('honours an explicit target', () => {
    // 120 Hz: a 16.7 ms frame is now over budget.
    const fast = frameLoad(input({ targetFrameMs: 1000 / 120, recentMedianMs: TARGET_FRAME_MS }));
    expect(fast).toBeGreaterThan(0);
  });
});

describe('frameBudgetPolicy bands', () => {
  const cases: ReadonlyArray<readonly [RefinementPhase, string]> = [
    ['moving', 'moving'],
    ['coverage', 'settling'],
    ['center-refine', 'refining'],
    ['full-refine', 'idle'],
  ];

  it('derives the band from the refinement phase, not from a second machine', () => {
    for (const [phase, band] of cases) {
      expect(frameBudgetPolicy(input({ phase })).band).toBe(band);
    }
  });

  it('treats a running tween as motion whatever the phase says', () => {
    expect(frameBudgetPolicy(input({ phase: 'full-refine', tweening: true })).band).toBe('moving');
  });
});

describe('frameBudgetPolicy pressure', () => {
  it('quantises dpr pressure onto the step instead of tracking the median', () => {
    for (const load of [0.01, 0.2, 0.3, 0.44, 0.61, 0.99]) {
      const { dprPressure } = frameBudgetPolicy(input({ recentMedianMs: msForLoad(load) }));
      const steps = dprPressure / DPR_PRESSURE_STEP;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      expect(dprPressure).toBeGreaterThanOrEqual(load - 1e-9);
    }
  });

  it('applies a motion floor while moving, higher on touch hardware', () => {
    const desktop = frameBudgetPolicy(input({ phase: 'moving' }));
    const mobile = frameBudgetPolicy(input({ phase: 'moving', mobileTier: true }));
    expect(desktop.dprPressure).toBe(0.25);
    expect(mobile.dprPressure).toBe(0.5);
    expect(frameBudgetPolicy(input({ phase: 'full-refine' })).dprPressure).toBe(0);
  });

  it('gives ground in the periphery only while moving', () => {
    const moving = frameBudgetPolicy(input({ phase: 'moving', recentMedianMs: msForLoad(1) }));
    expect(moving.peripheralQualityScale).toBeCloseTo(0.5, 6);
    const parked = frameBudgetPolicy(input({ phase: 'center-refine', recentMedianMs: msForLoad(1) }));
    expect(parked.peripheralQualityScale).toBe(1);
  });
});

describe('frameBudgetPolicy upload and streaming', () => {
  it('never scales a pending commit to zero, however loaded the frame is', () => {
    const p = frameBudgetPolicy(input({
      phase: 'moving',
      pendingGpuNodes: 12,
      recentMedianMs: 5000,
    }));
    expect(p.gpuCommitScale).toBe(MIN_COMMIT_SCALE);
    expect(p.gpuCommitScale).toBeGreaterThan(0);
  });

  it('leaves the batch alone when nothing is pending', () => {
    expect(frameBudgetPolicy(input({ recentMedianMs: 5000 })).gpuCommitScale).toBe(1);
  });

  it('takes a smaller batch while moving than while settling at the same load', () => {
    const load = { recentMedianMs: msForLoad(0.2), pendingGpuNodes: 4 };
    const moving = frameBudgetPolicy(input({ phase: 'moving', ...load }));
    const settling = frameBudgetPolicy(input({ phase: 'coverage', ...load }));
    expect(moving.gpuCommitScale).toBeLessThan(settling.gpuCommitScale);
  });

  it('ranks urgency by band and reports none without a backlog', () => {
    expect(frameBudgetPolicy(input({ phase: 'moving' })).streamingUrgency).toBe(0);
    const withBacklog = (phase: RefinementPhase) =>
      frameBudgetPolicy(input({ phase, streamingBacklog: 3 })).streamingUrgency;
    expect(withBacklog('moving')).toBe(1);
    expect(withBacklog('coverage')).toBe(0.75);
    expect(withBacklog('center-refine')).toBe(0.5);
    expect(withBacklog('full-refine')).toBe(0.25);
  });

  it('does not soften urgency under load — the hole is on screen either way', () => {
    const calm = frameBudgetPolicy(input({ phase: 'moving', streamingBacklog: 3 }));
    const loaded = frameBudgetPolicy(input({
      phase: 'moving',
      streamingBacklog: 3,
      recentMedianMs: 5000,
    }));
    expect(loaded.streamingUrgency).toBe(calm.streamingUrgency);
  });
});

describe('frameBudgetPolicy hysteresis', () => {
  it('holds a switch inside the gap and moves it outside', () => {
    const { drop, restore } = SWITCH_THRESHOLDS.edl;
    const between = (drop + restore) / 2;
    const mid = input({ phase: 'center-refine', recentMedianMs: msForLoad(between) });

    const wasOn = frameBudgetPolicy(mid, { ...UNLOADED_POLICY, allowEdl: true });
    const wasOff = frameBudgetPolicy(mid, { ...UNLOADED_POLICY, allowEdl: false });
    expect(wasOn.allowEdl).toBe(true);
    expect(wasOff.allowEdl).toBe(false);

    // Outside the gap the previous answer stops mattering.
    const heavy = input({ phase: 'center-refine', recentMedianMs: msForLoad(drop + 0.05) });
    expect(frameBudgetPolicy(heavy, { ...UNLOADED_POLICY, allowEdl: true }).allowEdl).toBe(false);
    const light = input({ phase: 'center-refine', recentMedianMs: msForLoad(restore - 0.05) });
    expect(frameBudgetPolicy(light, { ...UNLOADED_POLICY, allowEdl: false }).allowEdl).toBe(true);
  });

  it('cannot flip a switch on alternating frames across the gap', () => {
    const { drop, restore } = SWITCH_THRESHOLDS.edl;
    // Loads that straddle the midpoint but stay inside the gap: a governor
    // without hysteresis would answer differently on each of them.
    const loads = [restore + 0.01, drop - 0.01, restore + 0.02, drop - 0.02];
    let policy = { ...UNLOADED_POLICY, allowEdl: true };
    const answers: boolean[] = [];
    for (const load of loads) {
      policy = frameBudgetPolicy(
        input({ phase: 'center-refine', recentMedianMs: msForLoad(load) }),
        policy,
      );
      answers.push(policy.allowEdl);
    }
    expect(new Set(answers).size).toBe(1);
  });

  it('keeps lighting off on touch hardware while the camera is moving', () => {
    const moving = input({ phase: 'moving', mobileTier: true });
    expect(frameBudgetPolicy(moving, { ...UNLOADED_POLICY, allowEdl: true }).allowEdl).toBe(false);
    // The same frame on a desktop keeps it.
    const desktop = input({ phase: 'moving', mobileTier: false });
    expect(frameBudgetPolicy(desktop, { ...UNLOADED_POLICY, allowEdl: true }).allowEdl).toBe(true);
  });
});

describe('frameBudgetPolicy optional work', () => {
  it('runs continuity while refining and nowhere else', () => {
    const phases: RefinementPhase[] = ['moving', 'coverage', 'center-refine', 'full-refine'];
    const allowed = phases.filter((phase) =>
      frameBudgetPolicy(input({ phase, continuityPending: true })).allowContinuity);
    expect(allowed).toEqual(['center-refine']);
  });

  it('does not claim continuity work when there is none pending', () => {
    expect(frameBudgetPolicy(input({ phase: 'center-refine' })).allowContinuity).toBe(false);
  });

  it('withholds detailed hover while moving whatever the load is', () => {
    expect(frameBudgetPolicy(input({ phase: 'moving' })).allowDetailedHover).toBe(false);
    expect(frameBudgetPolicy(input({ phase: 'coverage' })).allowDetailedHover).toBe(true);
  });
});

describe('frameBudgetPolicy shape', () => {
  it('bounds every fraction it returns', () => {
    const extremes: FrameBudgetInput[] = [
      input({ recentMedianMs: -50, recentHighMs: -50 }),
      input({ phase: 'moving', recentMedianMs: 1e9, recentHighMs: 1e9, pendingGpuNodes: 1e6, streamingBacklog: 1e6 }),
      input({ recentMedianMs: Number.POSITIVE_INFINITY }),
      input({ phase: 'moving', mobileTier: true, continuityPending: true, tweening: true }),
    ];
    for (const one of extremes) {
      const p = frameBudgetPolicy(one);
      for (const value of [p.dprPressure, p.gpuCommitScale, p.streamingUrgency, p.peripheralQualityScale, p.load]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is a pure function of its two arguments', () => {
    const one = input({ phase: 'coverage', recentMedianMs: msForLoad(0.4), pendingGpuNodes: 2 });
    expect(frameBudgetPolicy(one)).toEqual(frameBudgetPolicy(one));
  });
});
