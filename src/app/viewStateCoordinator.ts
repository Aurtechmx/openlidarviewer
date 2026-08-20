/**
 * viewStateCoordinator.ts — the restorable view-state cluster lifted out of main.ts.
 *
 * One responsibility: turning the live scene into a `ViewStateBundle` and back.
 * That is a single contract with two surfaces — a `.olvsession`'s GLOBAL fields
 * and every named saved view — and they must never drift, so ONE capture path
 * and ONE apply path serve both. This module owns those two paths plus the saved
 * view operations layered on them: capture-as-named-view, the Inspector's name
 * list, and restore-by-index (including the pre-v7 camera-only shape).
 *
 * The ORDER and the present/absent guards stay in the pure orchestrator
 * (`io/viewState.ts`, unit-tested: camera strictly LAST, every field
 * independent). What lives here is the host-side wiring those sinks drive —
 * viewer setters, the Inspector mirror, the class legend, the clip panel — bound
 * through a structural {@link ViewStateCoordinatorDeps} of accessor functions
 * closing over the shell's services, the same seam `openScan` / `sessionIo` /
 * `measurePanelMount` use. `main.ts` keeps thin delegates. Part of the v0.6
 * decomposition (see `docs/architecture/architecture-map.md`).
 *
 * Every collaborator is named structurally rather than by class, so the whole
 * cluster decides against plain object fakes in Node — no three.js, no DOM.
 */

import {
  applyViewStateInOrder,
  buildViewState,
  type ViewStateBundle,
} from '../io/viewState';

import type { ViewBookmarksService } from './viewBookmarks';
import type { RenderingState } from '../ui/Inspector';
import type { SavedCameraState } from '../render/annotate/types';
import type { CameraPose } from '../render/NavController';
import type { ColorMode } from '../render/colorModes';
import type { ClipBox } from '../render/clip/clipBox';
import type { PointSizeMode } from '../render/pointStyle';
import type { SplatMode } from '../render/splatShader';

/**
 * The viewer surface a view state reads and writes. Structural rather than the
 * `Viewer` class: capture/restore touches render settings, colour, filters, the
 * clip and the camera, and nothing else on a 6k-line renderer.
 */
export interface ViewStateViewer {
  readonly pointSize: number;
  readonly edlEnabled: boolean;
  readonly edlStrength: number;
  readonly pointSizeMode: PointSizeMode;
  readonly antialiasing: boolean;
  readonly twoFingerTwistEnabled: boolean;
  readonly splatMode: SplatMode;
  readonly hasStreamingCloud: boolean;
  clouds(): string[];
  activeColorMode(): ColorMode;
  getClip(): ClipBox | null;
  setClip(clip: ClipBox | null): void;
  getCameraState(): SavedCameraState;
  applyCameraState(state: SavedCameraState): void;
  getCameraPose(): CameraPose;
  applyCameraPose(pose: CameraPose): void;
  setPointSize(size: number): void;
  setPointSizeMode(mode: PointSizeMode): void;
  setEdlEnabled(on: boolean): void;
  setEdlStrength(strength: number): void;
  setAntialiasing(on: boolean): void;
  setColorMode(id: string, mode: ColorMode): void;
  setStreamingColorMode(mode: ColorMode): void;
  setElevationFilter(range: readonly [number, number] | undefined): void;
  setIntensityFilter(range: readonly [number, number] | undefined): void;
}

/** The Inspector surface a restore mirrors state onto. */
export interface ViewStateInspector {
  syncRendering(state: RenderingState): void;
  restoreElevationFilter(range: readonly [number, number] | null): void;
  restoreIntensityFilter(range: readonly [number, number] | null): void;
  setViews(names: string[]): void;
}

/** The classification legend, which owns the hidden-class set. */
export interface ViewStateClassLegend {
  getVisibility(): { hiddenCodes(): number[] };
  applyFilter(hiddenCodes: readonly number[]): void;
}

/** The clip panel, which mirrors a restored clip box without re-firing apply. */
export interface ViewStateClipPanel {
  setVisible(on: boolean): void;
  setState(clip: ClipBox): void;
}

/** The shell's live point-filter windows, as capture reads them. */
export interface ActivePointFilters {
  readonly elevation: readonly [number, number] | null;
  readonly intensity: readonly [number, number] | null;
}

/**
 * Accessor functions closing over the shell's late-bound services. `getViewer`
 * is a thunk because the Viewer resolves from a lazy chunk; it is dereferenced
 * only at call time, never at construction.
 */
