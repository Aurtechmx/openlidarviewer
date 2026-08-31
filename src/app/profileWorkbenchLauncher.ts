/**
 * profileWorkbenchLauncher.ts
 *
 * What happens when a profile's Expand control is used: the workbench chunk is
 * pulled, one dock is mounted, and the caller is told whether that succeeded.
 *
 * The launcher answers a boolean rather than throwing or rendering a message of
 * its own, because Expand has a working surface either way. `ResultFocus` is
 * the fallback the Measurements panel already owns, so every refusal here —
 * a measurement that is not a profile, a viewport too narrow for a
 * desktop-density dock, no stage to dock into, a rejected import — comes back
 * as `false` and the panel opens the focus view instead. Expand never stops
 * working; only which surface it opens changes.
 *
 * ONE DOCK AT A TIME. A second Expand closes the dock the first one mounted
 * before it mounts its own, so the panel's teardown runs, its stage-resize
 * subscription is released, and the stage height is handed back exactly once.
 * Without that the two docks stack, the second's height arithmetic reads a
 * stage the first is still occupying, and closing either leaves the other's
 * listener alive.
 *
 * Structural throughout: nothing here names the Viewer, the DOM or the chunk
 * loader's real module, so the whole lifecycle runs under Node against plain
 * objects.
 */

import type {
  ProfileWorkbenchHandle,
  ProfileWorkbenchHost,
  ProfileWorkbenchOptions,
} from '../ui/ProfileWorkbench';
import type { ProfileRawScope } from '../render/measure/profileRawFilter';

/** The shape the lazy chunk resolves to. Only the mount function is used. */
export interface ProfileWorkbenchModule {
  mountProfileWorkbench(
    host: ProfileWorkbenchHost,
    options?: ProfileWorkbenchOptions,
  ): ProfileWorkbenchHandle;
}

/** The measurement Expand was used on. */
export interface ProfileWorkbenchLaunchRequest {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
}

/** Where a dock may be mounted, and whether this viewport should carry one. */
export interface ProfileWorkbenchStage {
  /** The dock's host, or null when no stage has been built (bare / embed). */
  host(): ProfileWorkbenchHost | null;
  /**
   * False on a viewport that should not carry a desktop-density dock. The
   * launcher refuses rather than docking a panel the stage cannot afford.
   */
  canDock(): boolean;
  /** Give the scene back the height the dock was occupying. */
  release(): void;
}

export interface ProfileWorkbenchLauncherDeps {
  /** The lazy seam. A rejection is a fallback, never an error the user sees. */
  load: () => Promise<ProfileWorkbenchModule>;
  stage: ProfileWorkbenchStage;
  /**
   * Fill the freshly mounted dock. Called once per successful open.
   *
   * May return a release function, which runs when that dock is closed or
   * replaced: filling a dock subscribes to things (the plot's box, a walk
   * still in flight) that outlive the call and must not outlive the panel.
   */
  present?: (
    handle: ProfileWorkbenchHandle,
    request: ProfileWorkbenchLaunchRequest,
  ) => void | (() => void);
  /**
   * Commit a new name for the measurement a dock is plotting.
   *
   * Routed straight through to whatever the host wired, which is the same
   * rename the Measurements panel's own name field calls. The launcher holds
   * no name: the request it was opened with carries the name at open time, and
   * the one authority on it afterwards is the host.
   *
   * Absent leaves the dock's title a caption rather than a field.
   */
  rename?: (id: string, name: string) => void;
  /**
   * Build the profile PDF for one measurement.
   *
   * The SAME export the Measurements panel's Export PDF control runs, handed
   * over rather than reimplemented: a second builder would be a second set of
   * inputs, and the read scope and classification basis a sheet states are
   * exactly what a second set gets wrong. Absent means the dock renders no
   * export control.
   */
  exportPdf?: (id: string) => Promise<void>;
  /**
   * Save a PNG of the section a dock is plotting.
   *
   * The raster of the returns off the same splat loop as the plot on screen —
   * a different product from the PDF sheet. Composed from the live plot the
   * presenter built, not re-extracted here. Absent means the dock renders no
   * PNG control.
   */
  exportImage?: (request: ProfileWorkbenchLaunchRequest) => Promise<void>;
  /**
   * Show or hide the 3D sample-corridor outline for the section a dock is
   * plotting. Absent means the dock renders no corridor control (and the 3D
   * corridor stays off).
   */
  onToggleCorridor?: (on: boolean) => void;
  /**
   * Re-draw the section's raw scatter through a chosen attribute scope (all /
   * ground / exclude veg & noise). Absent means the dock renders no scope
   * selector and draws every corridor return.
   */
  onRawScope?: (scope: ProfileRawScope) => void;
  /** Told about a rejected import, so a silent fallback still leaves a trace. */
  onLoadFailure?: (error: unknown) => void;
  /** Told about a `present` that threw, for the same reason. */
  onPresentFailure?: (error: unknown) => void;
}

