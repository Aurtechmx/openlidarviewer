/**
 * compassController.ts
 *
 * The whole life cycle of the on-canvas compass / ViewCube: the persisted
 * on/off preference, the lazy mount, the rAF loop that spins the rose, and the
 * visibility handling that stops that loop while the tab is hidden.
 *
 * This exists because those four things are one mechanism and were four
 * module-scope `let`s in `main.ts` — `compassEnabled`, `compassHandle`,
 * `compassRaf`, `compassVisHandler` — read and written by five functions that
 * nothing else in the file touched. The only reason they sat at module scope
 * was that the functions had to share them, which is what an object is for.
 * Sitting there they were also indistinguishable from real app-wide state:
 * anything in a seven-thousand-line file can reach a top-level `let`, and the
 * rAF handle in particular is the kind of thing a second writer turns into a
 * leaked animation frame.
 *
 * The rest of the app now sees three methods — `refresh`, `isEnabled`,
 * `setEnabled` — plus `attachViewer` once the lazy Viewer chunk resolves. The
 * viewer and the platform (rAF, visibility, storage) come in as narrow
 * structural types rather than the concrete `Viewer`, `window` and
 * `localStorage`, so a test can drive the whole life cycle — including the
 * open-then-close race that the mount-time re-validation guards against —
 * without a browser or a renderer.
 */

import { loadViewCube } from '../lazyChunks';
import { storageGet, storageSet } from './safeStorage';
import type { CameraOrientation, CubeOrientation, CubeTarget, StandardView } from '../render/viewCubeMath';
import type { ViewCubeHandle, ViewCubeOptions } from './viewCube';

/** The slice of the Viewer the compass reads. */
export interface CompassViewer {
  /** Open clouds — the compass stays down while this is empty. */
  clouds(): { readonly length: number };
  /** Camera orientation in the scene basis (scene up axis), read once per drawn frame. */
  cameraOrientation(): CameraOrientation;
  /**
   * Run a listener after every drawn frame; returns the unsubscribe.
   *
   * The compass used to poll the heading on an animation frame of its own,
   * for as long as a scan was open. A heading cannot change without a frame,
   * so that was a second loop asking a question the render loop answers, and
   * it kept asking after the render loop learned to sleep.
   */
  onDrawnFrame(listener: () => void): () => void;
  /** Snap the camera to one of the gizmo's faces (fallback when no `onView` is routed). */
  setStandardView(view: StandardView): unknown;
  /** Turn the camera to a cube direction around the current pivot (fallback for `onOrient`). */
  orientView(dir: CubeOrientation['dir']): unknown;
  /** Fit the whole scan (the cube's Home control). */
  frameAll(): unknown;
}

/**
 * The browser services the compass needs, injectable for tests.
 *
 * No animation frame and no visibility handler any more: the compass updates
 * from the render loop's drawn frames, which already stop when the tab is
 * hidden and when nothing is happening.
 */
export interface CompassPlatform {
  /** Persisted preference; null when unset or unreadable (private mode). */
  readPref(): string | null;
  writePref(value: string): void;
  /**
   * Whether the viewport is phone-sized. A phone keeps the cube off unless the
   * user turned it on: at 390 px the top-right corner holds the header
   * controls and the project card, and a touch-sized cube (156 px) would cover
   * a fifth of the scan. Optional; absent means not a phone.
   */
  isPhone?(): boolean;
}

export interface CompassControllerOptions {
  /** Where to mount the gizmo. Read at mount time, as the old code did. */
  host: () => HTMLElement;
  /** The page's query string — `?viewcube=1` / `?viewcube=0` override the preference. */
  urlParams: URLSearchParams;
  /**
   * Resolves the ViewCube's mount function. Defaults to the lazy chunk. The
   * loader is separate from the mount call on purpose: the guards below re-run
   * after the load and before anything is put in the DOM.
   */
  loadCube?: () => Promise<(opts: ViewCubeOptions) => ViewCubeHandle>;
  /** Defaults to `window` / `document` / `localStorage`. */
  platform?: CompassPlatform;
  /**
   * Whether the active scan's orientation is geographically known (a projected
   * or geographic CRS). Drives the rose labels: cardinals when true, truthful
   * local B/R/F/L when false. Defaults to false — a scan whose frame is unknown
   * must not be shown geographic cardinals it cannot substantiate.
   */
  cardinalsAreGeographic?: () => boolean;
  /**
   * Route a face click. The shell passes the NavBar's own standard-view
   * callback (`navBarWiring`), so a compass snap updates Plan View exactly as
   * the NavBar's view buttons do. Without it the compass falls back to the
   * viewer's bare `setStandardView`, which knows nothing about Plan View.
   */
  onView?: (view: StandardView, orientation: CubeOrientation) => void;
  /**
   * Route an edge or corner click. The shell passes navBarWiring's
   * `onOrientView`, which also tells Plan View the camera left the top view.
   */
  onOrient?: (target: CubeTarget, orientation: CubeOrientation) => void;
  /** The Home control. Defaults to the viewer's `frameAll`. */
  onHome?: () => void;
}

