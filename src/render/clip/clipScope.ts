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
  /** Which side of the box is kept; the state strip says it beside the count. */
  readonly mode?: 'keep-inside' | 'keep-outside';
}

let turnOff: (() => void) | null = null;

/** The Clip panel registers its own clear here, so the state strip can offer Turn off. */
export function setClipTurnOff(fn: (() => void) | null): void {
  turnOff = fn;
}

export function clipTurnOff(): (() => void) | null {
  return turnOff;
}

let readoutShown: (() => boolean) | null = null;

/**
 * The Clip panel registers whether its own polite readout is on screen. While
 * it is, that readout already speaks each clip change, so the state strip
 * stays quiet rather than say it twice.
 */
export function setClipReadoutShown(fn: (() => boolean) | null): void {
  readoutShown = fn;
}

export function clipReadoutShown(): boolean {
  try {
    return readoutShown?.() ?? false;
  } catch {
    return false;
  }
}

/** "Showing inside box" / "Showing outside box"; empty when the mode is unknown. */
export function clipModePhrase(s: ClipScope): string {
  return s.mode === undefined ? '' : `Showing ${s.mode === 'keep-inside' ? 'inside' : 'outside'} box`;
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

let clipOnMode: 'keep-inside' | 'keep-outside' | null = null;

/** Which side a clip that is ON keeps, or null when no clip is on. Set whether or not a count exists. */
export function clipOn(): 'keep-inside' | 'keep-outside' | null {
  return clipOnMode;
}

export function setClipOn(mode: 'keep-inside' | 'keep-outside' | null): void {
  if (mode === clipOnMode) return;
  clipOnMode = mode;
  for (const fn of listeners) fn();
}

export function subscribeClipScope(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "Clipped: 16,739 of 31,839 points". */
export function clipScopeText(s: ClipScope): string {
  return `Clipped: ${s.kept.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} points`;
}

/**
 * The scope as the state strip and the Export panel state it: "Clipped: k of
 * n points", or, when the box keeps every point, that the clip is on and
 * clips nothing (never "Clipped: n of n").
 */
export function clipStatusText(s: ClipScope): string {
  return s.kept === s.total && s.total > 0
    ? `Clip on: keeps all ${s.total.toLocaleString('en-US')} points`
    : clipScopeText(s);
}
