/**
 * profileLinkOverlay2d.ts
 *
 * The crosshair and the highlight box the section plot draws over the return
 * under the pointer, and over the one a click locked.
 *
 * A SEPARATE SURFACE FROM THE PLOT, and that is the whole reason this module
 * exists rather than a branch inside `ProfileSectionRenderer`. A section can
 * hold a hundred thousand splats; redrawing them to move a crosshair two
 * pixels would put the entire point set through `fillRect` on every hover
 * frame. Here the surface is cleared and three or four strokes are laid down,
 * so hover cost is independent of how many returns the section holds.
 *
 * The locked mark is drawn AFTER the hover mark and reads heavier, so a hover
 * passing over a locked return never leaves the reader unsure which of the two
 * the card below is describing.
 *
 * No DOM. The context is a structural interface satisfied by a real
 * `CanvasRenderingContext2D` and by a recording double, the same arrangement
 * the section renderer uses.
 */

/** The 2D operations this overlay uses, and nothing more. */
export interface ProfileLinkOverlayContext {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
}

/** A screen position inside the plot, in CSS pixels from its top left. */
export interface ProfileLinkPoint {
  readonly x: number;
  readonly y: number;
}

/** What to draw over the plot this frame. */
export interface ProfileLinkOverlayFrame {
  /** Plot box, CSS pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Device pixels per CSS pixel. Non-finite or non-positive reads as 1. */
  readonly devicePixelRatio: number;
  /** The return under the pointer, or null. */
  readonly hover: ProfileLinkPoint | null;
  /** The return a click locked, or null. */
  readonly locked: ProfileLinkPoint | null;
}

/** Half-side of the box drawn around a marked return, CSS pixels. */
export const MARK_HALF_PX = 6;

/** Stroke weights and colours, CSS pixels. The plot owns the palette. */
const HOVER_STYLE = {
  colour: 'rgb(255, 214, 102)',
  alpha: 0.55,
  widthPx: 1,
} as const;

const LOCKED_STYLE = {
  colour: 'rgb(255, 255, 255)',
  alpha: 0.9,
  widthPx: 1.5,
} as const;

function positive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function drawable(p: ProfileLinkPoint | null): p is ProfileLinkPoint {
  return p !== null && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** A square centred on the point, as one closed path. */
function box(ctx: ProfileLinkOverlayContext, p: ProfileLinkPoint, half: number): void {
  ctx.beginPath();
  ctx.moveTo(p.x - half, p.y - half);
  ctx.lineTo(p.x + half, p.y - half);
  ctx.lineTo(p.x + half, p.y + half);
  ctx.lineTo(p.x - half, p.y + half);
  ctx.closePath();
  ctx.stroke();
}

/** Full-width and full-height rules through the point. */
function crosshair(
  ctx: ProfileLinkOverlayContext,
  p: ProfileLinkPoint,
  widthPx: number,
  heightPx: number,
): void {
  ctx.beginPath();
  ctx.moveTo(0, p.y);
  ctx.lineTo(widthPx, p.y);
  ctx.moveTo(p.x, 0);
  ctx.lineTo(p.x, heightPx);
  ctx.stroke();
}

/**
 * Clear the overlay and draw this frame's marks.
 *
 * ALWAYS clears, including when there is nothing to draw: a frame with no
 * hover is how a pointer leaving the plot removes the crosshair, and skipping
 * the clear would leave the last one painted over a plot nobody is pointing
 * at.
 */
export function drawProfileLinkOverlay(
  ctx: ProfileLinkOverlayContext,
  frame: ProfileLinkOverlayFrame,
): void {
  const dpr = positive(frame.devicePixelRatio, 1);
  const width = positive(frame.widthPx, 0);
  const height = positive(frame.heightPx, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, Math.max(width, 1), Math.max(height, 1));
  if (width <= 0 || height <= 0) return;

  if (drawable(frame.hover)) {
    ctx.globalAlpha = HOVER_STYLE.alpha;
    ctx.strokeStyle = HOVER_STYLE.colour;
    ctx.lineWidth = HOVER_STYLE.widthPx;
    crosshair(ctx, frame.hover, width, height);
    box(ctx, frame.hover, MARK_HALF_PX);
  }

  // Locked last, and heavier: the card below describes THIS return, so it has
  // to stay the stronger of the two marks while the pointer moves over others.
  if (drawable(frame.locked)) {
    ctx.globalAlpha = LOCKED_STYLE.alpha;
    ctx.strokeStyle = LOCKED_STYLE.colour;
    ctx.lineWidth = LOCKED_STYLE.widthPx;
    box(ctx, frame.locked, MARK_HALF_PX);
  }

  ctx.globalAlpha = 1;
}