export interface ProfileWorkbenchLauncher {
  /**
   * Open the workbench for `request`.
   *
   * Resolves true when a dock is mounted, false when the caller must fall back
   * to `ResultFocus`. Never rejects.
   */
  open(request: ProfileWorkbenchLaunchRequest): Promise<boolean>;
  /** The mounted dock, or null. */
  readonly handle: ProfileWorkbenchHandle | null;
  /** Close the mounted dock, if any. Idempotent. */
  close(): void;
}

/** The one measurement kind that has a cross-section to inspect. */
const PROFILE_KIND = 'profile';

export function createProfileWorkbenchLauncher(
  deps: ProfileWorkbenchLauncherDeps,
): ProfileWorkbenchLauncher {
  let handle: ProfileWorkbenchHandle | null = null;
  let release: (() => void) | null = null;
  // Every mount takes a token. The panel's own `onClose` clears the field only
  // while its token is still the live one, so a dock closed by the mount that
  // replaced it cannot null out its successor.
  let generation = 0;

  function close(): void {
    const open = handle;
    handle = null;
    generation++;
    release?.();
    release = null;
    open?.close();
    if (open) deps.stage.release();
  }

  async function open(request: ProfileWorkbenchLaunchRequest): Promise<boolean> {
    // Only a profile has a section. Any other kind keeps the focus view, which
    // is the surface built for a compact result.
    if (request.kind !== PROFILE_KIND) return false;
    if (!deps.stage.canDock()) return false;
    const host = deps.stage.host();
    if (!host) return false;

    let module: ProfileWorkbenchModule;
    try {
      module = await deps.load();
    } catch (error) {
      deps.onLoadFailure?.(error);
      return false;
    }

    // Close BEFORE mounting: the replacement's opening height is derived from
    // the stage the outgoing dock is still holding.
    close();
    const token = ++generation;
    // The measurement's own name is the title, so the dock, the Measurements
    // row and the exported sheet are three views of one name. The scope line
    // under it is filled by the presenter with what the section actually read.
    const rename = deps.rename;
    const exportPdf = deps.exportPdf;
    const exportImage = deps.exportImage;
    const onToggleCorridor = deps.onToggleCorridor;
    const onRawScope = deps.onRawScope;
    const mounted = module.mountProfileWorkbench(host, {
      title: request.name,
      scope: request.name,
      ...(rename ? { onRename: (name: string) => rename(request.id, name) } : {}),
      ...(exportPdf ? { onExportPdf: () => exportPdf(request.id) } : {}),
      ...(exportImage ? { onExportImage: () => exportImage(request) } : {}),
      ...(onToggleCorridor ? { onToggleCorridor } : {}),
      ...(onRawScope ? { onRawScope } : {}),
      onClose: () => {
        // Only for the dock that is still the live one: a panel closed by the
        // mount that replaced it must not hand back the successor's height.
        if (token !== generation) return;
        handle = null;
        release?.();
        release = null;
        deps.stage.release();
      },
    });
    handle = mounted;
    try {
      release = deps.present?.(mounted, request) ?? null;
    } catch (error) {
      // A dock nobody could fill is worse than no dock: it holds its share of
      // the stage over a plot that was never drawn. Hand the stage back and
      // answer false, so the caller opens the surface it always had.
      deps.onPresentFailure?.(error);
      close();
      return false;
    }
    return true;
  }

  return {
    open,
    get handle() {
      return handle;
    },
    close,
  };
}
