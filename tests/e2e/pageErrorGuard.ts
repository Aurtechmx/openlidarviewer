/**
 * pageErrorGuard.ts — the shared allowlist for benign browser notifications the
 * e2e page-error / console-error collectors must NOT count as failures.
 *
 * "ResizeObserver loop completed with undelivered notifications" (and the older
 * "ResizeObserver loop limit exceeded") is a spec-compliant NOTIFICATION, not an
 * error: the observer could not deliver every callback within one animation
 * frame, so the browser reschedules and emits this. It has no functional impact
 * and fires nondeterministically under CI load — WebKit especially. Without this
 * filter it reds `expect(pageErrors).toEqual([])` on whatever PR happens to be
 * building, regardless of that PR's changes, so a benign notification becomes a
 * phantom failure on unrelated work.
 *
 * Keep this list TIGHT: only messages that are provably benign and outside the
 * app's control belong here. Anything the app could actually cause must still
 * fail the assertion.
 */

const BENIGN_PATTERNS: readonly RegExp[] = [
  /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/,
];

/** True when a page-error / console-error message is a known-benign browser notification. */
export function isBenignBrowserError(message: string): boolean {
  return BENIGN_PATTERNS.some((re) => re.test(message));
}
