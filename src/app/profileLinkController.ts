/**
 * profileLinkController.ts
 *
 * Hover and click on the section plot, turned into one selected return and the
 * marks that describe it.
 *
 * FOUR PROPERTIES THIS MODULE EXISTS TO HOLD.
 *
 *   1. IDENTITY, NOT POSITION. A pointer position becomes a section index
 *      through the screen-cell index, and the index becomes a
 *      `ProfileReturnIdentity` — slot, source kind, source id, source point
 *      index — before anything is resolved. Nothing downstream ever searches
 *      the scene for the nearest coordinate.
 *
 *   2. HOVER NEVER MOVES THE CAMERA. There is no path from `pointerMove` to
 *      `focus`. The camera moves only through {@link ProfileLinkController.focusSelection},
 *      which refuses unless a click has locked a selection AND that selection
 *      still resolves. Reading along a section drags the pointer across
 *      hundreds of returns; a camera that followed would make the plot
 *      unusable.
 *
 *   3. ONE FLUSH PER FRAME. A raw pointer move records a position and asks the
 *      scheduler for a frame. It does not hit-test, does not compose a
 *      readout, and does not touch a card. A burst of moves inside one frame
 *      produces exactly one hit-test and at most one presentation, and a flush
 *      whose result is identical to the last one presents nothing at all.
 *
 *   4. A LOST SOURCE IS SAID, NOT HIDDEN. Every flush re-resolves the locked
 *      selection against the live scene, so a streaming node evicted after the
 *      snapshot was taken turns the link to `evicted` while the 2D figures and
 *      the card stay exactly where they were. The selection is not dropped and
 *      the marker is not left behind claiming the point is still there.
 *
 * Nothing here is view-bound. Hit-testing, projection, resolution, drawing,
 * marking and presentation all arrive as functions, so the whole state machine
 * runs under Node with no canvas, no three.js and no DOM.
 */

import {
  locateProfileReturn,
  type ProfileLinkState,
  type ProfileReturnIdentity,
  type ProfileReturnLink,
  type ProfileReturnLocator,
} from '../render/measure/profilePointLink';

import type { ProfilePointDetail } from '../render/measure/profilePointDetail';
import type { ProfileLinkPoint } from '../render/measure/profileLinkOverlay2d';

/** One resolved return, with where it sits on the plot. */
export interface ProfileLinkView {
  readonly identity: ProfileReturnIdentity;
  readonly state: ProfileLinkState;
  readonly position: readonly [number, number, number] | null;
  /** Where the return is drawn, or null when it is not currently drawn. */
  readonly screen: ProfileLinkPoint | null;
  /** The concise one-line readout for this return. */
  readonly readout: string;
}

/** What the 3D scene is asked to mark. */
export interface ProfileLinkMarker {
  readonly position: readonly [number, number, number];
  /** A locked selection reads heavier than a passing hover. */
  readonly mode: 'hover' | 'locked';
}

/** Everything the panel is told after a flush. */
export interface ProfileLinkUiState {
  readonly hover: ProfileLinkView | null;
  readonly locked: ProfileLinkView | null;
  /** Built only for a locked selection; a hover never pays for a card. */
  readonly detail: ProfilePointDetail | null;
}

export interface ProfileLinkControllerDeps {
  /** Nearest DRAWN return to a plot position, or null. */
  query: (xPx: number, yPx: number) => number | null;
  /** Where return `i` is drawn, in plot CSS pixels. False when it is not. */
  project: (i: number, out: Float64Array) => boolean;
  /** The stable identity of return `i`, or null. */
  identify: (i: number) => ProfileReturnIdentity | null;
  /** The live scene. */
  locate: ProfileReturnLocator;
  /** The concise readout for return `i`. */
  readout: (i: number) => string;
  /** The card for a locked return. Called only on a lock, never on a hover. */
  detail: (i: number) => ProfilePointDetail | null;
  /** Ask for one frame. The callback must run at most once per request. */
  schedule: (run: () => void) => void;
  /** Draw the 2D marks. */
  paint: (hover: ProfileLinkPoint | null, locked: ProfileLinkPoint | null) => void;
  /** Place or clear the 3D marker. */
  mark: (marker: ProfileLinkMarker | null) => void;
  /** Readout line and card. */
  present: (state: ProfileLinkUiState) => void;
  /**
   * Move the camera. OPTIONAL, and reached only from `focusSelection`.
   * A host that supplies none simply has no focus action.
   */
  focus?: (position: readonly [number, number, number]) => void;
}

