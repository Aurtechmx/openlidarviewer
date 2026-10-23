/**
 * pageErrors.ts — shared filter for benign browser `pageerror` noise in e2e.
 *
 * WebKit surfaces "ResizeObserver loop completed with undelivered notifications"
 * (and Chromium the older "ResizeObserver loop limit exceeded") as a `pageerror`
 * event. These are benign browser notifications, NOT application faults: they
 * fire when a ResizeObserver callback itself triggers layout, which is expected
 * for responsive panels and camera/view toggles. Chromium/Firefox mostly stay
 * quiet; WebKit does not, so specs that assert "no page errors" flaked on WebKit
 * only. Filter them at the collector so the assertion means what it says — a real
 * uncaught error — on every engine.
 *
 * The WebKit build that ships with Playwright 1.64 (WebKit 27.2) also logs a
 * `console.error` each time a `<select>` element is created on a page whose CSP
 * has no 'unsafe-inline' in style-src: the engine's own inner tree for the
 * control carries a style attribute, and the engine checks it against the
 * page's policy (`style-src-attr`, one report per `<select>`, none for any later
 * change to it). A bare `<select>` on an empty page with `style-src 'self'`
 * reproduces it; the WebKit build of Playwright 1.63 does not. The app builds
 * its selects with `document.createElement('select')` and sets no inline style
 * on them, so this is engine noise, not an application fault.
 *
 * The allowance is the exact WebKit sentence. WebKit prints the same sentence
 * for an inline style the app itself sets, so on WebKit an app-raised inline
 * style is no longer caught here; Chromium and Firefox word that report
 * differently ("Refused to apply inline style …", "Content-Security-Policy: …
 * blocked an inline style …"), so the Chromium gate and the Firefox leg still
 * fail on it, and the journeys record the `securitypolicyviolation` events
 * themselves (tests/e2e/journeys/helpers/journey.ts). Remove the entry once
 * Playwright's WebKit stops reporting a plain `<select>`.
 */

const BENIGN_PAGE_ERROR = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i;

/** WebKit 27.2's report for the inline style inside its own `<select>` control. */
export const WEBKIT_SELECT_CSP_REPORT =
  /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$/;

/** True when a `pageerror` or `console.error` message is benign, engine-specific noise. */
export function isBenignPageError(message: string): boolean {
  return BENIGN_PAGE_ERROR.test(message) || WEBKIT_SELECT_CSP_REPORT.test(message);
}
