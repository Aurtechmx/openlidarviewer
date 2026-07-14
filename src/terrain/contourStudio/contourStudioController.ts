/**
 * contourStudioController.ts
 *
 * A tiny observable store around the Contour Studio state (v0.5.9 spec §8). It
 * holds the current `ContourStudioState`, applies actions through the pure
 * reducer, and notifies subscribers. No DOM — the workspace UI renders from it
 * and dispatches back into it, so the whole workflow stays unit-testable without
 * a browser.
 */

import {
  baseContourStudioState,
  type ContourStudioState,
} from './contourStudioState';
import {
  contourStudioReducer,
  type ContourStudioAction,
} from './contourStudioReducer';

export interface ContourStudioController {
  getState(): ContourStudioState;
  dispatch(action: ContourStudioAction): void;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: (state: ContourStudioState) => void): () => void;
}

export function createContourStudioController(
  initial: ContourStudioState = baseContourStudioState(),
): ContourStudioController {
  let state = initial;
  const listeners = new Set<(state: ContourStudioState) => void>();

  return {
    getState: () => state,
    dispatch(action) {
      const next = contourStudioReducer(state, action);
      if (next === state) return; // reducer returned the same reference — no-op
      state = next;
      for (const l of listeners) l(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
