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
import type { CameraPresetName, StandardView } from '../render/camera/cameraPresets';
import type { Viewer } from '../render/Viewer';
import type { NavMode } from '../render/NavController';
import type { PlanViewController } from '../render/camera/planViewController';
import { loadPlanViewController } from '../lazyChunks';
import { retryableOnce } from '../app/lazySurfaceLoad';

export interface NavBarWiringDeps {
  /** Null until the lazy render chunk resolves. */
  readonly getViewer: () => Viewer | null;
  /** The bar these callbacks were handed to. Read at click time, never at build time. */
  readonly getNavBar: () => NavBar | null;
  readonly toast: (message: string) => void;
  /** Passed through to the plan controller; the tests drive the wait by hand. */
  readonly defer?: (fn: () => void) => (() => void) | void;
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
  /**
   * Aim the camera at a standard view and tell Plan View, without a toast.
   * The bar, the ViewCube and the palette all reach the camera through these
   * four, so Plan View hears about every route. False when nothing moved.
   */
  readonly showStandardView: (view: StandardView) => boolean;
  /** Switch the projection, tell Plan View and sync the Ortho chip. */
  readonly setOrthographic: (on: boolean) => boolean;
  /** Jump to a camera preset and tell Plan View. False when nothing moved. */
  readonly applyCameraPreset: (name: CameraPresetName) => boolean;
  /** Frame all: an oblique overview, so Plan View no longer holds. */
  readonly frameAll: () => void;
  /** Frame all already ran inside the viewer (its R key); tell Plan View. */
  readonly noteFrameAll: () => void;
  /**
   * Run a saved-view restore, then drop Plan View without touching the camera
   * and re-read the Ortho chip: the restore set pose and projection itself.
   */
  readonly restoreCamera: (restore: () => void) => void;
  /**
   * The viewer's navigation mode changed. The bar follows it, and a change made
   * by a mode shortcut drops Plan's pending mode change.
   */
  readonly navModeChanged: (mode: NavMode, byKey?: boolean) => void;
  /**
   * Turn the camera to a ViewCube edge or corner direction (pivot → camera, in
   * the scene basis) around the current pivot. Tells Plan View the camera has
   * left the top view, so its chip cannot stay on.
   */
  readonly onOrientView: (dir: readonly [number, number, number]) => void;
  /** Show or hide the Navigation panel, as its button beside the mode triangle does. */
  readonly toggleNavigationPanel: () => void;
}

/** Capitalise a lowercase view / preset name for the toast. */
const titleCase = (name: string): string => name[0].toUpperCase() + name.slice(1);

export function createNavBarWiring(deps: NavBarWiringDeps): NavBarWiring {
  /** The controller once its chunk has landed; null before the first press. */
  let plan: PlanViewController | null = null;

  // One load shared by every press; the next press retries a failed one.
  const planController = retryableOnce(() =>
    loadPlanViewController().then(({ createPlanViewController }) => {
      plan = createPlanViewController({
        viewport: () => deps.getViewer(),
        defer: deps.defer,
        onStatus: deps.toast,
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
    }),
  );

  const togglePlanView = async (): Promise<void> => {
    (await planController()).toggle();
  };

  /** The Ortho chip follows the viewer, whoever changed the projection. */
  const syncOrthoChip = (): void => {
    const viewer = deps.getViewer();
    if (viewer) deps.getNavBar()?.setOrthographicActive(viewer.orthographic);
  };

  // The one place a camera move reaches Plan View. The viewer runs first and
  // the note follows, so the note sees the scene as the user left it.
  const showStandardView = (view: StandardView): boolean => {
    if (!deps.getViewer()?.setStandardView(view)) return false;
    plan?.noteStandardView(view);
    return true;
  };
  const setOrthographic = (on: boolean): boolean => {
    const fired = deps.getViewer()?.setOrthographic(on) ?? false;
    plan?.noteOrthographic(on);
    syncOrthoChip();
    return fired;
  };
  const applyCameraPreset = (name: CameraPresetName): boolean => {
    if (!deps.getViewer()?.setCameraPreset(name)) return false;
    plan?.noteCameraPreset(name);
    return true;
  };
  // Frame all tilts to the oblique overview, which is no standard view.
  const noteFrameAll = (): void => plan?.noteCustomView();
  const frameAll = (): void => {
    deps.getViewer()?.frameAll();
    noteFrameAll();
  };

  const callbacks: NavBarCallbacks = {
    onMode: (mode) => {
      deps.getViewer()?.setMode(mode);
      plan?.noteManualNavigation();
    },
    onSpeed: (multiplier) => deps.getViewer()?.setNavSpeed(multiplier),
    onReset: frameAll,
    onCameraPreset: (name) => {
      if (!applyCameraPreset(name)) return;
      deps.toast(`Camera · ${titleCase(name)} view.`);
    },
    onStandardView: (view, orientation) => {
      if (orientation) {
        // The ViewCube turns in place around the pivot rather than refitting.
        if (!deps.getViewer()?.orientView(orientation.dir)) return;
        plan?.noteStandardView(view);
      } else if (!showStandardView(view)) return;
      deps.toast(`View · ${titleCase(view)}.`);
    },
    onOrthographic: (on) => {
      setOrthographic(on);
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
    showStandardView,
    setOrthographic,
    applyCameraPreset,
    frameAll,
    noteFrameAll,
    restoreCamera: (restore) => {
      restore();
      plan?.reset();
      syncOrthoChip();
    },
    navModeChanged: (mode, byKey) => {
      deps.getNavBar()?.setMode(mode);
      if (byKey) plan?.noteManualNavigation();
    },
    onOrientView: (dir) => {
      if (!deps.getViewer()?.orientView(dir)) return;
      plan?.noteCustomView();
    },
    toggleNavigationPanel: () => deps.getNavBar()?.toggleNavigationPanel(),
  };
}
