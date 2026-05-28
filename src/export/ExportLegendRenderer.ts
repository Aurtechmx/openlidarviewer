/**
 * ExportLegendRenderer.ts
 *
 * Renders legend swatches into a 2D canvas — used by the Studio panel to
 * preview the palette. The legend is a side artifact surfaced in the panel;
 * the exported PNG itself remains untouched so binary round-trips stay
 * stable.
 *
 * Pure of three.js. Accepts an offscreen `OffscreenCanvas` (or any
 * `HTMLCanvasElement` for jsdom-friendly tests) and writes swatches +
 * labels using the standard 2D context API.
 */

/** A single swatch entry — colour + label. */
export interface LegendSwatch {
  /** CSS-compatible colour string. */
  color: string;
  /** Display label — keep short (≤ 30 chars). */
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASPRS classification — display labels, mirrored from CLASS_PALETTE in
// `render/colorModes.ts`. Kept here so the Studio's legend renderer is
// self-contained and the data doesn't drift if the runtime palette swaps
// values for visual tuning (the *labels* are spec-bound, not visual).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standard ASPRS classification label for a class code.
 * Codes ≥ 19 are user-defined per spec and labelled accordingly.
 */
export function asprsLabel(code: number): string {
  switch (code) {
    case 0:  return 'Never classified';
    case 1:  return 'Unclassified';
    case 2:  return 'Ground';
    case 3:  return 'Low vegetation';
    case 4:  return 'Medium vegetation';
    case 5:  return 'High vegetation';
    case 6:  return 'Building';
    case 7:  return 'Low point / noise';
    case 8:  return 'Reserved (8)';
    case 9:  return 'Water';
    case 10: return 'Rail';
    case 11: return 'Road surface';
    case 12: return 'Reserved (12)';
    case 13: return 'Wire — guard / shield';
    case 14: return 'Wire — conductor';
    case 15: return 'Transmission tower';
    case 16: return 'Wire connector';
    case 17: return 'Bridge deck';
    case 18: return 'High noise';
    default: return `User class ${code}`;
  }
}

/**
 * The recommended subset of ASPRS classes to include in a quick-read legend.
 * Order matches the runtime palette in `colorModes.ts`. Callers can build
 * their own list from the actual classification distribution when a
 * cloud-specific legend is preferred.
 */
export const DEFAULT_LEGEND_CODES: readonly number[] = [
  2, 3, 4, 5, 6, 9, 11, 17, 1, 7, 18,
];

/**
 * Render legend swatches into the given canvas. The canvas is sized to the
 * laid-out content; callers pre-size it via `measureLegend()`.
 *
 * Each entry takes one row: a coloured square + a label. Rows are spaced
 * uniformly; the label font + sizes are deliberately spartan because the
 * Studio panel renders this at small DPR-aware sizes.
 */
export function renderLegend(
  ctx: CanvasRenderingContext2D,
  swatches: readonly LegendSwatch[],
  options: { rowHeight?: number; swatchSize?: number; padding?: number; font?: string } = {},
): void {
  const rowH = options.rowHeight ?? 22;
  const sw = options.swatchSize ?? 14;
  const pad = options.padding ?? 10;
  const font = options.font ?? '12px system-ui, -apple-system, sans-serif';

  // Background — translucent neutral so the legend reads on light + dark exports.
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillRect(0, 0, w, h);

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111';

  let y = pad + rowH / 2;
  for (const s of swatches) {
    ctx.fillStyle = s.color;
    ctx.fillRect(pad, y - sw / 2, sw, sw);
    // Swatch outline for contrast on near-white swatches.
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, y - sw / 2 + 0.5, sw - 1, sw - 1);

    ctx.fillStyle = '#111';
    ctx.fillText(s.label, pad + sw + 8, y);
    y += rowH;
  }
  ctx.restore();
}

/** Pre-compute the layout dimensions for a swatch list. */
export function measureLegend(
  swatches: readonly LegendSwatch[],
  options: { rowHeight?: number; swatchSize?: number; padding?: number; maxLabel?: number } = {},
): { width: number; height: number } {
  const rowH = options.rowHeight ?? 22;
  const sw = options.swatchSize ?? 14;
  const pad = options.padding ?? 10;
  // A spartan estimate — 8px per character — sufficient for system-ui at 12px.
  const longest = swatches.reduce((m, s) => Math.max(m, s.label.length), 0);
  const labelWidth = Math.min(options.maxLabel ?? 240, longest * 8);
  return {
    width: pad + sw + 8 + labelWidth + pad,
    height: pad * 2 + rowH * swatches.length,
  };
}
