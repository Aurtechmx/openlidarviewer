/**
 * planViewController.ts — the app side of Plan View.
 *
 * `planView.ts` decides and this executes. It holds the one `PlanViewState` the
 * session has, reads the scene facts the planner needs off the live viewer, and
 * runs the returned intents against it. Nothing here re-derives a decision the
 * pure core already made.
 *
 * Two things the pure core cannot know about, both consequences of what
 * `Viewer.setStandardView` does beyond aiming the camera:
 *
 * 1. It hands the camera back to OrbitControls by calling `setMode('orbit')`.
 *    The core emits no navigation intent when the mode it wants is the mode the
 *    scene is already in, which is correct as a decision and wrong as an
 *    outcome: a user who was already panning would enter plan mode orbiting.
 *    So a mode the core stayed silent about is re-asserted here.
 *
 * 2. It starts a camera tween, and `NavController.setMode` clears the tween in
 *    flight. Applying the navigation intent immediately after the view intent
 *    would therefore cancel the move to top-down and leave the camera wherever
 *    it was. The mode change waits for the tween to land.
 *
 * No DOM and no three.js: the viewer is reached through {@link PlanViewViewport},
 * which `Viewer` satisfies structurally, so the whole wiring runs under Node.
 */

import type { NavMode } from '../NavController';
import type { CameraPresetName, StandardView } from './cameraPresets';
import {
  PLAN_VIEW_OFF,
  enterPlanView,
  leavePlanView,
  planViewSurvives,
  type PlanViewIntent,
  type PlanViewState,
} from './planView';

/** The slice of the viewer plan mode drives. `Viewer` satisfies it structurally. */
export interface PlanViewViewport {
  readonly navMode: NavMode;
  readonly orthographic: boolean;
  readonly handPanEnabled: boolean;
  /** False when no scan is loaded, so there is no bounding sphere to aim at. */
  setStandardView(view: StandardView): boolean;
  setOrthographic(on: boolean): boolean;
  setMode(mode: NavMode): void;
}

/** Why plan mode changed — a deliberate toggle, or the scene drifting away. */
export type PlanViewChange = 'toggle' | 'drift';

export interface PlanViewControllerDeps {
  /** The viewer, or null before the render chunk resolves (plan mode is inert). */
  readonly viewport: () => PlanViewViewport | null;
  /** Plan mode turned on or off. */
  readonly onChange?: (active: boolean, reason: PlanViewChange) => void;
  /**
   * Run `fn` once the standard-view tween has landed. Injected by the tests;
   * production waits {@link PLAN_VIEW_SETTLE_MS}.
   */
  readonly defer?: (fn: () => void) => void;
}

/**
 * How long to wait before applying a navigation mode over a standard-view tween.
 * `Viewer.setStandardView` tweens for 0.8 s and `NavController.setMode` clears
 * an in-flight tween, so a mode applied any earlier stops the camera short of
 * the pose plan mode asked for.
 */
export const PLAN_VIEW_SETTLE_MS = 900;

export interface PlanViewController {
  /** Whether plan mode is on. */
  readonly active: boolean;
  /** Enter when off, leave when on. */
  toggle(): void;
  /**
   * Forget plan mode without touching the camera. For the scan closing: the
   * scene the capture describes is gone, so restoring it would aim at nothing,
   * and a chip still claiming plan would greet the next scan pressed.
   */
  reset(): void;
  /** The user aimed the camera at a standard view themselves. */
  noteStandardView(view: StandardView): void;
  /** The user changed the projection themselves. */
  noteOrthographic(on: boolean): void;
  /** The user jumped the camera to a named preset themselves. */
  noteCameraPreset(name: CameraPresetName): void;
}

