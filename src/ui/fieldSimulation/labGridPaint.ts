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
  for (const [stroke, width, glow] of [[LAB_FIELD, w + 2, 0], [color, w, Math.max(4, s / 2)]] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    // A soft glow on the light stroke marks the active path; the dark casing has none.
    ctx.shadowColor = glow ? color : 'transparent';
    ctx.shadowBlur = glow;
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
    // The grid context is flipped north-up; unflip so the letter reads upright.
    ctx.translate(cx, cy);
    ctx.scale(1, -1);
    ctx.fillText(letter, 0, 0.5);
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

/**
 * Size a grid canvas to fill its column with square cells, at the device
 * pixel ratio, and return its 2D context with the cell size in device pixels.
 * Grid row 0 is the southern row (rasterizeDtm counts rows up from the
 * minimum northing), so the context is flipped vertically: callers draw row r
 * at y = r * s and it lands north-up on screen, row rows - 1 at the top.
 * `styleScale` sets the CSS aspect ratio (cols x rows at that scale). Returns
 * null where there is no 2D context (the Node test DOM).
 */
export function fitGridCanvas(
  canvas: HTMLCanvasElement, cols: number, rows: number, styleScale: number,
): { ctx: CanvasRenderingContext2D; s: number } | null {
  const w = cols * styleScale, h = rows * styleScale;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${w} / ${h}`;
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) {
    canvas.width = w;
    canvas.height = h;
    return null;
  }
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? Math.min(3, devicePixelRatio) : 1;
  const cssW = canvas.clientWidth > 0 ? canvas.clientWidth : w;
  const s = Math.max(1, (cssW * dpr) / cols);
  canvas.width = Math.round(s * cols);
  canvas.height = Math.round(s * rows);
  ctx.setTransform(1, 0, 0, -1, 0, canvas.height);
  return { ctx, s };
}

/** Pixel span [x, width] of cell `i` along an axis at cell size `s`, with no seams between cells. */
export function cellSpan(i: number, s: number): [number, number] {
  const a = Math.round(i * s);
  return [a, Math.round((i + 1) * s) - a];
}

/** Cell borders, drawn only once a cell is at least 12 device pixels across. */
export function cellBorders(ctx: CanvasRenderingContext2D, cols: number, rows: number, s: number): void {
  if (s < 12) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(5, 11, 26, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < cols; c++) { const x = Math.round(c * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, rows * s); }
  for (let r = 1; r < rows; r++) { const y = Math.round(r * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(cols * s, y); }
  ctx.stroke();
  ctx.restore();
}

/**
 * Call `redraw` when the canvas's laid-out width changes (one call per frame
 * at most). Returns a disposer that disconnects the observer and cancels a
 * pending frame.
 */
export function onWidthChange(canvas: HTMLCanvasElement, redraw: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  let last = 0;
  let raf = 0;
  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    if (w === last || raf) return;
    last = w;
    raf = requestAnimationFrame(() => { raf = 0; redraw(); });
  });
  ro.observe(canvas);
  return () => {
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}

/**
 * Grid cell under a pointer, north-up: the top of the canvas is the northern
 * row (rows - 1). Null outside the canvas.
 */
export function northUpCell(
  cols: number, rows: number, w: number, h: number, px: number, py: number,
): { col: number; row: number } | null {
  if (cols <= 0 || rows <= 0 || w <= 0 || h <= 0 || px < 0 || py < 0 || px >= w || py >= h) return null;
  const col = Math.min(cols - 1, Math.floor((px / w) * cols));
  const fromTop = Math.min(rows - 1, Math.floor((py / h) * rows));
  return { col, row: rows - 1 - fromTop };
}

/** Row step for a vertical arrow key on a north-up grid: ArrowUp moves north (row + 1). */
export function northUpRowStep(key: string): number {
  return key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0;
}
