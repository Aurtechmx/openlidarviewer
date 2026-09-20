/**
 * lensPlacement.ts
 *
 * Where the evidence lens sits when there is no hovering cursor to put it
 * under.
 *
 * The lens is how a viewer checks whether a surface was measured or
 * reconstructed. A lens that only exists under a hovering mouse makes that
 * check available to people with a mouse, and the check is the honesty
 * mechanism of the whole subsystem rather than a convenience on top of it.
 *
 * `Lens` already carries a position in device pixels and says nothing about
 * pointers, so the gap is not in its shape. It is that a hovering pointer
 * supplies a position continuously and nothing else does. A touch ends when the
 * finger lifts; a keyboard has no position at all.
 *
 * Hence the rule this file exists for: a source that reports continuously is
 * tracked, and a source that does not is PINNED. The lens stays where it was
 * put until it is moved or dismissed. A lens that vanished when a finger lifted
 * would be hover-only behaviour under a different name, and a touch viewer
 * would be holding the lens over the patch they are suspicious of while unable
 * to look at anything else.
 *
 * A keyboard viewer starts at the centre of the viewport, which is a defined
 * place rather than the origin a zeroed struct would give: the top-left corner
 * is off the scan in most views, so a lens opened there reveals nothing and
 * reads as a feature that does not work. Nudges are clamped to the viewport for
 * the same reason — a lens driven past the edge is still open, still costing a
 * pass, and showing the viewer nothing.
 *
 * Pure: no DOM, no pointer or key events, no three.js. The caller owns the
 * input and translates it into these intents. Presentation only; the lens
 * changes what is drawn and never what is measured.
 */
import type { Lens } from './evidenceLens';
import { LENS_CLOSED } from './evidenceLens';

/** Where a lens position is coming from. */
export type LensSource =
  /** A hovering mouse or stylus. Reports a position every frame it moves. */
  | 'pointer'
  /** A finger. Reports while it is down and nothing after it lifts. */
  | 'touch'
  /** Keys. Never reports a position; moves the lens by increments. */
  | 'keyboard';

/**
 * Whether this source keeps supplying a position once the lens is open.
 *
 * The one property that decides tracked or pinned, so it is named rather than
 * left as a condition inside the reducer where each new source would have to
 * rediscover it.
 */
export function tracksContinuously(source: LensSource): boolean {
  return source === 'pointer';
}

/** The viewport the lens lives in, in device pixels. */
export interface Viewport {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** How large a lens opens, in device pixels. */
export interface LensSizing {
  readonly radiusPx: number;
  readonly featherPx: number;
}

/** How far one key press moves the lens, in device pixels. */
export const KEYBOARD_STEP_PX = 48;

/** What the caller's input means for the lens. */
export type LensIntent =
  /** Open at a known position, or move an open lens there. */
  | { readonly kind: 'at'; readonly source: LensSource; readonly xPx: number; readonly yPx: number }
  /** Open at the viewport centre, or leave an open lens where it is. */
  | { readonly kind: 'open'; readonly source: LensSource }
  /** Move an open lens by whole steps. Does not open a closed one. */
  | { readonly kind: 'nudge'; readonly dxSteps: number; readonly dySteps: number }
  /** The source stopped reporting — a finger lifted, a pointer left the canvas. */
  | { readonly kind: 'release'; readonly source: LensSource }
  /** Dismiss. The only thing that closes a pinned lens. */
  | { readonly kind: 'close' };

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Inside the viewport, and finite. A position that is neither is refused. */
function placeable(xPx: number, yPx: number, viewport: Viewport): { x: number; y: number } | null {
  if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) return null;
  if (!(viewport.widthPx > 0) || !(viewport.heightPx > 0)) return null;
  return {
    x: clamp(xPx, 0, viewport.widthPx),
    y: clamp(yPx, 0, viewport.heightPx),
  };
}

/** The middle of the viewport — where a lens with no position of its own opens. */
export function viewportCentre(viewport: Viewport): { x: number; y: number } {
  return { x: viewport.widthPx / 2, y: viewport.heightPx / 2 };
}

/**
 * The lens after one intent.
 *
 * A reducer rather than a setter so the pinning rule lives in one place: the
 * decision that a release keeps a touch lens open and closes a pointer one is
 * the whole point of the file, and a caller free to write `enabled = false` on
 * touchend would lose it without any test noticing.
 */
export function applyLensIntent(
  lens: Lens,
  intent: LensIntent,
  viewport: Viewport,
  sizing: LensSizing,
): Lens {
  switch (intent.kind) {
    case 'close':
      return LENS_CLOSED;

    case 'release':
      // A pointer that leaves has taken its position with it, so the lens has
      // nowhere to be. A finger that lifts has not: the lens stays where the
      // viewer put it, which is the difference this whole file turns on.
      return tracksContinuously(intent.source) ? LENS_CLOSED : lens;

    case 'at': {
      const p = placeable(intent.xPx, intent.yPx, viewport);
      if (!p) return lens;
      return { centreXPx: p.x, centreYPx: p.y, ...sizing, enabled: true };
    }

    case 'open': {
      if (lens.enabled) return lens;
      const c = viewportCentre(viewport);
      const p = placeable(c.x, c.y, viewport);
      if (!p) return lens;
      return { centreXPx: p.x, centreYPx: p.y, ...sizing, enabled: true };
    }

    case 'nudge': {
      // A nudge is a movement of something that is already there. Opening on an
      // arrow key would put a lens on screen for a viewer who was scrolling.
      if (!lens.enabled) return lens;
      const dx = Number.isFinite(intent.dxSteps) ? intent.dxSteps : 0;
      const dy = Number.isFinite(intent.dySteps) ? intent.dySteps : 0;
      const p = placeable(
        lens.centreXPx + dx * KEYBOARD_STEP_PX,
        lens.centreYPx + dy * KEYBOARD_STEP_PX,
        viewport,
      );
      if (!p) return lens;
      return { ...lens, centreXPx: p.x, centreYPx: p.y };
    }
  }
}
