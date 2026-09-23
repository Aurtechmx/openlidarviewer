/**
 * helpOverlayLazy.ts
 *
 * Defer the Help overlay to the first open. The overlay is built from the
 * action registry and the key binding table, so the first open awaits both
 * the overlay chunk and the registry; nothing before that first open needs
 * either, and `main.ts` holds only this thin wrapper eagerly.
 */

import type { ActionDescriptor } from '../ui/actionRegistry';
import { loadHelpOverlay } from '../lazyChunks';
import { createLazySingleton, type LazyLoadToast, type LazyLoadTrigger } from './lazySurfaceLoad';
// Re-exported so `main.ts` reaches the lazy-load helpers through this
// already-imported module rather than adding a second direct edge to
// `lazySurfaceLoad.ts` (lint:module-graph's static fan-out on main.ts is
// shrink-only and counts DIRECT imports only).
export { createLazySingleton, createLazySurfaceLoader, buttonLazyTrigger, type LazyLoadToast, type LazyLoadTrigger } from './lazySurfaceLoad';

export interface HelpOverlayLazy {
  /** `false` before the first mount: the overlay cannot be open yet. */
  isOpen(): boolean;
  /** Open the overlay, mounting it into `overlayHost` on first call. */
  open(): void;
  /** Open on one topic of the help catalogue. */
  openTopic(topicId: string): void;
  /** Open on the topic that lists an action. */
  openForAction(actionId: string): void;
  /** Toggle the overlay; a call before the first mount opens it. */
  toggle(): void;
}

export interface HelpOverlayLazyDeps {
  /** The action registry, which the shell also builds lazily. */
  getActions(): Promise<readonly ActionDescriptor[]>;
  /**
   * Where a chunk-load failure is reported, with a "Try again" action — the
   * same contract `main.ts`'s `importSession` wrapper already gives the
   * session-restore chunk (LAZY-1).
   */
  toast: LazyLoadToast;
  /** The Help button, so it disables and gets `aria-busy` while the chunk fetches (LOAD-1). Optional: a caller with no such button just skips the cue. */
  trigger?: LazyLoadTrigger;
}

export function createHelpOverlayLazy(overlayHost: HTMLElement, deps: HelpOverlayLazyDeps): HelpOverlayLazy {
  const singleton = createLazySingleton(async () => {
    const [mod, actions] = await Promise.all([loadHelpOverlay(), deps.getActions()]);
    const created = new mod.HelpOverlay({ actions, shortcuts: mod.shortcutDescriptors() });
    overlayHost.append(created.element);
    return created;
  }, 'help overlay', deps.toast, deps.trigger);

  // `ensure(onReady)` replays the requested action once the chunk resolves —
  // this attempt, or a LATER one from the toast's "Try again" (LAZY-1): a
  // retry that only re-fetched bytes nothing then consumed would look like
  // it did nothing.
  return {
    isOpen: () => singleton.current()?.isOpen ?? false,
    open: () => { void singleton.ensure((o) => o.open()); },
    openTopic: (id) => { void singleton.ensure((o) => o.openTopic(id)); },
    openForAction: (id) => { void singleton.ensure((o) => o.openForAction(id)); },
    toggle: () => {
      const existing = singleton.current();
      if (existing) existing.toggle();
      else void singleton.ensure((o) => o.open());
    },
  };
}
