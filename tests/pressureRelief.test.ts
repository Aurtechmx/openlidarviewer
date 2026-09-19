import { describe, it, expect } from 'vitest';
import {
  freesMemory,
  ladderFor,
  MEMORY_LADDER,
  FRAME_LADDER,
  PHASE_COUNT_LADDER,
  fewerPhases,
  reliefAvailable,
  nextRelief,
  applyRelief,
  hasReliefRemaining,
  MIN_PHASE_COUNT,
  type Relief,
  type ReliefState,
} from '../src/render/continuity/pressureRelief';
import { CONTINUITY_DISABLED } from '../src/render/continuity/continuityField';
import { DPR_MOTION_FLOOR, DPR_QUANT_STEP } from '../src/render/adaptiveDpr';
import { DEFAULT_PHASE_COUNT, type PhaseCount } from '../src/render/continuity/temporalPhase';

const FULL: ReliefState = {
  capabilities: {
    ...CONTINUITY_DISABLED,
    coverageSizing: true,
    microGapFill: true,
    temporalAccumulation: true,
    evidenceLens: true,
  },
  historyDpr: 2,
  phaseCount: 8,
};

/** Keep asking for relief and applying it until nothing is left. */
function drain(start: ReliefState, kind: 'memory' | 'frame'): { steps: Relief[]; end: ReliefState } {
  let state = start;
  const steps: Relief[] = [];
  for (let i = 0; i < 50 && hasReliefRemaining(state, kind); i++) {
    const relief = nextRelief(state, kind);
    steps.push(relief);
    const next = applyRelief(state, relief);
    expect(next).not.toBe(state); // progress, not the same object back
    state = next;
  }
  return { steps, end: state };
}

describe('what each step actually frees', () => {
  it('names only the steps that release held memory', () => {
    expect(freesMemory('history-resolution')).toBe(true);
    expect(freesMemory('accumulation')).toBe(true);
    expect(freesMemory('micro-gap')).toBe(false);
    expect(freesMemory('phase-count')).toBe(false);
  });

  it('puts a memory-freeing step first under memory pressure', () => {
    expect(freesMemory(MEMORY_LADDER[0])).toBe(true);
  });

  it('frees the history before giving up a capability that frees nothing', () => {
    const acc = MEMORY_LADDER.indexOf('accumulation');
    expect(acc).toBeLessThan(MEMORY_LADDER.indexOf('micro-gap'));
    expect(acc).toBeLessThan(MEMORY_LADDER.indexOf('phase-count'));
  });

  it('drops per-frame work first under frame pressure', () => {
    expect(FRAME_LADDER.indexOf('phase-count')).toBeLessThan(FRAME_LADDER.indexOf('accumulation'));
    expect(FRAME_LADDER.indexOf('micro-gap')).toBeLessThan(FRAME_LADDER.indexOf('accumulation'));
  });

  it('ends both ladders at source', () => {
    expect(MEMORY_LADDER.at(-1)).toBe('source');
    expect(FRAME_LADDER.at(-1)).toBe('source');
    expect(ladderFor('memory')).toBe(MEMORY_LADDER);
    expect(ladderFor('frame')).toBe(FRAME_LADDER);
  });
});

describe('phase counts stay on the partition', () => {
  it('halves rather than subtracting one', () => {
    expect(fewerPhases(8)).toBe(4);
    expect(fewerPhases(4)).toBe(2);
    expect(fewerPhases(2)).toBeNull();
  });

  it('only ever produces a value the partition accepts', () => {
    let count: PhaseCount | null = 8;
    while (count !== null) {
      expect(PHASE_COUNT_LADDER).toContain(count);
      count = fewerPhases(count);
    }
  });

  it('never leaves the default count at a value the type forbids', () => {
    const state = { ...FULL, phaseCount: DEFAULT_PHASE_COUNT };
    const out = applyRelief(state, 'phase-count');
    expect(PHASE_COUNT_LADDER).toContain(out.phaseCount);
  });
});

describe('a rung that is spent is skipped, not repeated', () => {
  it('stops offering resolution once the ratio is at the floor', () => {
    const atFloor: ReliefState = { ...FULL, historyDpr: DPR_MOTION_FLOOR };
    expect(reliefAvailable(atFloor, 'history-resolution')).toBe(false);
    expect(nextRelief(atFloor, 'memory')).not.toBe('history-resolution');
  });

  it('lowers the ratio by one quantisation step, no further than the floor', () => {
    const once = applyRelief(FULL, 'history-resolution');
    expect(once.historyDpr).toBeCloseTo(FULL.historyDpr - DPR_QUANT_STEP, 10);
    let state = FULL;
    for (let i = 0; i < 20; i++) state = applyRelief(state, 'history-resolution');
    expect(state.historyDpr).toBeGreaterThanOrEqual(DPR_MOTION_FLOOR);
  });

  it('always terminates, whichever pressure is being relieved', () => {
    for (const kind of ['memory', 'frame'] as const) {
      const { steps, end } = drain(FULL, kind);
      expect(steps.length).toBeLessThan(50);
      expect(hasReliefRemaining(end, kind)).toBe(false);
      expect(end.capabilities.temporalAccumulation).toBe(false);
      expect(end.capabilities.microGapFill).toBe(false);
    }
  });

  it('applying a spent step changes nothing', () => {
    const spent: ReliefState = {
      capabilities: { ...CONTINUITY_DISABLED, coverageSizing: true },
      historyDpr: DPR_MOTION_FLOOR,
      phaseCount: MIN_PHASE_COUNT,
    };
    for (const r of ['history-resolution', 'phase-count', 'micro-gap', 'accumulation'] as Relief[]) {
      expect(applyRelief(spent, r)).toBe(spent);
    }
  });
});

describe('dropping the history tidies what described it', () => {
  it('returns the ratio and the sweep to their minima', () => {
    const out = applyRelief(FULL, 'accumulation');
    expect(out.capabilities.temporalAccumulation).toBe(false);
    expect(out.historyDpr).toBe(DPR_MOTION_FLOOR);
    expect(out.phaseCount).toBe(MIN_PHASE_COUNT);
  });

  it('leaves nothing reconstructing at source', () => {
    const out = applyRelief(FULL, 'source');
    expect(out.capabilities.microGapFill).toBe(false);
    expect(out.capabilities.temporalAccumulation).toBe(false);
    expect(out.capabilities.coverageSizing).toBe(false);
    expect(out.capabilities.evidenceLens).toBe(false);
  });
});

describe('the dataset is never a source of relief', () => {
  it('holds no field that could name one', () => {
    const out = applyRelief(FULL, 'accumulation');
    expect(Object.keys(out).sort()).toEqual(['capabilities', 'historyDpr', 'phaseCount']);
  });

  it('changes only display capabilities, never the loader ones', () => {
    const withLoader = {
      ...FULL,
      capabilities: { ...FULL.capabilities, nodeCulling: true, packedAttributes: true },
    };
    for (const kind of ['memory', 'frame'] as const) {
      const { end } = drain(withLoader, kind);
      // Culling and packing describe how the data is carried, not how it looks.
      expect(end.capabilities.nodeCulling).toBe(true);
      expect(end.capabilities.packedAttributes).toBe(true);
    }
  });

  it('gives up everything it can and still reports the viewer intact', () => {
    const { end } = drain(FULL, 'memory');
    expect(hasReliefRemaining(end, 'memory')).toBe(false);
    // The bottom of the ladder is the renderer that already worked.
    expect(end.phaseCount).toBe(MIN_PHASE_COUNT);
  });
});
