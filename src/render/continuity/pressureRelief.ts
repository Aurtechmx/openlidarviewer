/**
 * pressureRelief.ts
 *
 * What to give up, and in what order, when the history will not fit or an
 * allocation has already failed.
 *
 * The ordering is the whole content of this file, and it is decided by what
 * each step actually frees rather than by how much it sounds like a sacrifice.
 * Only one thing in the subsystem holds memory between frames: the three
 * history surfaces. Their cost is the backing-store area times bytes per pixel,
 * so lowering the ratio they are allocated at frees memory quadratically, and
 * dropping accumulation frees all of it.
 *
 * Two of the steps free nothing. Closing micro-gaps reads neighbouring depths
 * within a frame and allocates nothing that persists. Shortening the sweep
 * changes how many frames a convergence takes, not how large the surfaces are,
 * because the history is one set of surfaces rather than one per phase. Both
 * reduce work, so both are relief for a device that cannot hold a frame rate.
 * Neither is relief for a device that cannot hold memory, and offering them as
 * such would spend a user's picture quality on a problem it does not touch.
 *
 * That is a departure from the suggested order, which drops micro-gap closure
 * before accumulation. Under memory pressure that sequence gives up the cheaper
 * capability first and frees nothing by doing it, leaving the pressure exactly
 * where it was while the picture is already worse. Under frame pressure the
 * suggested order is right, and it is the order the frame ladder uses.
 *
 * A rung can be exhausted rather than taken, which the tier ladder has no way
 * to express. Lowering the history ratio is relief until the ratio reaches the
 * legibility floor, and after that asking again has to move to the next rung
 * instead of returning the same state and letting a caller loop.
 *
 * The dataset is not a source of relief and cannot become one. Nothing in this
 * file's state describes a scan, a node, a point or a buffer of coordinates: it
 * holds display capabilities, a ratio and a phase count. A caller under real
 * pressure is holding the authoritative points somewhere, and a subsystem that
 * offered to release them would be trading the data for a picture of the data.
 *
 * Detection is taken as a fact rather than performed here. The browser exposes
 * no portable pressure signal, so the one this subsystem can trust is an
 * allocation that did not succeed, which `continuityFailure` already names.
 *
 * Pure: no GPU, no allocation, no DOM.
 */
import { DPR_MOTION_FLOOR, DPR_QUANT_STEP } from '../adaptiveDpr';
import type { ContinuityCapabilities } from './continuityField';
import type { PhaseCount } from './temporalPhase';

/** One thing that can be given up. */
export type Relief =
  /** Allocate the history at a lower pixel ratio. Frees memory quadratically. */
  | 'history-resolution'
  /** Contribute fewer phases per sweep. Frees no memory. */
  | 'phase-count'
  /** Stop closing gaps between samples. Frees no memory. */
  | 'micro-gap'
  /** Stop keeping a history at all. Frees every surface. */
  | 'accumulation'
  /** Draw the samples as they are. Nothing left to give up. */
  | 'source';

/** What kind of pressure is being relieved. */
export type PressureKind = 'memory' | 'frame';

/** Whether a step releases memory that was being held between frames. */
export function freesMemory(relief: Relief): boolean {
  return relief === 'history-resolution' || relief === 'accumulation' || relief === 'source';
}

/**
 * The order steps are taken in, for each kind of pressure.
 *
 * Memory gives up the surfaces, cheapest first, and only then the capabilities
 * that cost frame time. Frame gives up the per-frame work first, which is the
 * suggested order and is correct for the pressure it answers.
 */
export const MEMORY_LADDER: readonly Relief[] = [
  'history-resolution',
  'accumulation',
  'micro-gap',
  'phase-count',
  'source',
];

export const FRAME_LADDER: readonly Relief[] = [
  'history-resolution',
  'phase-count',
  'micro-gap',
  'accumulation',
  'source',
];

/** The ladder for a kind of pressure. */
export function ladderFor(kind: PressureKind): readonly Relief[] {
  return kind === 'memory' ? MEMORY_LADDER : FRAME_LADDER;
}

/** The fewest phases a sweep is still worth running with. */
export const MIN_PHASE_COUNT: PhaseCount = 2;

