/**
 * helpOverlayLazy.ts
 *
 * Defer the Help overlay to the first open. The overlay is built from the
 * action registry and the key binding table, so the first open awaits both
 * the overlay chunk and the registry; nothing before that first open needs
 * either, and `main.ts` holds only this thin wrapper eagerly.
 */

import type { HelpOverlay } from '../ui/HelpOverlay';
import type { ActionDescriptor } from '../ui/actionRegistry';
import { loadHelpOverlay } from '../lazyChunks';

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
}

export function createHelpOverlayLazy(overlayHost: HTMLElement, deps: HelpOverlayLazyDeps): HelpOverlayLazy {
  let overlay: HelpOverlay | null = null;
  let loading: Promise<HelpOverlay> | null = null;

  function ensure(): Promise<HelpOverlay> {
    if (overlay) return Promise.resolve(overlay);
    if (loading) return loading;
    loading = Promise.all([loadHelpOverlay(), deps.getActions()]).then(([mod, actions]) => {
      const created = new mod.HelpOverlay({ actions, shortcuts: mod.shortcutDescriptors() });
      overlayHost.append(created.element);
      overlay = created;
      loading = null;
      return created;
    });
    return loading;
  }

  return {
    isOpen: () => overlay?.isOpen ?? false,
    open: () => { void ensure().then((o) => o.open()); },
    openTopic: (id) => { void ensure().then((o) => o.openTopic(id)); },
    openForAction: (id) => { void ensure().then((o) => o.openForAction(id)); },
    toggle: () => {
      if (overlay) overlay.toggle();
      else void ensure().then((o) => o.open());
    },
  };
}
