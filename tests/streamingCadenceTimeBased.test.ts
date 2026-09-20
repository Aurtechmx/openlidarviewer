/**
 * The streaming cadence, and the refresh rate it must stop depending on.
 *
 * The old cadence ticked every sixth frame, which is 100 ms at 60 Hz and 42 ms
 * at 144 Hz. The scheduler therefore ran nearly two and a half times as often
 * on a faster panel and made different loading decisions on the same scan. The
 * phase this implements asks for one property above all: replay the same trace
 * at several refresh rates and the decision sequence should be the same.
 *
 * So the central test is a replay at 60, 90, 120 and 144 Hz, and the old
 * behaviour is included as a control. If the control did not diverge, the
 * replay would not be evidence of anything.
 */
import { describe, it, expect } from 'vitest';
import {
  CADENCE_MS,
  bandFor,
  shouldTick,
  expectedTicks,
  type CadenceBand,
  type WakeReason,
} from '../src/render/streaming/schedulerCadence';
import type { RefinementPhase } from '../src/render/refinementPhase';

const RATES = [60, 90, 120, 144];
const PHASES: readonly RefinementPhase[] = ['moving', 'coverage', 'center-refine', 'full-refine'];

/** Replay a fixed wall-clock duration at a refresh rate, returning tick times. */
function replayTicks(hz: number, durationMs: number, phase: RefinementPhase): number[] {
  const frameMs = 1000 / hz;
  const at: number[] = [];
  let last = 0;
  for (let t = 0; t <= durationMs; t += frameMs) {
    if (shouldTick({ nowMs: t, lastTickMs: last, phase })) { at.push(t); last = t; }
  }
  return at;
}

/** Ticks produced over a duration. */
const replayTimeBased = (hz: number, durationMs: number, phase: RefinementPhase): number =>
  replayTicks(hz, durationMs, phase).length;

/** The gaps between consecutive ticks, which is what the band governs. */
function tickGaps(hz: number, durationMs: number, phase: RefinementPhase): number[] {
  const at = replayTicks(hz, durationMs, phase);
  return at.slice(1).map((t, i) => t - at[i]);
}

/** The behaviour being replaced: one tick every sixth frame. */
function replayFrameCount(hz: number, durationMs: number): number {
  const frameMs = 1000 / hz;
  let frames = 0;
  let ticks = 0;
  for (let t = 0; t <= durationMs; t += frameMs) { frames += 1; if (frames % 6 === 0) ticks += 1; }
  return ticks;
}

describe('the control: the frame-count cadence did depend on refresh rate', () => {
  it('ticks more than twice as often at 144 Hz as at 60 Hz', () => {
    const at60 = replayFrameCount(60, 5000);
    const at144 = replayFrameCount(144, 5000);
    expect(at144 / at60).toBeGreaterThan(2);
  });
});

describe('the same trace at four refresh rates', () => {
  // The invariant a per-frame poll can actually hold. A deadline is served on
  // the next frame boundary after it, so the achieved interval is the band
  // rounded up to a whole frame. Asserting equal tick counts would be
  // asserting something no policy of this shape can deliver.
  for (const phase of PHASES) {
    it(`serves the ${phase} band within one frame at every rate`, () => {
      const nominal = CADENCE_MS[bandFor(phase)];
      for (const hz of RATES) {
        const frameMs = 1000 / hz;
        const gaps = tickGaps(hz, 6000, phase);
        expect(gaps.length, `${phase} at ${hz}Hz produced no gaps`).toBeGreaterThan(3);
        for (const gap of gaps) {
          // Never early, and late by at most the frame the deadline fell in.
          expect(gap, `${phase} at ${hz}Hz`).toBeGreaterThanOrEqual(nominal - 1e-9);
          expect(gap, `${phase} at ${hz}Hz`).toBeLessThan(nominal + frameMs + 1e-9);
        }
      }
    });
  }

  it('holds the spread across rates far tighter than the frame count did', () => {
    for (const phase of PHASES) {
      const counts = RATES.map((hz) => replayTimeBased(hz, 5000, phase));
      const ratio = Math.max(...counts) / Math.min(...counts);
      // The frame count varied by more than 2.4x over the same span.
      expect(ratio, `${phase}: ${counts.join(', ')}`).toBeLessThan(1.2);
    }
  });

  it('tracks the declared interval rather than the frame rate', () => {
    for (const phase of PHASES) {
      for (const hz of RATES) {
        const ticks = replayTimeBased(hz, 6000, phase);
        const expected = expectedTicks(6000, phase);
        // Never MORE than the band allows; quantisation can only slow it.
        expect(ticks, `${phase} at ${hz}Hz`).toBeLessThanOrEqual(expected + 1);
      }
    }
  });
});

describe('bands', () => {
  it('maps each refinement phase to one band, reusing the renderer vocabulary', () => {
    const seen = new Map<RefinementPhase, CadenceBand>();
    for (const p of PHASES) seen.set(p, bandFor(p));
    expect([...seen.values()]).toEqual(['moving', 'settling', 'refining', 'idle']);
  });

  it('paces a moving camera fastest and an idle one slowest', () => {
    expect(CADENCE_MS.moving).toBeLessThan(CADENCE_MS.settling);
    expect(CADENCE_MS.settling).toBeLessThan(CADENCE_MS.refining);
    expect(CADENCE_MS.refining).toBeLessThan(CADENCE_MS.idle);
  });

  it('keeps idle as background maintenance rather than stopping', () => {
    // A scheduler that stopped would depend on the wake list being complete,
    // and an incomplete list strands a scan with no way back.
    expect(Number.isFinite(CADENCE_MS.idle)).toBe(true);
    expect(expectedTicks(1000, 'full-refine')).toBeGreaterThan(0);
  });
});

describe('waking early', () => {
  const REASONS: readonly WakeReason[] = [
    'dataset-attached', 'projection-changed', 'viewport-changed',
    'camera-jumped', 'tween-retargeted', 'memory-pressure', 'frontier-invalidated',
  ];

  it('runs immediately for every reason, whatever the clock says', () => {
    for (const wake of REASONS) {
      expect(shouldTick({ nowMs: 1000, lastTickMs: 999, phase: 'full-refine', wake }), wake).toBe(true);
    }
  });

  it('does not run early without one', () => {
    expect(shouldTick({ nowMs: 1000, lastTickMs: 999, phase: 'full-refine' })).toBe(false);
    expect(shouldTick({ nowMs: 1000, lastTickMs: 999, phase: 'moving', wake: null })).toBe(false);
  });
});

describe('clocks that misbehave', () => {
  it('treats a backwards clock as due rather than waiting it out', () => {
    // A caller handing over a fresh timebase would otherwise stall the
    // scheduler until the old clock was caught up.
    expect(shouldTick({ nowMs: 10, lastTickMs: 10_000, phase: 'moving' })).toBe(true);
  });

  it('treats a non-finite reading as due', () => {
    expect(shouldTick({ nowMs: Number.NaN, lastTickMs: 0, phase: 'moving' })).toBe(true);
    expect(shouldTick({ nowMs: 0, lastTickMs: Number.NaN, phase: 'moving' })).toBe(true);
  });

  it('counts no ticks for a duration that is not one', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expectedTicks(bad, 'moving')).toBe(0);
    }
  });
});