/** Counters, so the coalescing can be asserted rather than assumed. */
export interface ProfileLinkStats {
  /** Raw pointer events handed in. */
  readonly pointerEvents: number;
  /** Flushes actually run. */
  readonly flushes: number;
  /** Hit-tests performed. */
  readonly hitTests: number;
  /** Readouts composed. */
  readonly readouts: number;
  /** Presentations pushed to the panel. */
  readonly presents: number;
  /** Camera focus calls. */
  readonly focuses: number;
}

export interface ProfileLinkController {
  /** A raw pointer move. Records and schedules; does no work of its own. */
  pointerMove(xPx: number, yPx: number): void;
  /** The pointer left the plot. Clears the hover on the next flush. */
  pointerLeave(): void;
  /** A click. Locks the return under it, or clears the lock when it misses. */
  click(xPx: number, yPx: number): void;
  /** Drop the locked selection. */
  clearSelection(): void;
  /** The locked selection, or null. */
  selection(): ProfileLinkView | null;
  /**
   * Move the camera to the locked selection.
   *
   * False when nothing is locked, when the locked return has no live source,
   * or when the host supplied no camera. Never reachable from a hover.
   */
  focusSelection(): boolean;
  /** Re-resolve against the live scene and repaint. Safe to call at any time. */
  refresh(): void;
  stats(): ProfileLinkStats;
  /** Clear every mark and stop responding. Idempotent. */
  dispose(): void;
}

/** What a flush was asked to do with the hover. */
type Pending = { readonly kind: 'move'; readonly x: number; readonly y: number } | { readonly kind: 'leave' } | null;

/** Two views name the same thing when index and state agree. */
function sameView(a: ProfileLinkView | null, b: ProfileLinkView | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.identity.sectionIndex === b.identity.sectionIndex &&
    a.state === b.state &&
    a.screen?.x === b.screen?.x &&
    a.screen?.y === b.screen?.y
  );
}

