/**
 * navBarWiring.ts — the navigation bar's handlers, lifted out of the shell.
 *
 * They were five one-liners in `main.ts` for as long as every control was
 * independent. Plan View is not: it composes the standard view, the projection
 * and the navigation mode, and it stops being true the moment the user changes
 * one of them by hand. That gives the bar a state that outlives a single click,
 * and a set of handlers that have to tell it what the user just did.
 *
 * So the callbacks and the plan-mode wiring are built together here, and the
 * shell keeps one construction site. Two things are reached lazily:
 *
 *   The bar itself, because it is constructed FROM these callbacks. Nothing
 *   calls it until the user has clicked something, by which point it exists.
 *
 *   The plan controller, because plan mode holds no state until it is entered.
 *   The handlers that report a manual change ask it only if it already exists,
 *   so an unused camera mode costs the startup shell nothing.
 */

import type { NavBar, NavBarCallbacks } from './NavBar';
import type { CameraPresetName } from '../render/camera/cameraPresets';
import type { Viewer } from '../render/Viewer';
import type { PlanViewController } from '../render/camera/planViewController';
import { loadPlanViewController } from '../lazyChunks';

export interface NavBarWiringDeps {
  /** Null until the lazy render chunk resolves. */
  readonly getViewer: () => Viewer | null;
  /** The bar these callbacks were handed to. Read at click time, never at build time. */
  readonly getNavBar: () => NavBar | null;
  readonly toast: (message: string) => void;
  /** Passed through to the plan controller; the tests drive the wait by hand. */
  readonly defer?: (fn: () => void) => void;
}

export interface NavBarWiring {
  readonly callbacks: NavBarCallbacks;
  /**
   * Enter or leave plan mode. Exposed so the command palette reaches the same
   * toggle the chip does. Resolves once the press has been applied.
   */
  readonly togglePlanView: () => Promise<void>;
  /** Forget plan mode because the scan it described has closed. */
  readonly resetPlanView: () => void;
  /**
   * Report a camera preset fired from somewhere other than this bar, so plan
   * mode stops claiming a scene the user has aimed away from.
   */
  readonly notePlanViewPreset: (name: CameraPresetName) => void;
}

/** Capitalise a lowercase view / preset name for the toast. */
const titleCase = (name: string): string => name[0].toUpperCase() + name.slice(1);

export function createNavBarWiring(deps: NavBarWiringDeps): NavBarWiring {
  /** The controller once its chunk has landed; null before the first press. */
  let plan: PlanViewController | null = null;
  let loading: Promise<PlanViewController> | null = null;

  function planController(): Promise<PlanViewController> {
    loading ??= loadPlanViewController().then(({ createPlanViewController }) => {
      plan = createPlanViewController({
        viewport: () => deps.getViewer(),
        defer: deps.defer,
        onChange: (active, reason) => {
          const bar = deps.getNavBar();
          bar?.setPlanActive(active);
          // Plan mode turns the projection on and off behind the Ortho chip's
          // back, so the chip is re-read off the viewer rather than left where
          // the last click put it.
          const viewer = deps.getViewer();
          if (bar && viewer) bar.setOrthographicActive(viewer.orthographic);
          if (reason !== 'toggle') return;
          deps.toast(
            active
              ? 'Plan view on — top down, parallel projection.'
              : 'Plan view off — previous view restored.',
          );
        },
      });
      return plan;
    });
    return loading;
  }

  const togglePlanView = async (): Promise<void> => {
    (await planController()).toggle();
  };

  const callbacks: NavBarCallbacks = {
    onMode: (mode) => deps.getViewer()?.setMode(mode),
    onSpeed: (multiplier) => deps.getViewer()?.setNavSpeed(multiplier),
    onReset: () => deps.getViewer()?.frameAll(),
    onCameraPreset: (name) => {
      if (!deps.getViewer()?.setCameraPreset(name)) return;
      plan?.noteCameraPreset(name);
      deps.toast(`Camera · ${titleCase(name)} view.`);
    },
    onStandardView: (view) => {
      if (!deps.getViewer()?.setStandardView(view)) return;
      plan?.noteStandardView(view);
      deps.toast(`View · ${titleCase(view)}.`);
    },
    onOrthographic: (on) => {
      deps.getViewer()?.setOrthographic(on);
      plan?.noteOrthographic(on);
      deps.toast(on ? 'Orthographic (parallel) view on.' : 'Perspective view restored.');
    },
    onPlanView: () => void togglePlanView(),
  };

  // Neither of these loads the chunk: a controller that was never built holds
  // no claim to drop.
  return {
    callbacks,
    togglePlanView,
    resetPlanView: () => plan?.reset(),
    notePlanViewPreset: (name) => plan?.noteCameraPreset(name),
  };
}