export function createPlanViewController(deps: PlanViewControllerDeps): PlanViewController {
  let state: PlanViewState = PLAN_VIEW_OFF;
  /** Whether the camera is still on the top-down view plan mode asked for. */
  let viewIsTop = false;
  /**
   * Bumped by every transition. A deferred mode change carries the generation it
   * was scheduled under and does nothing once that no longer matches, so a fast
   * second toggle cannot be overwritten by the first one's late arrival.
   */
  let generation = 0;
  const defer = deps.defer ?? ((fn: () => void): void => {
    setTimeout(fn, PLAN_VIEW_SETTLE_MS);
  });

  /**
   * Run one transition's intents against the viewer.
   *
   * `fallbackMode` is the mode the scene must end up in when the core named
   * none, because `setStandardView` moved it regardless. `requireScan` aborts
   * the batch when there is no scan to aim at, which is what keeps entering plan
   * mode over an empty stage from flipping the projection and claiming to be a
   * plan of nothing; leaving always runs to completion.
   */
  function apply(
    v: PlanViewViewport,
    intents: readonly PlanViewIntent[],
    fallbackMode: NavMode | null,
    requireScan: boolean,
  ): boolean {
    generation += 1;
    const scheduledUnder = generation;
    let mode: NavMode | null = null;
    let tweening = false;
    for (const intent of intents) {
      switch (intent.kind) {
        case 'standardView': {
          const fired = v.setStandardView(intent.view);
          if (!fired && requireScan) return false;
          if (fired) tweening = true;
          viewIsTop = intent.view === 'top';
          break;
        }
        case 'orthographic':
          v.setOrthographic(intent.on);
          break;
        case 'navMode':
          mode = intent.mode;
          break;
      }
    }
    const target = mode ?? fallbackMode;
    if (target === null) return true;
    if (tweening) {
      defer(() => {
        if (scheduledUnder === generation) v.setMode(target);
      });
    } else {
      v.setMode(target);
    }
    return true;
  }

  /** Drop the claim without restoring anything — the user already moved the scene. */
  function drop(): void {
    if (!state.active) return;
    state = PLAN_VIEW_OFF;
    // Cancels any deferred mode change still owed by the transition that entered.
    generation += 1;
    deps.onChange?.(false, 'drift');
  }

  /** Re-check plan mode's claim about the scene against what the scene now is. */
  function evaluate(orthographic: boolean): void {
    if (!state.active) return;
    if (!planViewSurvives(orthographic, viewIsTop)) drop();
  }

  function leaveNow(v: PlanViewViewport): void {
    // Read the capture before the transition clears it: the mode it names is the
    // one `setStandardView('front')` is about to overwrite with orbit.
    const restore = state.restore;
    const transition = leavePlanView(state);
    state = transition.state;
    apply(v, transition.intents, restore?.mode ?? null, false);
    deps.onChange?.(false, 'toggle');
  }

  return {
    get active(): boolean {
      return state.active;
    },

    toggle(): void {
      const v = deps.viewport();
      if (!v) return;
      if (state.active) {
        leaveNow(v);
        return;
      }
      const ctx = {
        mode: v.navMode,
        orthographic: v.orthographic,
        handPanAvailable: v.handPanEnabled,
      };
      const transition = enterPlanView(state, ctx);
      // The core says nothing when the scene is already panning; the standard
      // view takes the hand tool away anyway, so ask for it back.
      const keepPan = ctx.mode === 'pan' ? ('pan' as NavMode) : null;
      if (!apply(v, transition.intents, keepPan, true)) return;
      state = transition.state;
      deps.onChange?.(true, 'toggle');
    },

    reset(): void {
      drop();
    },

    noteStandardView(view: StandardView): void {
      viewIsTop = view === 'top';
      const v = deps.viewport();
      if (v) evaluate(v.orthographic);
    },

    noteOrthographic(on: boolean): void {
      evaluate(on);
    },

    noteCameraPreset(name: CameraPresetName): void {
      // Only the top preset leaves the camera looking straight down; every other
      // pose is an angled one, which is the user leaving plan.
      viewIsTop = name === 'top';
      const v = deps.viewport();
      if (v) evaluate(v.orthographic);
    },
  };
}
