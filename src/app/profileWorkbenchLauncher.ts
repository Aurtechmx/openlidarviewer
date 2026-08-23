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
  /** Fill the freshly mounted dock. Called once per successful open. */
  present?: (handle: ProfileWorkbenchHandle, request: ProfileWorkbenchLaunchRequest) => void;
  /** Told about a rejected import, so a silent fallback still leaves a trace. */
  onLoadFailure?: (error: unknown) => void;
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
  // Every mount takes a token. The panel's own `onClose` clears the field only
  // while its token is still the live one, so a dock closed by the mount that
  // replaced it cannot null out its successor.
  let generation = 0;

  function close(): void {
    const open = handle;
    handle = null;
    generation++;
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
    const mounted = module.mountProfileWorkbench(host, {
      title: 'Profile workbench',
      scope: request.name,
      onClose: () => {
        // Only for the dock that is still the live one: a panel closed by the
        // mount that replaced it must not hand back the successor's height.
        if (token !== generation) return;
        handle = null;
        deps.stage.release();
      },
    });
    handle = mounted;
    deps.present?.(mounted, request);
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