export interface ViewStateCoordinatorDeps {
  getViewer: () => ViewStateViewer;
  inspector: ViewStateInspector;
  classLegend: ViewStateClassLegend;
  clipPanel: ViewStateClipPanel;
  /** The saved-view list service; only the read/append operations are used. */
  bookmarks: Pick<ViewBookmarksService, 'add' | 'get' | 'names'>;
  /** Whether a scan is on stage — the same predicate that gates the tool shortcuts. */
  hasScan: () => boolean;
  /** The active static scan id, or null when none / streaming. */
  getActiveScanId: () => string | null;
  /** The shell's tracked elevation / intensity windows, read on capture. */
  getPointFilters: () => ActivePointFilters;
  /** Record a restored elevation window back onto the shell's tracked state. */
  onElevationFilterRestored: (range: [number, number]) => void;
  /** Record a restored intensity window back onto the shell's tracked state. */
  onIntensityFilterRestored: (range: [number, number]) => void;
}

/** The view-state controller `main.ts` drives through thin delegates. */
export interface ViewStateCoordinator {
  /** Capture the live scene as a restorable bundle (unset fields pruned). */
  capture(): ViewStateBundle;
  /** Apply a bundle through the ordered sinks — camera strictly last. */
  apply(vs: ViewStateBundle): void;
  /** Capture the current viewpoint AND display state as a named saved view. */
  saveCurrentView(): void;
  /** Push the saved-view names to whichever panel is currently shown. */
  refreshViewsUi(): void;
  /** Glide the camera to a saved view — and (v7) restore its display state. */
  applyView(index: number): void;
}

