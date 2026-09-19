/**
 * convergence.ts
 *
 * What a parked camera does with its frames: contribute one temporal phase at a
 * time until every phase has been drawn once, then stop.
 *
 * Accumulation only pays while the camera is still. The camera transform is one
 * of the display inputs, so moving it opens a new epoch and the frames already
 * contributed describe a different picture. This schedule therefore has one
 * job beyond counting: notice that the epoch it was accumulating under is gone,
 * and start over rather than merge new frames into stale ones.
 *
 * Convergence is counted in frames, not milliseconds. How long four frames take
 * is a property of the device, and a wall-clock figure written here would be a
 * claim about hardware this module never sees.
 *
 * The last state matters as much as the schedule. Once every phase has
 * contributed there is nothing left to add, and a renderer that kept redrawing
 * would burn a GPU on an image that cannot change. `converged` is terminal for
 * as long as the epoch holds.
 *
 * Pure: no three.js, no DOM, no clock. The caller owns the history buffers and
 * decides what merging a phase means; this decides only whether to merge one and
 * which. Display only, and nothing here reaches measurement.
 */
import type { PhaseCount } from './temporalPhase';

/** Where a parked camera is in its sweep. */
export type ConvergenceState =
  /** Not accumulating. The camera is moving, or nothing has been drawn yet. */
  | { readonly kind: 'idle' }
  /** Mid-sweep under `epoch`, with `contributed` phases already merged. */
  | {
      readonly kind: 'converging';
      readonly epoch: number;
      readonly nextPhase: number;
      readonly contributed: number;
    }
  /** Every phase has contributed under `epoch`. Terminal until the epoch changes. */
  | { readonly kind: 'converged'; readonly epoch: number };

/** What the renderer knows at the start of a frame. */
export interface ConvergenceInput {
  /** The epoch in force this frame. */
  readonly epoch: number;
  /** Is the camera moving this frame? */
  readonly moving: boolean;
  /** How many phases make up one sweep. */
  readonly phaseCount: PhaseCount;
}

/** Nothing accumulated yet. */
export const IDLE: ConvergenceState = { kind: 'idle' };

/** The epoch a state is accumulating under, or null when it is idle. */
function epochOf(state: ConvergenceState): number | null {
  return state.kind === 'idle' ? null : state.epoch;
}

/**
 * The convergence state for this frame.
 *
 * A moving camera returns to idle, which discards the sweep rather than pausing
 * it: the frames contributed so far were drawn against a camera that has since
 * moved, so resuming would merge two different pictures.
 *
 * An epoch that differs from the one being accumulated restarts the sweep at
 * phase 0 for the same reason, including when the camera is parked. Parking is
 * not the only thing that changes what a pixel means; a colour mode or a filter
 * does too, and both move the epoch.
 */
export function nextConvergence(
  current: ConvergenceState,
  input: ConvergenceInput,
): ConvergenceState {
  if (input.moving) return IDLE;
  if (epochOf(current) !== input.epoch) {
    return { kind: 'converging', epoch: input.epoch, nextPhase: 0, contributed: 0 };
  }
  if (current.kind === 'converged') return current;
  if (current.kind === 'idle') return current;
  const contributed = current.contributed + 1;
  if (contributed >= input.phaseCount) return { kind: 'converged', epoch: input.epoch };
  return {
    kind: 'converging',
    epoch: input.epoch,
    nextPhase: current.nextPhase + 1,
    contributed,
  };
}

/**
 * Which phase this frame should draw, or null when it should draw nothing more.
 *
 * Null at `converged` is the point of the schedule: the image is complete, so
 * the renderer has something to stop for.
 */
export function phaseToDraw(state: ConvergenceState): number | null {
  return state.kind === 'converging' ? state.nextPhase : null;
}

/** Whether the renderer can stop issuing accumulation work. */
export function isConverged(state: ConvergenceState): boolean {
  return state.kind === 'converged';
}
