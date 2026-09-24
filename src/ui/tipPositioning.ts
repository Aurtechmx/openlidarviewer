/**
 * tipPositioning.ts — pure geometry for the floating `[data-tip]` glass
 * tooltip (src/ui/tipLayer.ts).
 *
 * WHY a single top-level layer: the old design rendered the visible tip as a
 * `[data-tip]::after`/`::before` pseudo-element on the control itself, with
 * `z-index: var(--z-popover)`. That z-index only wins a stacking fight
 * *inside the control's own stacking context* — it says nothing about how
 * that context compares to a sibling one. A header control sits in the
 * header's stacking context, which paints below `.olv-right-rail`
 * (z-index: 15) regardless of what z-index the header's own children carry,
 * so the tip was silently clipped/covered underneath the rail no matter how
 * high its own z-index went (confirmed live: hovering the theme toggle
 * showed only "Cycle the interf…", the rest hidden under the rail).
 *
 * The fix is structural, not a bigger z-index: render the tip in exactly one
 * layer, appended to `document.body` (`tipLayer.ts`), so it always shares the
 * *root* stacking context with every panel instead of a nested one. This
 * module is the pure math behind it — anchor-relative placement, flipped
 * above the control when there is no room below, and clamped so it can never
 * spill past the viewport (checked down to 320px) — kept free of the DOM so
 * it can be unit-tested without a browser.
 */

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type TipPlacement = 'above' | 'below';

export interface TipPosition {
  /** `position: fixed` top, in viewport pixels. */
  readonly top: number;
  /** `position: fixed` left, in viewport pixels. */
  readonly left: number;
  /** Which side of the anchor the tip ended up on. */
  readonly placement: TipPlacement;
  /** The connector's horizontal offset from the tip box's own left edge —
   *  clamped to stay over the tip body even when the box itself was pushed
   *  off-centre to avoid a viewport edge. */
  readonly connectorX: number;
}

/** Minimum gap kept between the tip box and the viewport edge. */
export const TIP_VIEWPORT_MARGIN = 8;
/** Gap between the anchor control and the tip box. */
export const TIP_ANCHOR_GAP = 8;
/** How close to a box edge the connector is allowed to sit. */
const CONNECTOR_EDGE_INSET = 10;

/**
 * Where to place the tip box for `anchorRect` (the hovered/focused control)
 * sized `tipSize`, inside a `viewport` of the given size. Prefers below the
 * anchor; flips above it when there is no room below; horizontally centers
 * on the anchor, then clamps so the box never crosses either viewport edge
 * (verified against 320px-wide viewports). The connector offset is
 * recomputed against wherever the box actually landed, so it keeps pointing
 * at the anchor even when the box itself had to shift.
 */
export function computeTipPosition(
  anchorRect: Rect,
  tipSize: Size,
  viewport: Size,
  margin: number = TIP_VIEWPORT_MARGIN,
  gap: number = TIP_ANCHOR_GAP,
): TipPosition {
  let placement: TipPlacement = 'below';
  let top = anchorRect.bottom + gap;
  const fitsBelow = top + tipSize.height + margin <= viewport.height;
  if (!fitsBelow) {
    const aboveTop = anchorRect.top - tipSize.height - gap;
    if (aboveTop >= margin) {
      placement = 'above';
      top = aboveTop;
    } else {
      // Neither side has room (a very short viewport) — clamp inside it
      // rather than let the box run off either edge.
      top = Math.max(margin, Math.min(top, viewport.height - tipSize.height - margin));
    }
  }

  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const idealLeft = anchorCenterX - tipSize.width / 2;
  const maxLeft = Math.max(margin, viewport.width - tipSize.width - margin);
  const left = Math.min(Math.max(idealLeft, margin), maxLeft);

  const rawConnectorX = anchorCenterX - left;
  const connectorX = Math.min(
    Math.max(rawConnectorX, CONNECTOR_EDGE_INSET),
    Math.max(tipSize.width - CONNECTOR_EDGE_INSET, CONNECTOR_EDGE_INSET),
  );

  return { top, left, placement, connectorX };
}
