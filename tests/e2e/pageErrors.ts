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
 */

const BENIGN_PAGE_ERROR = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i;

/** True when a `pageerror` message is a benign, engine-specific notification. */
export function isBenignPageError(message: string): boolean {
  return BENIGN_PAGE_ERROR.test(message);
}
