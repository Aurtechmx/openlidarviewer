/**
 * labGridPaint.ts — canvas marks shared by the Field Simulation Lab grids:
 * pattern fills for states that are not on a colour ramp, a cased polyline
 * for a route or flow path, and lettered endpoint rings. Patterns and letters
 * carry meaning, so no state depends on hue alone.
 */

/** Field colour under every grid; the grids stay dark in every theme so a colour map reads the same. */
export const LAB_FIELD = '#050b1a';
export const LAB_LINE = '#ffffff';
/** Violet hatch for blocked cells (the app's blocked-rating hue). */
export const LAB_BLOCKED = '#c084fc';
/** Neutral dots for cells withheld for lack of evidence. */
export const LAB_WITHHELD = '#8a94ad';

/** Fill one cell with the field colour and 45-degree hatch lines. */
export function hatchCell(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = LAB_FIELD;
  ctx.fillRect(x, y, s, s);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s / 10);
  const step = Math.max(3, s / 3);
  ctx.beginPath();
  for (let d = -s; d < s; d += step) {
    ctx.moveTo(x + d, y + s);
    ctx.lineTo(x + d + s, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Fill one cell with the field colour and a sparse dot pattern. */
export function dotCell(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = LAB_FIELD;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = color;
  const r = Math.max(0.75, s / 14);
  const n = s >= 12 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      ctx.beginPath();
      ctx.arc(x + (s * (i + 0.5)) / n, y + (s * (j + 0.5)) / n, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Cell centres, in canvas pixels, for an ordered list of row-major indices. */
export function cellCentres(order: ArrayLike<number>, cols: number, s: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    out.push([(i % cols) * s + s / 2, Math.floor(i / cols) * s + s / 2]);
  }
  return out;
}

/**
 * Stroke a cased line through `pts`, drawn up to `fraction` (0..1) of its
 * vertices. The dark casing keeps the line legible over any colour-map value.
 */
export function casedPath(
  ctx: CanvasRenderingContext2D, pts: ReadonlyArray<[number, number]>, s: number, color: string, fraction = 1,
): void {
  if (pts.length === 0) return;
  const last = Math.max(1, Math.ceil(pts.length * Math.min(1, Math.max(0, fraction))));
  const shown = pts.slice(0, last);
  const w = Math.max(2, s / 4);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [stroke, width] of [[LAB_FIELD, w + 2], [color, w]] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(shown[0]![0], shown[0]![1]);
    if (shown.length === 1) ctx.lineTo(shown[0]![0] + 0.01, shown[0]![1]);
    for (const p of shown.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }
  ctx.restore();
}

/** A ring with a letter (S, G) centred on one cell. */
export function letteredRing(
  ctx: CanvasRenderingContext2D, col: number, row: number, s: number, color: string, letter: string,
): void {
  const cx = col * s + s / 2, cy = row * s + s / 2;
  const r = Math.max(5, s * 0.42);
  ctx.save();
  ctx.fillStyle = LAB_FIELD;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, s / 10);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (r >= 6) {
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(r * 1.1)}px "Olv Font", "Olv Font Fallback", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, cx, cy + 0.5);
  }
  ctx.restore();
}

/**
 * Run `frame(fraction)` from 0 to 1 over `ms`, or once at 1 when motion is
 * reduced or there is no animation clock. Returns a cancel function.
 */
export function drawIn(ms: number, reduced: boolean, frame: (fraction: number) => void): () => void {
  if (reduced || typeof requestAnimationFrame !== 'function') {
    frame(1);
    return () => {};
  }
  let raf = 0;
  const t0 = performance.now();
  const tick = (now: number): void => {
    const k = Math.min(1, (now - t0) / ms);
    frame(1 - (1 - k) ** 3);
    if (k < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
