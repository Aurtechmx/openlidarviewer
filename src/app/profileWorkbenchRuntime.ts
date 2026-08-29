/**
 * profileWorkbenchRuntime.ts
 *
 * Everything the docked Profile Workbench needs, assembled: the stage adapter
 * that decides where a dock goes and how much of the scene it takes, the
 * launcher that owns one dock at a time, and the presenter that fills it.
 *
 * WHY IT IS ASSEMBLED HERE AND NOT IN THE MOUNT. `measurePanelMount.ts` is
 * statically imported by the startup shell, and this assembly reaches the
 * colour pass, the fit and the Canvas 2D renderer — through `profileAxes`, it
 * reaches `profileSummary`, which the shell-isolation guard forbids in the
 * index chunk. Holding the assembly behind a dynamic import keeps the shell
 * carrying a thunk instead of a plot renderer, and nothing here runs until a
 * profile's Expand control is pressed.
 *
 * Structural on the way in: the viewer arrives as a pair of accessors rather
 * than as a `Viewer`, so the runtime can be built against plain objects.
 */

import { createProfileWorkbenchLauncher } from './profileWorkbenchLauncher';
import { createStageProfileWorkbench } from './profileWorkbenchStage';
import {
  exportProfileSectionImagePng,
  presentWorkbenchSection,
} from './profileWorkbenchSection';
import { loadProfileWorkbench } from '../lazyChunks';
import { ProfileLinkOverlay } from '../render/ProfileLinkOverlay';
import { focusPoseOnPoint } from '../render/measure/profilePointLink';

import type { ProfileWorkbenchLauncher } from './profileWorkbenchLauncher';
import type { WorkbenchSectionPlot, WorkbenchSectionScene } from './profileWorkbenchSection';
import type { ProfileLinkOverlayHost } from '../render/ProfileLinkOverlay';
import type { ProfileCameraPose } from '../render/measure/profilePointLink';

/**
 * A UTC timestamp for the exported PNG's caption, in the same deterministic
 * shape the profile PDF prints (`YYYY-MM-DD HH:MM UTC`). Read once, at the
 * export boundary — the compose never reads a clock of its own.
 */
function sectionImageStamp(): string {
  return `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface ProfileWorkbenchRuntimeDeps {
  /** The stage the dock shares its box with. */
  stage: { root: HTMLElement };
  /** The live scene, read at open time so a dock is a snapshot of that moment. */
  scene: WorkbenchSectionScene;
  /**
   * Scene membership for the 3D mark — `viewer.derivedLayerHost()`.
   *
   * Held here rather than on the scene because building the mark needs three,
   * and this module is the first one on the path that is already behind a
   * dynamic import. Absent leaves the link 2D only.
   */
  markerHost?: () => ProfileLinkOverlayHost;
  /**
   * Read and write the camera, for the deliberate focus action on a CLICKED
   * selection. Absent means the workbench simply has no focus action; nothing
   * else changes, and no hover has a path here either way.
   */
  camera?: {
    pose(): ProfileCameraPose;
    apply(pose: { position: [number, number, number]; target: [number, number, number] }): void;
  };
  /**
   * Commit a new name for the measurement a dock is plotting.
   *
   * Wired to the SAME `renameMeasurement` the Measurements panel's name field
   * calls, so the dock's title is a view of the measurement's name rather than
   * a second name kept beside it. Absent leaves the title a caption.
   */
  rename?: (id: string, name: string) => void;
  /**
   * Build the profile PDF for one measurement.
   *
   * Handed in as the Measurements panel's own export, not rebuilt here. The
   * sheet states its read scope and the classification basis of its heights,
   * and a second assembly of the builder's inputs is precisely how a sheet
   * comes to state neither. Absent means the dock renders no export control.
   */
  exportPdf?: (id: string) => Promise<void>;
  /**
   * Told about a rejected panel chunk, or a fill that threw. Defaults to a
   * console record: the user already has the focus view, so nothing about the
   * failure is otherwise visible in the app.
   */
  onLoadFailure?: (error: unknown) => void;
}

/**
 * Build the launcher the Measurements panel's Expand control drives.
 *
 * One per mount: the launcher is what makes a second Expand replace the dock
 * the first one left rather than stack on it, so the caller must hold on to
 * this rather than build a new one per press.
 */
export function createProfileWorkbenchRuntime(
  deps: ProfileWorkbenchRuntimeDeps,
): ProfileWorkbenchLauncher {
  // ONE overlay for the runtime, built on first use and reused by every dock.
  // A per-dock overlay would need the launcher to remember to dispose the
  // previous one, which is exactly the "stale mark left in the scene" bug.
  let overlay: ProfileLinkOverlay | null = null;
  const markerHost = deps.markerHost;
  const camera = deps.camera;

  const scene: WorkbenchSectionScene = {
    ...deps.scene,
    ...(markerHost
      ? {
          markLinkedReturn: (marker): void => {
            if (!marker) {
              overlay?.show(null);
              return;
            }
            overlay ??= new ProfileLinkOverlay(markerHost());
            overlay.show({ position: marker.position, mode: marker.mode, size: marker.size });
          },
        }
      : {}),
    ...(camera
      ? {
          focusPoint: (position): void => {
            camera.apply(focusPoseOnPoint(camera.pose(), position));
          },
        }
      : {}),
  };

  // The plot the live dock is showing, captured when the presenter finishes so
  // the PNG export composes from the same state rather than re-extracting the
  // section. One dock at a time, so one slot: it is cleared when the dock's
  // presentation is released.
  let live: { plot: WorkbenchSectionPlot; name: string } | null = null;

  return createProfileWorkbenchLauncher({
    load: () => loadProfileWorkbench(),
    stage: createStageProfileWorkbench(deps.stage),
    ...(deps.rename ? { rename: deps.rename } : {}),
    ...(deps.exportPdf ? { exportPdf: deps.exportPdf } : {}),
    exportImage: async (request) => {
      const current = live;
      if (!current) {
        throw new Error('The section is not ready to export yet.');
      }
      // The clock is read HERE, at the app boundary, and handed to the compose
      // as a preformatted string, so the same section is the same pixels. Same
      // deterministic stamp shape the PDF sheet prints.
      await exportProfileSectionImagePng(current.plot, {
        name: request.name,
        generatedAt: sectionImageStamp(),
      });
    },
    present: (handle, request) => {
      const dispose = presentWorkbenchSection(handle, request.id, scene, {
        onReady: (plot) => {
          live = { plot, name: request.name };
        },
      });
      return () => {
        live = null;
        dispose();
      };
    },
    onLoadFailure:
      deps.onLoadFailure ??
      ((error) => {
        console.error('OpenLiDARViewer: the profile workbench panel failed to load.', error);
      }),
    onPresentFailure:
      deps.onLoadFailure ??
      ((error) => {
        console.error('OpenLiDARViewer: the profile workbench section failed to draw.', error);
      }),
  });
}
