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
import { presentWorkbenchSection } from './profileWorkbenchSection';
import { loadProfileWorkbench } from '../lazyChunks';

import type { ProfileWorkbenchLauncher } from './profileWorkbenchLauncher';
import type { WorkbenchSectionScene } from './profileWorkbenchSection';

export interface ProfileWorkbenchRuntimeDeps {
  /** The stage the dock shares its box with. */
  stage: { root: HTMLElement };
  /** The live scene, read at open time so a dock is a snapshot of that moment. */
  scene: WorkbenchSectionScene;
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
  return createProfileWorkbenchLauncher({
    load: () => loadProfileWorkbench(),
    stage: createStageProfileWorkbench(deps.stage),
    present: (handle, request) => presentWorkbenchSection(handle, request.id, deps.scene),
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