/**
 * Phase counts, richest first.
 *
 * `PhaseCount` is `2 | 4 | 8` rather than any integer, so a step down halves
 * rather than subtracting one: seven phases is not a value the partition
 * accepts. The powers of two are what make the partition's arithmetic exact,
 * and a relief step is not the place to give that up.
 */
export const PHASE_COUNT_LADDER: readonly PhaseCount[] = [8, 4, 2];

/** The next count down, or null at the minimum. */
export function fewerPhases(count: PhaseCount): PhaseCount | null {
  const i = PHASE_COUNT_LADDER.indexOf(count);
  return i < 0 || i >= PHASE_COUNT_LADDER.length - 1 ? null : PHASE_COUNT_LADDER[i + 1];
}

/**
 * Everything relief may change.
 *
 * Display state only. There is no field here that names a dataset, and that
 * absence is the guarantee rather than a comment about one.
 */
export interface ReliefState {
  readonly capabilities: ContinuityCapabilities;
  /** The ratio the history is allocated at. */
  readonly historyDpr: number;
  /** Phases per sweep. */
  readonly phaseCount: PhaseCount;
}

/** Whether a step has anything left to give at this state. */
export function reliefAvailable(state: ReliefState, relief: Relief): boolean {
  switch (relief) {
    case 'history-resolution':
      return state.capabilities.temporalAccumulation && state.historyDpr > DPR_MOTION_FLOOR;
    case 'phase-count':
      return state.capabilities.temporalAccumulation && fewerPhases(state.phaseCount) !== null;
    case 'micro-gap':
      return state.capabilities.microGapFill;
    case 'accumulation':
      return state.capabilities.temporalAccumulation;
    case 'source':
      return false;
  }
}

/**
 * The next step to take, or 'source' when the ladder is spent.
 *
 * Skips rungs with nothing left to give rather than returning them, so a caller
 * that asks again after applying one always makes progress. Without that, a
 * history already at the floor would answer 'history-resolution' forever.
 */
export function nextRelief(state: ReliefState, kind: PressureKind): Relief {
  for (const relief of ladderFor(kind)) {
    if (reliefAvailable(state, relief)) return relief;
  }
  return 'source';
}

/** The capabilities of a viewer that has given everything up. */
function sourceCapabilities(caps: ContinuityCapabilities): ContinuityCapabilities {
  return {
    ...caps,
    coverageSizing: false,
    microGapFill: false,
    temporalAccumulation: false,
    evidenceLens: false,
  };
}

/**
 * The state after taking one step.
 *
 * Applying a step that has nothing left to give returns the state unchanged, so
 * this is safe to call with a stale decision. `nextRelief` is what picks a step
 * that will do something.
 *
 * Dropping accumulation also returns the ratio to the floor and the sweep to
 * its minimum. Both describe a history that no longer exists, and leaving them
 * at whatever they had reached would hand a later re-enable a pair of numbers
 * that were chosen while the device was under pressure.
 */
export function applyRelief(state: ReliefState, relief: Relief): ReliefState {
  if (relief !== 'source' && !reliefAvailable(state, relief)) return state;
  switch (relief) {
    case 'history-resolution': {
      const lowered = Math.max(DPR_MOTION_FLOOR, state.historyDpr - DPR_QUANT_STEP);
      return { ...state, historyDpr: lowered };
    }
    case 'phase-count': {
      const fewer = fewerPhases(state.phaseCount);
      return fewer === null ? state : { ...state, phaseCount: fewer };
    }
    case 'micro-gap':
      return { ...state, capabilities: { ...state.capabilities, microGapFill: false } };
    case 'accumulation':
      return {
        capabilities: { ...state.capabilities, temporalAccumulation: false },
        historyDpr: DPR_MOTION_FLOOR,
        phaseCount: MIN_PHASE_COUNT,
      };
    case 'source':
      return {
        capabilities: sourceCapabilities(state.capabilities),
        historyDpr: DPR_MOTION_FLOOR,
        phaseCount: MIN_PHASE_COUNT,
      };
  }
}

/**
 * Whether the subsystem has anything left to release.
 *
 * False means the next pressure event has to be answered somewhere else, which
 * is the point at which a caller learns that continuing to ask here will not
 * help. It never means the viewer has stopped working.
 */
export function hasReliefRemaining(state: ReliefState, kind: PressureKind): boolean {
  return ladderFor(kind).some((r) => reliefAvailable(state, r));
}
