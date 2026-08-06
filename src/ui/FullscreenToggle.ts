/**
 * FullscreenToggle.ts
 *
 * A header button that toggles the browser Fullscreen API on the whole app
 * (document root). The glyph swaps between an "expand to corners" enter mark
 * and an "arrows inward" exit mark, and stays in sync with the actual
 * Fullscreen API state, so Esc and a second click both leave the button
 * correct. The host owes it three things: mount `element`, mount `status`
 * beside it (the live region for a refused request), and call `dispose()` on
 * teardown. The change listeners live on the document, which outlives any one
 * host, so an undisposed instance never goes away.
 *
 * It does NOT track F11. F11 is the browser's own fullscreen, which is a
 * window state rather than an element one: it fires no `fullscreenchange` and
 * leaves `document.fullscreenElement` null, and no cross-browser API reports
 * it. An earlier comment here claimed the button reflected F11, and on Windows
 * — where F11 is the usual way to do this — it did not. The labels say "app
 * full screen" so the two are not conflated.
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

/**
 * Element-level Fullscreen API availability.
 *
 * True only when the document element exposes `requestFullscreen` (or the
 * webkit prefix) AND the matching `fullscreenEnabled` / `webkitFullscreenEnabled`
 * flag is explicitly true. iPhone WebKit (Safari / Brave / every iOS browser)
 * exposes the request on `HTMLVideoElement` only and never reports an enabled
 * flag of true for the document, so it is correctly treated as unsupported and
 * the button is hidden instead of shown-but-inert. Android Chromium and iPadOS
 * report the flag true and pass. The manifest's `display: standalone` covers the
 * iPhone case for an installed copy.
 */
export function fullscreenSupported(doc: Document = document): boolean {
  const d = doc as FsDoc & { fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean };
  const root = doc.documentElement as FsEl | null;
  if (!root) return false;
  // Standard API (modern desktop + Android Chromium). `fullscreenEnabled` must
  // be EXPLICITLY true: it is false inside a permission-blocked or sandboxed
  // iframe, and it is the flag iPhone WebKit never sets true for the document.
  if (typeof root.requestFullscreen === 'function' && d.fullscreenEnabled === true) {
    return true;
  }
  // Prefixed API (older desktop Safari, which reports webkitFullscreenEnabled
  // === true). Crucially we do NOT trust the bare request method's presence:
  // iPhone WebKit (Safari / Brave / any iOS browser) exposes a
  // requestFullscreen only on <video> and never reports an enabled flag of true
  // for the document, so this stays false and the dead button is hidden rather
  // than shown-but-inert. iPadOS and Android report the flag true and still pass.
  if (typeof root.webkitRequestFullscreen === 'function' && d.webkitFullscreenEnabled === true) {
    return true;
  }
  return false;
}

/**
 * How long a refusal message stays in the live region. Long enough for a
 * polite announcement to be picked up, short enough that a stale sentence is
 * not still sitting in the DOM when the user tries again.
 */
const STATUS_LINGER_MS = 6000;

export class FullscreenToggle {
  readonly element: HTMLButtonElement;
  /**
   * Polite live region for a refused request. A separate node rather than the
   * button's own text: anything inside the button becomes part of its
   * accessible name, and the name has to keep saying what the button does.
   * The host mounts it next to `element`.
   */
  readonly status: HTMLElement;

  /**
   * Optional route to the application's single polite live region.
   *
   * Supplied by the host, because the regions belong to the application and
   * there is exactly one of each. When it is absent the refusal still reaches a
   * sighted user through `status` and the tooltip, and a screen reader gets
   * nothing, which is a smaller failure than two competing live regions.
   */
  private readonly _announceTo: ((message: string) => void) | null;

  /**
   * Handlers held so `dispose()` can detach them. The click one is on the
   * button, which the host owns and may keep; the change ones are on the
   * document, which outlives every Stage, so leaving them attached keeps this
   * instance (and the button it closes over) alive for the page's lifetime.
   */
  private readonly _onClick: () => void;
  private readonly _onFullscreenChange: () => void;
  private readonly _supported: boolean;
  private _statusTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

