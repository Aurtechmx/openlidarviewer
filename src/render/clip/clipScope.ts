/**
 * clipScope.ts: how much of the active scan the clip box keeps, for the
 * surfaces outside the Clip page (the state strip and the Export panel).
 *
 * The Clip panel writes the count it already computes for its own readout;
 * readers never recount. Null means no clip is on.
 */

export interface ClipScope {
  readonly kept: number;
  readonly total: number;
}

let current: ClipScope | null = null;
const listeners = new Set<() => void>();

export function clipScope(): ClipScope | null {
  return current;
}

export function setClipScope(next: ClipScope | null): void {
  // No clip before and after is no change; readers must not run for it (the
  // Clip panel clears the scope at boot, before any scan or viewer exists).
  if (next === null && current === null) return;
  current = next;
  for (const fn of listeners) fn();
}

export function subscribeClipScope(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "Clipped: 16,739 of 31,839 points". */
export function clipScopeText(s: ClipScope): string {
  return `Clipped: ${s.kept.toLocaleString()} of ${s.total.toLocaleString()} points`;
}
