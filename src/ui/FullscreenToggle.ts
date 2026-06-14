/**
 * FullscreenToggle.ts
 *
 * A header button that toggles the browser Fullscreen API on the whole app
 * (document root). The glyph swaps between an "expand to corners" enter mark
 * and an "arrows inward" exit mark, and stays in sync with the actual
 * fullscreen state — so it reflects the user pressing F11 or Esc directly,
 * not just clicks on this button. Self-contained: no host wiring needed.
 *
 * Safari still ships the webkit-prefixed Fullscreen API, so request/exit/state
 * and the change event are all read through prefixed fallbacks.
 */

import { el } from './dom';

function svg(inner: string): string {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>'
  );
}

/** Enter — two diagonal arrows pushing out to opposite corners. */
const ICON_ENTER = svg(
  '<path d="M14 4h6v6"/><path d="M20 4l-7 7"/>' +
    '<path d="M10 20H4v-6"/><path d="M4 20l7-7"/>',
);
/** Exit — two diagonal arrows pulling inward. */
const ICON_EXIT = svg(
  '<path d="M20 10h-6V4"/><path d="M20 4l-7 7"/>' +
    '<path d="M4 14h6v6"/><path d="M4 20l7-7"/>',
);

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export class FullscreenToggle {
  readonly element: HTMLButtonElement;

  constructor() {
    this.element = el('button', {
      className: 'olv-fs-toggle',
      unsafeHtml: ICON_ENTER,
      title: 'Enter full screen',
      ariaLabel: 'Enter full screen',
    }) as HTMLButtonElement;
    this.element.type = 'button';
    this.element.setAttribute('aria-pressed', 'false');

    this.element.addEventListener('click', () => {
      this.element.blur();
      this._toggle();
    });
    document.addEventListener('fullscreenchange', () => this._sync());
    // Safari prefixed event.
    document.addEventListener(
      'webkitfullscreenchange' as 'fullscreenchange',
      () => this._sync(),
    );
  }

  private _isFullscreen(): boolean {
    const d = document as FsDoc;
    return !!(document.fullscreenElement || d.webkitFullscreenElement);
  }

  private _toggle(): void {
    const d = document as FsDoc;
    if (this._isFullscreen()) {
      const exit = document.exitFullscreen ?? d.webkitExitFullscreen;
      const p = exit?.call(document);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {});
      }
      return;
    }
    const root = document.documentElement as FsEl;
    const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
    const p = request?.call(root);
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => {});
    }
  }

  private _sync(): void {
    const fs = this._isFullscreen();
    this.element.innerHTML = fs ? ICON_EXIT : ICON_ENTER;
    this.element.title = fs ? 'Exit full screen' : 'Enter full screen';
    this.element.setAttribute('aria-label', fs ? 'Exit full screen' : 'Enter full screen');
    this.element.setAttribute('aria-pressed', fs ? 'true' : 'false');
    this.element.classList.toggle('is-fs', fs);
  }
}