/** Build the view-state coordinator bound to the live shell services. */
export function createViewStateCoordinator(
  deps: ViewStateCoordinatorDeps,
): ViewStateCoordinator {
  /**
   * ONE capture path for a restorable view state. The session exporter's
   * GLOBAL fields and every named saved view both come from here, so the two
   * surfaces can never drift — what a `.olvsession` restores globally is
   * exactly what a saved view restores by name. `buildViewState` prunes unset
   * fields (emit-only-when-set), which is what keeps a bundle-free view's
   * serialisation byte-identical to the v6 writer's output.
   */
  function capture(): ViewStateBundle {
    const viewer = deps.getViewer();
    const filters = deps.getPointFilters();
    return buildViewState({
      // The camera is meaningful only with a scan on stage — a session exported
      // from the empty state must not carry a bogus default pose. (`hasScan`
      // is the same predicate that gates the tool shortcuts.)
      camera: deps.hasScan() ? viewer.getCameraState() : undefined,
      render: {
        pointSize: viewer.pointSize,
        edlEnabled: viewer.edlEnabled,
        edlStrength: viewer.edlStrength,
        pointSizeMode: viewer.pointSizeMode,
        antialiasing: viewer.antialiasing,
      },
      colorMode: viewer.activeColorMode(),
      // v5 contract — the class filter is the list of HIDDEN ASPRS codes;
      // empty means "no filter" and is pruned rather than serialised.
      classFilter: deps.classLegend.getVisibility().hiddenCodes(),
      // The active point-filter windows, so a restore reproduces "only the
      // ground band" / "hide low-return noise". Omitted when unset.
      ...(filters.elevation || filters.intensity
        ? {
            pointFilters: {
              ...(filters.elevation ? { elevation: filters.elevation } : {}),
              ...(filters.intensity ? { intensity: filters.intensity } : {}),
            },
          }
        : {}),
      // Whenever the viewer holds a clip — enabled or not — so a
      // positioned-but-dormant box keeps its geometry across the round trip.
      clip: viewer.getClip() ?? undefined,
    }) ?? {};
  }

  /**
   * ONE apply path for a restorable view state — session import and named-view
   * restore both route through here. The field ORDER and the present/absent
   * guards live in the pure orchestrator (`io/viewState.ts`, unit-tested:
   * camera strictly LAST, every field independent); the sinks below carry the
   * host-specific wiring.
   *
   * Streaming honesty: a restore re-applies the recipe and re-renders — on a
   * streaming cloud the resident node set varies with budget and load order,
   * so identical point MEMBERSHIP is not guaranteed, only the same
   * camera/clip/colour/filter state over whatever is resident.
   */
  function apply(vs: ViewStateBundle): void {
    const viewer = deps.getViewer();
    applyViewStateInOrder(vs, {
      render: (r) => {
        viewer.setPointSize(r.pointSize);
        viewer.setPointSizeMode(r.pointSizeMode);
        viewer.setEdlEnabled(r.edlEnabled);
        viewer.setEdlStrength(r.edlStrength);
        viewer.setAntialiasing(r.antialiasing);
        deps.inspector.syncRendering({
          pointSize: viewer.pointSize,
          edlEnabled: viewer.edlEnabled,
          edlStrength: viewer.edlStrength,
          pointSizeMode: viewer.pointSizeMode,
          antialiasing: viewer.antialiasing,
          twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
          splatMode: viewer.splatMode,
        });
      },
      colorMode: (mode) => {
        // Apply to every static cloud; the streaming subsystem too.
        for (const id of viewer.clouds()) viewer.setColorMode(id, mode);
        viewer.setStreamingColorMode(mode);
      },
      classFilter: (codes) => {
        // v5 — re-apply the saved class-visibility filter. The panel re-renders
        // and emits onChange, which the host has wired to the GPU mask, so the
        // restored scan shows the same classes the author left visible.
        deps.classLegend.applyFilter(codes);
      },
      pointFilters: (pf) => {
        // v6 — re-apply the saved elevation / intensity windows, but ONLY when
        // a scan is actually loaded. The elevation window is converted to the
        // cloud's attribute space using that cloud's origin + up-axis; applying
        // it with no scan present would convert against origin 0 and the
        // default axis, so the window would be wrong the moment a scan did
        // load. A view state is an overlay for an open scan, so "no scan ⇒
        // skip the filter" is the correct, non-surprising behaviour.
        if (deps.getActiveScanId() == null && !viewer.hasStreamingCloud) return;
        // The Inspector extents were seeded when the scan opened, so restoring
        // writes the window into the inputs and drives the GPU filter + cue.
        if (pf.elevation) {
          viewer.setElevationFilter(pf.elevation);
          deps.inspector.restoreElevationFilter(pf.elevation);
          deps.onElevationFilterRestored([pf.elevation[0], pf.elevation[1]]);
        }
        if (pf.intensity) {
          viewer.setIntensityFilter(pf.intensity);
          deps.inspector.restoreIntensityFilter(pf.intensity);
          deps.onIntensityFilterRestored([pf.intensity[0], pf.intensity[1]]);
        }
      },
      clip: (clip) => {
        // Restore the saved clip box so a shared capsule reproduces the
        // author's isolation/cut-away, not an unclipped scene.
        viewer.setClip(clip);
        deps.clipPanel.setVisible(true);
        // Reflect the restored clip in the panel UI without re-firing onApply —
        // the viewer already holds it, and firing through the panel while its
        // own enabled flag was still false used to clear the restored clip.
        deps.clipPanel.setState(clip);
      },
      camera: (camera) => {
        // Fly the live camera to the saved viewpoint — the orchestrator applies
        // this LAST, so nothing after it can move the restored framing.
        viewer.applyCameraState(camera);
      },
    });
  }

  /** Push the saved-view names to whichever panel is currently shown. */
  function refreshViewsUi(): void {
    const names = deps.bookmarks.names();
    // Saved views live in the Inspector for both static and streaming scans — the
    // Inspector's Saved-views section stays visible in streaming mode, so there is
    // one list (with rename + delete) rather than a second copy in the stream panel.
    deps.inspector.setViews(names);
  }

  return {
    capture,
    apply,
    refreshViewsUi,

    /**
     * Capture the current viewpoint AND display state as a named saved view.
     * The pose keeps the v6 camera-bookmark slot; everything else the exporter
     * would record globally (render, colour mode, class filter, point filters,
     * clip) rides in the bundle, so restoring the view by name reproduces the
     * full picture — the "Figure 3 = view state 'north-scarp'" contract.
     */
    saveCurrentView(): void {
      const { camera, ...rest } = capture();
      // `getCameraState` (not the bare pose) so a non-default FOV or nav mode is
      // part of what the view restores; the empty-state fallback keeps the old
      // bare-pose behaviour when no scan gates the capture.
      deps.bookmarks.add({
        pose: camera ?? deps.getViewer().getCameraPose(),
        state: buildViewState(rest),
      });
      refreshViewsUi();
    },

    /** Glide the camera to a saved view — and (v7) restore its display state. */
    applyView(index: number): void {
      const view = deps.bookmarks.get(index);
      if (!view) return;
      if (!view.state) {
        // A pre-v7 (camera-only) view keeps its exact old behaviour: glide the
        // pose and touch nothing else — not even the FOV, which the richer
        // applyCameraState path would reset to the default.
        deps.getViewer().applyCameraPose(view.pose);
        return;
      }
      // Full restore through the one apply path; the pose rides as the bundle's
      // camera so the orchestrator applies it LAST.
      apply({ ...view.state, camera: view.pose });
    },
  };
}
