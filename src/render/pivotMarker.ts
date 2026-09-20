/**
 * pivotMarker.ts — the brief mark that says where the camera is turning.
 *
 * Orbiting around a point nobody can see is the kind of thing that feels
 * imprecise without being wrong. The camera is doing exactly what it was told;
 * the viewer simply has no way to tell where the centre is until something
 * moves. A mark at the pivot for half a second answers that and then gets out
 * of the way.
 *
 * ── IT IS NOT PART OF THE SCAN ──────────────────────────────────────────────
 * Four rules keep it that way, and three of them are structural rather than
 * promised.
 *
 * It is never pickable, because picking never reaches it. `Viewer` resolves a
 * click by walking its own cloud registry and testing the ray against each
 * cloud's points; nothing in that path traverses the scene graph, so an object
 * added to the scene cannot be hit however it is drawn.
 *
 * It is never captured. A figure export is a statement about what was
 * observed, and a marker in one would be a shape at a coordinate that no
 * instrument recorded. {@link visibleDuringCapture} is the rule, and it takes
 * nothing, because no argument could make the answer yes.
 *
 * It is never data. Nothing here produces a position, a measurement or a
 * record: the caller already has the pivot and this decides only how strongly
 * to draw it. A module that returned a point would be a second source for a
 * coordinate that the navigation controller owns.
 *
 * ── REDUCED MOTION ──────────────────────────────────────────────────────────
 * The convention is `ResultFocus`'s: reduced motion drops both ends of the
 * animation rather than shortening them. The mark appears at full strength,
 * holds, and is gone. No growth and no fade, because a fade is still something
 * changing on screen for a viewer who asked for less of that.
 *
 * Pure: no three.js, no DOM, no clock. The caller passes the time it has.
 */

/** How long the mark lives, from the moment it is shown. */
export const PIVOT_MARKER_MS = 650;

/** The tail of that life spent fading out. */
export const PIVOT_FADE_MS = 250;

/** How long the mark takes to reach full size. */
export const PIVOT_GROW_MS = 120;

/** The size it starts at, as a fraction of full. */
export const PIVOT_START_SCALE = 0.6;

/** Why the mark is being shown. Recorded for a trace; it changes nothing. */
export type PivotReason =
  /** A framing command moved the camera. */
  | 'focus'
  /** A double click set a new pivot. */
  | 'double-click'
  /** The orbit centre moved under a drag. */
  | 'orbit-centre'
  /** A result was focused from a panel. */
  | 'result-focus';

/** How strongly to draw the mark this frame. */
export interface PivotMarkerState {
  /** Whether to draw it at all. */
  readonly visible: boolean;
  /** Opacity in `[0, 1]`. */
  readonly opacity: number;
  /** Scale in `(0, 1]`, relative to the mark's full size. */
  readonly scale: number;
}

/** Nothing drawn. */
const HIDDEN: PivotMarkerState = Object.freeze({ visible: false, opacity: 0, scale: 1 });

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The mark's state at `nowMs`, given when it was last shown.
 *
 * A null or non-finite `shownAtMs` means it has never been shown, which is not
 * the same as a mark whose life has run out and is handled the same way: there
 * is nothing to draw either way.
 *
 * Showing it again moves `shownAtMs`, which restarts the life. A viewer
 * double-clicking twice sees one mark that stays, rather than two that
 * interleave.
 */
export function pivotMarkerState(
  shownAtMs: number | null,
  nowMs: number,
  reducedMotion = false,
): PivotMarkerState {
  if (shownAtMs === null || !Number.isFinite(shownAtMs) || !Number.isFinite(nowMs)) return HIDDEN;
  const age = nowMs - shownAtMs;
  if (age < 0 || age >= PIVOT_MARKER_MS) return HIDDEN;
  // Reduced motion: present or absent, with nothing moving in between.
  if (reducedMotion) return { visible: true, opacity: 1, scale: 1 };

  const grow = PIVOT_GROW_MS > 0 ? clamp01(age / PIVOT_GROW_MS) : 1;
  const scale = PIVOT_START_SCALE + (1 - PIVOT_START_SCALE) * grow;
  const fadeStart = PIVOT_MARKER_MS - PIVOT_FADE_MS;
  const opacity = age <= fadeStart
    ? 1
    : clamp01((PIVOT_MARKER_MS - age) / PIVOT_FADE_MS);
  return { visible: true, opacity, scale };
}

/**
 * Whether the mark may appear in a captured frame.
 *
 * No. It takes no argument because no argument could change the answer: a
 * figure is a statement about what was observed, and this is a statement about
 * where the camera is turning.
 */
export function visibleDuringCapture(): false {
  return false;
}
