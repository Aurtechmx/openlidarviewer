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

import type { HeldSessionWork } from '../io/sessionFrame';

let pending: File | null = null;

/**
 * Restored work whose scan is not open (or is open more than once). It is not
 * placed in the scene, so no output can use it, and the next session save
 * writes it back with the records it is read through, so it is never lost.
 */
let held: HeldSessionWork | null = null;

/** Record (or with null, forget) the work an import could not place. */
export function holdSessionWork(work: HeldSessionWork | null): void {
  held = work && work.measurements.length + work.annotations.length > 0 ? work : null;
}

/** The work an import could not place, or null. */
export function heldSessionWork(): HeldSessionWork | null {
  return held;
}

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

/** Forget the waiting session and any held work: the scene was reset or closed. */
export function clearPendingSessionRestore(): void {
  pending = null;
  held = null;
}

/**
 * A streamed scan opened while a session waited. The streamed path does not
 * run the session match, so the session is dropped, the work it restored in
 * its own frame is cleared (as on a refused match), and the user is told.
 */
export function dropPendingSessionForStream(showToast: (message: string) => void, clearRestoredWork: () => void): void {
  if (!takePendingSessionRestore()) return;
  clearRestoredWork();
  showToast('The imported session was not applied to this streamed scan, so its work was cleared. Import it again to check it against this scan.');
}
