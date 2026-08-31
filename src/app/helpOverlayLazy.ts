/**
 * helpOverlayLazy.ts — defer the static Help overlay to the first open.
 *
 * The overlay (should-have #15) is pure static markup with no live state,
 * opened only from the tool dock's Help button or the `onToggleHelp`
 * shortcut. Nothing before that first open can need it, so `main.ts` holds
 * only this thin wrapper eagerly; the overlay class itself rides a lazy
 * chunk (`loadHelpOverlay`).
 */

import type { HelpOverlay } from '../ui/HelpOverlay';
import { loadHelpOverlay } from '../lazyChunks';

export interface HelpOverlayLazy {
  /** `false` before the first mount — the overlay cannot be open yet. */
  isOpen(): boolean;
  /** Open the overlay, mounting it into `overlayHost` on first call. */
  open(): void;
  /** Toggle the overlay; a call before the first mount opens it. */
  toggle(): void;
}

export function createHelpOverlayLazy(overlayHost: HTMLElement): HelpOverlayLazy {
  let overlay: HelpOverlay | null = null;
  let loading: Promise<HelpOverlay> | null = null;

  function ensure(): Promise<HelpOverlay> {
    if (overlay) return Promise.resolve(overlay);
    if (loading) return loading;
    loading = loadHelpOverlay().then((mod) => {
      const created = new mod.HelpOverlay();
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
    toggle: () => {
      if (overlay) overlay.toggle();
      else void ensure().then((o) => o.open());
    },
  };
}