  constructor(options: { announce?: (message: string) => void } = {}) {
    this._announceTo = options.announce ?? null;
    this.element = el('button', {
      className: 'olv-fs-toggle',
      unsafeHtml: ICON_ENTER,
      title: 'Enter app full screen',
      ariaLabel: 'Enter app full screen',
    }) as HTMLButtonElement;
    this.element.type = 'button';
    this.element.setAttribute('aria-pressed', 'false');
    // No role or aria-live here, deliberately. The application mounts exactly
    // one polite live region and one assertive one, and `a11yAnnouncements`
    // asserts that count. A second role="status" gives a screen reader two
    // competing polite queues, so announcements interleave unpredictably and
    // the reason the single-region layout exists is lost. This node carries the
    // refusal text for sighted users and for the tooltip; the announcement
    // itself goes through the host's shared region via `announce`.
    this.status = el('div', { className: 'olv-fs-status olv-visually-hidden' });

    this._supported = fullscreenSupported();
    // No element-level Fullscreen API: the control has no effect, so it is not rendered.
    if (!this._supported) {
      this.element.hidden = true;
      this.status.hidden = true;
    }

    this._onClick = () => {
      this.element.blur();
      this._toggle();
    };
    this._onFullscreenChange = () => this._sync();
    // A hidden button cannot be clicked and an absent API fires no change
    // event, so registering on an unsupported platform would only leave
    // document listeners behind on behalf of a control nobody can reach.
    if (this._supported) {
      this.element.addEventListener('click', this._onClick);
      document.addEventListener('fullscreenchange', this._onFullscreenChange);
      // Safari prefixed event.
      document.addEventListener(
        'webkitfullscreenchange' as 'fullscreenchange',
        this._onFullscreenChange,
      );
    }
  }

  /** Detach every listener. Pair with the host's own teardown. */
  dispose(): void {
    this._disposed = true;
    if (this._statusTimer !== null) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    if (!this._supported) return;
    this.element.removeEventListener('click', this._onClick);
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
    document.removeEventListener(
      'webkitfullscreenchange' as 'fullscreenchange',
      this._onFullscreenChange,
    );
  }

  private _isFullscreen(): boolean {
    const d = document as FsDoc;
    return !!(document.fullscreenElement || d.webkitFullscreenElement);
  }

  private _toggle(): void {
    if (!this._supported) return;
    const d = document as FsDoc;
    if (this._isFullscreen()) {
      const exit = document.exitFullscreen ?? d.webkitExitFullscreen;
      const p = exit?.call(document) as Promise<void> | undefined;
      if (typeof p?.catch === 'function') {
        p.catch(() => this._announce('Could not leave full screen.'));
      }
      return;
    }
    const root = document.documentElement as FsEl;
    const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
    const p = request?.call(root) as Promise<void> | undefined;
    if (typeof p?.catch === 'function') {
      p.catch(() => this._announce('The browser refused full screen for this page.'));
    }
  }

  /**
   * Report a refused request. Rejection stays non-fatal (the page is fine and
   * the button is still correct), but silence read as a dead control, because
   * a permissions-policy or iframe-sandbox refusal looks identical to nothing
   * happening. The host routes it to the application's one polite live region, and the
   * tooltip carries it too, so the message
   * reaches a screen reader and a pointer user alike.
   */
  private _announce(message: string): void {
    // The control is hidden where the API is missing, so there is no
    // user-initiated request to report on and nothing is emitted.
    if (!this._supported) return;
    // A requestFullscreen rejection can resolve after teardown. Writing then
    // would touch a detached node and arm a six-second timer nothing cancels.
    if (this._disposed) return;
    this.status.textContent = message;
    this.element.title = message;
    this._announceTo?.(message);
    if (this._statusTimer !== null) clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this.status.textContent = '';
      this._sync(); // restores the title the refusal borrowed
    }, STATUS_LINGER_MS);
  }

  private _sync(): void {
    const fs = this._isFullscreen();
    this.element.innerHTML = fs ? ICON_EXIT : ICON_ENTER;
    this.element.title = fs ? 'Exit app full screen' : 'Enter app full screen';
    this.element.setAttribute('aria-label', fs ? 'Exit app full screen' : 'Enter app full screen');
    this.element.setAttribute('aria-pressed', fs ? 'true' : 'false');
    this.element.classList.toggle('is-fs', fs);
  }
}