export interface CompassController {
  /** Bind the viewer once its lazy chunk resolves, then reconcile. */
  attachViewer(viewer: CompassViewer): void;
  /** Start or stop the compass to match the preference AND scan presence. */
  refresh(): void;
  isEnabled(): boolean;
  /** Show or hide the compass and persist the choice. */
  setEnabled(on: boolean): void;
}

const COMPASS_PREF_KEY = 'olv.compass';

/** The real browser services. Built on demand so importing this is DOM-free. */
export function browserCompassPlatform(): CompassPlatform {
  return {
    readPref: () => storageGet(COMPASS_PREF_KEY),
    writePref: (value) => storageSet(COMPASS_PREF_KEY, value),
    isPhone: () => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches,
  };
}

/**
 * Build the compass controller. Nothing mounts until `attachViewer` has run,
 * a scan is open and the preference is on.
 */
export function createCompassController(opts: CompassControllerOptions): CompassController {
  const platform = opts.platform ?? browserCompassPlatform();
  const loadCube =
    opts.loadCube ?? ((): Promise<(o: ViewCubeOptions) => ViewCubeHandle> =>
      loadViewCube().then(({ mountViewCube }) => mountViewCube));

  let enabled = ((): boolean => {
    if (opts.urlParams.get('viewcube') === '0') return false;
    if (opts.urlParams.has('viewcube')) return true;
    // On by default for everyone who has not turned it off; a phone keeps it
    // off until asked (see CompassPlatform.isPhone). An explicit stored choice
    // wins either way.
    const pref = platform.readPref();
    if (pref === 'on') return true;
    if (pref === 'off') return false;
    return !(platform.isPhone?.() ?? false);
  })();
  let viewer: CompassViewer | null = null;
  let handle: ViewCubeHandle | null = null;
  let unsubscribe: (() => void) | null = null;

  function start(): void {
    if (!enabled || handle || !viewer) return;
    // Nothing to orient until a scan is open — don't float the compass over the
    // empty drop state.
    if (viewer.clouds().length === 0) return;
    const v = viewer;
    void loadCube().then((mountViewCube) => {
      // Re-validate at mount time: the lazy chunk load is async, so the scan may
      // have been closed (or the compass toggled off, or one already mounted)
      // while it loaded. Without the clouds() recheck the compass would mount over
      // the empty state after a fast open-then-close.
      if (!enabled || handle || v.clouds().length === 0) return;
      const cube = mountViewCube({
        host: opts.host(),
        getOrientation: () => v.cameraOrientation(),
        // N/E/S/W only when the CRS is known AND the scene is Z-up: on a Y-up
        // scan the horizontal axes are not a map grid.
        isGeographic: () => (opts.cardinalsAreGeographic?.() ?? false) && v.cameraOrientation().upIsZ,
        onView: opts.onView ?? ((view) => void v.setStandardView(view)),
        onOrient: opts.onOrient ?? ((_t, o) => void v.orientView(o.dir)),
        onHome: opts.onHome ?? ((): void => void v.frameAll()),
      });
      handle = cube;
      // One update straight away: the first drawn frame may be a while off on
      // a parked camera, and the cube must not sit unturned until then.
      cube.update();
      unsubscribe = v.onDrawnFrame(() => cube.update());
    })
      // Additive HUD: a chunk-load failure must not surface as an unhandled
      // rejection (the caller is synchronous and can't catch this promise).
      .catch((err) => console.warn('[compass] view-cube chunk failed to load', err));
  }

  function stop(): void {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (handle) { handle.dispose(); handle = null; }
  }

  function refresh(): void {
    if (enabled && viewer && viewer.clouds().length > 0) start();
    else stop();
  }

  return {
    attachViewer(v: CompassViewer): void {
      viewer = v;
      refresh();
    },
    refresh,
    isEnabled: () => enabled,
    setEnabled(on: boolean): void {
      enabled = on;
      platform.writePref(on ? 'on' : 'off');
      refresh();
    },
  };
}
