/**
 * pendingSessionRestore.ts: a session imported with no scan open.
 *
 * Its work is restored verbatim, in the frame of the scan it was saved over,
 * and waits for that scan. The import records the file here; the next fresh
 * scan open takes it and applies the session again through the scan match and
 * the rebase, instead of clearing the restored annotations and views. Kept out
 * of `sessionIo.ts` so the eager scan-open path does not load the session
 * importer.
 */

let pending: File | null = null;

/** Record (or with null, forget) the session waiting for its scan. */
export function markPendingSessionRestore(file: File | null): void {
  pending = file;
}

/** The session waiting for its scan, removed so it is applied once. */
export function takePendingSessionRestore(): File | null {
  const file = pending;
  pending = null;
  return file;
}

/** Forget the waiting session: the scene was reset or closed. */
export function clearPendingSessionRestore(): void {
  pending = null;
}

/**
 * A streamed scan opened while a session waited. The streamed path does not
 * run the session match, so the session is dropped and the user is told.
 */
export function dropPendingSessionForStream(showToast: (message: string) => void): void {
  if (!takePendingSessionRestore()) return;
  showToast('The imported session was not applied to this streamed scan. Import it again to check it against this scan.');
}
