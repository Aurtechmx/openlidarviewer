/**
 * streamingScanId.ts — the stable shell id a streaming scan was missing.
 *
 * A static scan earns an identity the moment it enters the viewer's cloud
 * registry: `addCloud` stamps it `cloud_<n>` from a per-load counter. A
 * streaming scan never enters that registry — the scheduler streams it in
 * place — so until now it had no id at all, and `scans.activeId` reported null
 * for it. That null is what the export scan-identity guard compares, and
 * `sameExportTarget(null, null)` is deliberately true (null matches only null),
 * so swapping one streaming scan for another mid-export was invisible to the
 * guard. Two different scans looked like the same target.
 *
 * This mints the missing identity: one non-null id per streaming session,
 * assigned when the cloud is constructed and fixed for the cloud's lifetime.
 *
 * WHY MINTED, NOT DERIVED FROM THE SOURCE URL. A streaming scan is not always
 * remote — a local COPC file opens through the same pipeline over a
 * `LocalFileRangeSource` (main.ts), and a local file carries no stable URL /
 * dataset key. Deriving the id from a URL would leave exactly those local scans
 * back at a degenerate identity, and the guard must FAIL CLOSED: every streaming
 * scan needs a concrete id so two of them never collide on a wildcard. A
 * per-session mint is always present and always distinct, which is the property
 * the swap check depends on. It also matches how a static scan behaves — a
 * reopen yields a fresh `cloud_<n>`, so a reopened streaming scan yielding a
 * fresh id keeps the two paths consistent rather than special-casing streaming.
 *
 * The namespace is prefixed so a streaming id can never equal a static
 * `cloud_<n>` id; `sameExportTarget` compares by ===, so distinct namespaces
 * make cross-type confusion impossible even if both were ever read together.
 *
 * Pure — a module-local counter and a string. No DOM, no three.js, no I/O.
 */

let counter = 0;

/**
 * Mint the next streaming-scan shell id. Monotonic within the session and
 * prefixed out of the static `cloud_<n>` namespace, so every streaming cloud
 * gets a distinct, non-null identity the export/terrain scan-identity guards can
 * compare.
 */
export function nextStreamingScanId(): string {
  return `streaming-scan_${++counter}`;
}
