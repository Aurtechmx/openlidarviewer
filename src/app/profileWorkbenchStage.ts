/**
 * profileWorkbenchStage.ts
 *
 * The stage side of the docked Profile Workbench: where the dock is appended,
 * what height it is allowed to share, and what happens to the 3D canvas when
 * that share changes.
 *
 * THE DOCK AND THE SCENE SPLIT ONE BOX. `.olv-stage` and the dock are flow
 * siblings inside the app root, so giving the dock N pixels means taking N
 * pixels off the stage — written as `calc(100% - Npx)` rather than a resolved
 * number so a window resize keeps the split without anyone recomputing it.
 * The 3D canvas is `inset: 0` inside the stage, so its box follows, and the
 * Viewer's own `ResizeObserver` on that canvas is what re-projects the camera
 * and resizes the drawing buffer. Nothing here calls the renderer: the resize
 * entry point already exists and observes the element this module moves.
 *
 * Closing the dock restores the inline height to empty, handing the stage back
 * to the stylesheet rather than to a number this module guessed.
 *
 * MOBILE. `canDock()` is false under the shared mobile-layout condition, so a
 * phone keeps the `ResultFocus` surface. The dock's arithmetic reserves the
 * scene a minimum height out of a stage a phone barely has, and the surface a
 * phone wants is the full-height sheet, not a split view — see the note on
 * `MOBILE_LAYOUT_QUERY` for why that condition, and not a raw width, decides.
 *
 * Structural deps throughout, so the whole adapter runs under Node against
 * plain objects: it never reaches for `document`, `window` or `localStorage`.
 */

import { matchesMobileLayout } from '../ui/isMobileDevice';
import { storageGet, storageSet } from '../ui/safeStorage';

import type { ProfileWorkbenchHost, ProfileWorkbenchStorage } from '../ui/ProfileWorkbench';
import type { ProfileWorkbenchStage } from './profileWorkbenchLauncher';

/** A minimal element seam — a real `HTMLElement` is assignable. */
export interface WorkbenchStageElement {
  readonly style: { height: string };
}

export interface ProfileWorkbenchStageDeps {
  /**
   * The box the stage and the dock share — the app root. The dock is appended
   * here, after the stage, so it occupies the height the stage gives up.
   */
  container(): HTMLElement | null;
  /** The stage element whose height the dock takes from. */
  stage(): WorkbenchStageElement | null;
  /** Subscribe to changes of the shared box. Returns the unsubscribe. */
  onContainerResize(callback: () => void): () => void;
  /** Viewport width, height, and whether the pointer is coarse. */
  viewport(): { width: number; height: number; coarsePointer: boolean };
  /** Persisted dock preference. Absent ⇒ the dock opens at its default. */
  storage?: ProfileWorkbenchStorage;
  prefersReducedMotion?(): boolean;
}

/**
 * Build the dock's stage adapter.
 *
 * `host()` returns null until both the container and the stage exist, which is
 * what makes the bare / embed layouts (no stage built) refuse cleanly instead
 * of mounting a dock into nothing.
 */
export function createProfileWorkbenchStage(
  deps: ProfileWorkbenchStageDeps,
): ProfileWorkbenchStage {
  function canDock(): boolean {
    const { width, height, coarsePointer } = deps.viewport();
    return !matchesMobileLayout(width, height, coarsePointer);
  }

  function host(): ProfileWorkbenchHost | null {
    const container = deps.container();
    const stage = deps.stage();
    if (!container || !stage) return null;
    return {
      container: () => container,
      // The dock's whole allowance is the shared box, not the stage's current
      // height — the stage is already shorter by whatever the dock occupies,
      // and deriving from that would shrink the allowance on every apply.
      stageHeight: () => container.clientHeight,
      onStageResize: (callback) => deps.onContainerResize(callback),
      notifyDockHeight: (dockPx) => {
        // The Viewer resizes because its canvas's box changed. This is the
        // only write that makes that true.
        stage.style.height = dockPx > 0 ? `calc(100% - ${dockPx}px)` : '';
      },
      storage: deps.storage,
      prefersReducedMotion: deps.prefersReducedMotion
        ? () => deps.prefersReducedMotion!()
        : undefined,
    };
  }

  /**
   * Hand the stage its full height back.
   *
   * A closed panel reports no height at all — there is no final
   * `notifyDockHeight(0)` to lean on — so leaving the inline `calc()` behind
   * would keep the scene short with nothing below it.
   */
  function release(): void {
    const stage = deps.stage();
    if (stage) stage.style.height = '';
  }

  return { host, canDock, release };
}

/**
 * The browser-backed stage adapter the shell wires.
 *
 * Reads `window` and the DOM directly, which is exactly why it is the thin
 * outer shell around {@link createProfileWorkbenchStage} rather than part of
 * it: everything decided about heights, docking and the mobile refusal lives
 * in the structural core above, and is tested there against plain objects.
 *
 * The container is the stage's own parent — the app root, which the stage and
 * the dock split between them.
 */
export function createStageProfileWorkbench(host: { root: HTMLElement }): ProfileWorkbenchStage {
  return createProfileWorkbenchStage({
    container: () => host.root.parentElement,
    stage: () => host.root,
    onContainerResize: (callback) => {
      const parent = host.root.parentElement;
      if (!parent || typeof ResizeObserver !== 'function') return () => {};
      const observer = new ResizeObserver(() => callback());
      observer.observe(parent);
      return () => observer.disconnect();
    },
    viewport: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      coarsePointer:
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
    }),
    // Guarded storage: a bare localStorage read throws in a sandboxed iframe
    // (the embed path) and in some privacy modes.
    storage: { getItem: storageGet, setItem: storageSet },
    prefersReducedMotion: () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}
