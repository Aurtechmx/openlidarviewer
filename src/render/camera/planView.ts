/**
 * planView.ts — entering and leaving a 2D-style plan workflow.
 *
 * Plan View is not a second viewer. It is three things the camera can already
 * do, held together and remembered: look straight down, drop the perspective,
 * and put the primary drag on the hand tool so a drag pans instead of orbiting.
 * `Viewer.setStandardView('top')`, `Viewer.setOrthographic(true)` and
 * `NavController.setMode('pan')` each already exist and are each already
 * reachable from the navigation bar.
 *
 * What did not exist is the memory. A user who turns plan off wants the scene
 * they had, not the defaults: the projection they were using and the navigation
 * mode they were in. So this module owns the capture and the restore, and
 * nothing else.
 *
 * It performs no camera work. It answers a question, and the answer is a list of
 * intents the caller executes against the Viewer. That keeps the decision pure
 * and testable in Node, and keeps the camera mathematics in the one place that
 * already owns it. A planner that recomputed a pose here would be a second
 * opinion about where the camera goes.
 *
 * Pure — no DOM, no three.js.
 */

import type { NavMode } from '../NavController';
import type { StandardView } from './cameraPresets';

/** The one thing a caller does with this module's output. */
export type PlanViewIntent =
  | { readonly kind: 'standardView'; readonly view: StandardView }
  | { readonly kind: 'orthographic'; readonly on: boolean }
  | { readonly kind: 'navMode'; readonly mode: NavMode };

/** What plan mode captured on the way in, so leaving can put it back. */
export interface PlanViewRestore {
  readonly mode: NavMode;
  readonly orthographic: boolean;
}

/** Whether plan mode is on, and what it owes the scene when it turns off. */
export interface PlanViewState {
  readonly active: boolean;
  /** Null whenever `active` is false. Never read on the way in. */
  readonly restore: PlanViewRestore | null;
}

/** The scene facts the planner reads. */
export interface PlanViewContext {
  readonly mode: NavMode;
  readonly orthographic: boolean;
  /**
   * False when the hand tool is unavailable (the `?handPan=off` dev flag).
   * `NavController.setMode` refuses `'pan'` in that case and returns silently,
   * so asking for it anyway would leave plan mode in orbit while claiming to be
   * pan-navigated. Plan still enters; it just keeps orbit and says so.
   */
  readonly handPanAvailable: boolean;
}

/** A fresh, inactive state. */
export const PLAN_VIEW_OFF: PlanViewState = { active: false, restore: null };

/** The result of a transition: the new state, and what to execute. */
export interface PlanViewTransition {
  readonly state: PlanViewState;
  readonly intents: readonly PlanViewIntent[];
}

/**
 * Enter plan mode from `ctx`.
 *
 * Captures the mode and projection FIRST, so the restore describes the scene as
 * the user left it rather than as plan mode rewrote it. Entering while already
 * active is a no-op that keeps the original capture: re-entering must not
 * overwrite the memory with plan mode's own top-down orthographic state, which
 * would strand the user there.
 */
export function enterPlanView(state: PlanViewState, ctx: PlanViewContext): PlanViewTransition {
  if (state.active) return { state, intents: [] };

  const intents: PlanViewIntent[] = [
    { kind: 'standardView', view: 'top' },
    { kind: 'orthographic', on: true },
  ];
  // Only ask for the mode the controller can actually honour.
  if (ctx.handPanAvailable && ctx.mode !== 'pan') {
    intents.push({ kind: 'navMode', mode: 'pan' });
  }

  return {
    state: {
      active: true,
      restore: { mode: ctx.mode, orthographic: ctx.orthographic },
    },
    intents,
  };
}

/**
 * Leave plan mode, restoring what was captured.
 *
 * Only what actually changed is emitted, so leaving a scene that was already
 * orthographic does not flip the projection, and leaving from a session that
 * started in pan does not switch the mode. Leaving when inactive is a no-op.
 *
 * The camera is returned to the FRONT standard view rather than left looking
 * straight down. A user turning plan off is asking for the 3D view back, and
 * top-down with perspective restored is neither the plan they had nor the scene
 * they wanted. `leavePlanView` emits `standardView: 'front'` and the tests pin
 * that; the comment previously said "iso", which no code path produced.
 */
export function leavePlanView(state: PlanViewState): PlanViewTransition {
  if (!state.active || !state.restore) return { state: PLAN_VIEW_OFF, intents: [] };

  const { mode, orthographic } = state.restore;
  const intents: PlanViewIntent[] = [];
  if (!orthographic) intents.push({ kind: 'orthographic', on: false });
  intents.push({ kind: 'standardView', view: 'front' });
  if (mode !== 'pan') intents.push({ kind: 'navMode', mode });

  return { state: PLAN_VIEW_OFF, intents };
}

/** Enter when off, leave when on. */
export function togglePlanView(state: PlanViewState, ctx: PlanViewContext): PlanViewTransition {
  return state.active ? leavePlanView(state) : enterPlanView(state, ctx);
}

/**
 * Whether a scene fact drifting out from under plan mode should drop it.
 *
 * Plan mode is a claim about how the scene is set up, so it must not keep
 * claiming that after the user changes the projection or the view by hand. The
 * navigation mode is deliberately NOT part of this: panning is what plan mode is
 * for, and a user switching to orbit for one look has not left plan.
 */
export function planViewSurvives(orthographicStillOn: boolean, viewStillTop: boolean): boolean {
  return orthographicStillOn && viewStillTop;
}