export function createProfileLinkController(
  deps: ProfileLinkControllerDeps,
): ProfileLinkController {
  const scratch = new Float64Array(3);
  const screenOut = new Float64Array(2);

  let disposed = false;
  let pending: Pending = null;
  let scheduled = false;
  let hover: ProfileLinkView | null = null;
  let locked: ProfileLinkView | null = null;
  let detail: ProfilePointDetail | null = null;
  let lastHover: ProfileLinkView | null = null;
  let lastLocked: ProfileLinkView | null = null;
  let presented = false;

  let pointerEvents = 0;
  let flushes = 0;
  let hitTests = 0;
  let readouts = 0;
  let presents = 0;
  let focuses = 0;

  /** Resolve the return at a plot position, or null when none is near. */
  function viewAt(xPx: number, yPx: number): ProfileLinkView | null {
    hitTests++;
    const i = deps.query(xPx, yPx);
    if (i === null) return null;
    const identity = deps.identify(i);
    if (!identity) return null;
    return viewOf(identity, locateProfileReturn(identity, deps.locate, scratch));
  }

  /**
   * Re-resolve a known identity, keeping its screen position current.
   *
   * `reuse` carries the readout of a view for the SAME return, so re-reading a
   * lock every frame costs a resolution and a projection rather than a fresh
   * line of text. The readout describes the section, which does not change
   * under a lock; only the link state does.
   */
  function viewOf(
    identity: ProfileReturnIdentity,
    link: ProfileReturnLink,
    reuse?: ProfileLinkView,
  ): ProfileLinkView {
    const drawn = deps.project(identity.sectionIndex, screenOut);
    let readout: string;
    if (reuse && reuse.identity.sectionIndex === identity.sectionIndex) {
      readout = reuse.readout;
    } else {
      readouts++;
      readout = deps.readout(identity.sectionIndex);
    }
    return {
      identity,
      state: link.state,
      position: link.position,
      screen: drawn ? { x: screenOut[0]!, y: screenOut[1]! } : null,
      readout,
    };
  }

  /** The mark the 3D scene should carry: the lock when there is one. */
  function markerOf(): ProfileLinkMarker | null {
    const chosen = locked ?? hover;
    if (!chosen || chosen.state !== 'linked' || !chosen.position) return null;
    return { position: chosen.position, mode: locked ? 'locked' : 'hover' };
  }

  /**
   * Push the current state outward, and only when it changed.
   *
   * The comparison is on identity and link state, not on object identity, so a
   * pointer wandering inside one return's hit radius repaints nothing.
   */
  function emit(): void {
    if (presented && sameView(hover, lastHover) && sameView(locked, lastLocked)) return;
    lastHover = hover;
    lastLocked = locked;
    presented = true;
    presents++;
    deps.paint(hover?.screen ?? null, locked?.screen ?? null);
    deps.mark(markerOf());
    deps.present({ hover, locked, detail });
  }

  /** Re-resolve the locked selection. The 2D figures are never touched. */
  function refreshLocked(): void {
    if (!locked) return;
    locked = viewOf(
      locked.identity,
      locateProfileReturn(locked.identity, deps.locate, scratch),
      locked,
    );
  }

  function flush(): void {
    scheduled = false;
    if (disposed) return;
    flushes++;
    const want = pending;
    pending = null;
    if (want?.kind === 'move') hover = viewAt(want.x, want.y);
    else if (want?.kind === 'leave') hover = null;
    // A locked node can be evicted while the pointer is elsewhere, so the lock
    // is re-read on every flush rather than only when it is set.
    refreshLocked();
    emit();
  }

  function request(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    deps.schedule(flush);
  }

  return {
    pointerMove(xPx: number, yPx: number): void {
      if (disposed) return;
      pointerEvents++;
      // The ONLY work a raw move does: record and ask for a frame.
      pending = { kind: 'move', x: xPx, y: yPx };
      request();
    },

    pointerLeave(): void {
      if (disposed) return;
      pointerEvents++;
      pending = { kind: 'leave' };
      request();
    },

    click(xPx: number, yPx: number): void {
      if (disposed) return;
      pointerEvents++;
      // A click is acted on immediately: the card it opens is the response to
      // the press, not to the next frame.
      const picked = viewAt(xPx, yPx);
      locked = picked;
      detail = picked ? deps.detail(picked.identity.sectionIndex) : null;
      hover = picked ?? hover;
      pending = null;
      emit();
    },

    clearSelection(): void {
      if (disposed) return;
      locked = null;
      detail = null;
      emit();
    },

    selection(): ProfileLinkView | null {
      return locked;
    },

    focusSelection(): boolean {
      // Locked only. A hover cannot reach here, and neither can a selection
      // whose source has gone: there is no position to focus on.
      if (disposed || !locked || locked.state !== 'linked' || !locked.position) return false;
      if (!deps.focus) return false;
      focuses++;
      deps.focus(locked.position);
      return true;
    },

    refresh(): void {
      if (disposed) return;
      if (hover) {
        hover = viewOf(
          hover.identity,
          locateProfileReturn(hover.identity, deps.locate, scratch),
          hover,
        );
      }
      refreshLocked();
      // Forced: a refresh follows a redraw, which cleared the overlay surface,
      // so the marks have to be laid down again even when nothing changed.
      presented = false;
      emit();
    },

    stats(): ProfileLinkStats {
      return { pointerEvents, flushes, hitTests, readouts, presents, focuses };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = null;
      hover = null;
      locked = null;
      detail = null;
      deps.paint(null, null);
      deps.mark(null);
    },
  };
}
