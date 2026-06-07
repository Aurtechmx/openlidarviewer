/**
 * ScanReportRenderer.ts
 *
 * Composites a small "scan report" card into the bottom-right corner of an
 * exported PNG so the artifact carries its own context — what the export is,
 * what cloud it was shot from, how big the scene was, what mode rendered it,
 * and when it was produced. Without this card, the four Studio modes
 * (especially Height Map / Intensity / Class Map) lose meaning the moment
 * the file leaves the viewer.
 *
 * The composite path: decode the snapshot Blob into a 2-D canvas, draw a
 * translucent card with a header + key-value rows, re-encode to a Blob. Pure
 * 2-D canvas drawing — no three.js, no WebGPU.
 *
 * Card position: bottom-right by default. The card auto-sizes to its
 * content and never exceeds 40% of the canvas width.
 */

/** One row of the report — a label/value pair. */
export interface ScanReportRow {
  readonly label: string;
  readonly value: string;
}

/** The full set of fields the exporter feeds in. */
export interface ScanReportData {
  /** Bold title shown at the top of the card (mode label, e.g. "Height Map"). */
  readonly title: string;
  /** Scan name — defaults to the cloud filename. */
  readonly scanName: string;
  /** Key-value detail rows. Order is preserved. */
  readonly rows: readonly ScanReportRow[];
  /** Footer line — typically "OpenLiDARViewer · YYYY-MM-DD HH:MM". */
  readonly footer: string;
}

/** Card placement on the canvas. */
export type ScanReportCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

// Card sizing — all values are nudged 20% above the baseline baseline so
// the report reads clearly on a full-resolution export. Bumping these
// constants is the single knob; the rest of the layout is computed.
const PADDING = 19;       // 16 × 1.2
const TITLE_SIZE = 19;    // 16 × 1.2
const NAME_SIZE = 16;     // 13 × 1.2 (rounded up)
const ROW_SIZE = 14;      // 12 × 1.2 (rounded down)
const FOOTER_SIZE = 13;   // 11 × 1.2 (rounded up)
const ROW_GAP = 7;        //  6 × 1.2
const SECTION_GAP = 12;   // 10 × 1.2
const BG_FILL = 'rgba(10, 14, 22, 0.86)';
const BG_STROKE = 'rgba(255, 255, 255, 0.12)';
const TEXT_PRIMARY = '#f4f6fa';
const TEXT_SECONDARY = '#a8b0bc';
const ACCENT = '#4f9dff';

/**
 * Decode a PNG Blob into an `HTMLImageElement` so a 2-D canvas can draw it.
 * Used internally by {@link composeScanReportOntoBlob} and exported so
 * callers can drive their own compositing.
 */
export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error(`blobToImage: failed to decode (${String(e)})`));
    };
    img.src = url;
  });
}

/**
 * Measure the card layout — width and height in pixels — without drawing.
 * Useful both for the layout pass below and for callers that want to know
 * how much space the card will take before positioning anchors.
 */
export function measureScanReport(
  ctx: CanvasRenderingContext2D,
  data: ScanReportData,
  options: { maxWidth?: number } = {},
): { width: number; height: number; rowLayout: number[] } {
  ctx.save();
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  const titleW = ctx.measureText(data.title).width;
  ctx.font = `${NAME_SIZE}px system-ui, -apple-system, sans-serif`;
  const nameW = ctx.measureText(data.scanName).width;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  // Each row is `label: value` with the value right-aligned. The widest
  // label + the widest value (plus a separator gap) drive the card width.
  let labelMax = 0;
  let valueMax = 0;
  const rowLayout: number[] = [];
  for (const row of data.rows) {
    const lw = ctx.measureText(`${row.label}`).width;
    const vw = ctx.measureText(`${row.value}`).width;
    if (lw > labelMax) labelMax = lw;
    if (vw > valueMax) valueMax = vw;
    rowLayout.push(lw);
  }
  ctx.font = `${FOOTER_SIZE}px system-ui, -apple-system, sans-serif`;
  const footerW = ctx.measureText(data.footer).width;
  ctx.restore();

  // Row width = label + gap + value, with at least 14 px gap between them.
  // 29 = 24 × 1.2 — the label-to-value gap scales with the rest of the card.
  const rowWidth = labelMax + 29 + valueMax;
  const contentWidth = Math.max(titleW, nameW, rowWidth, footerW);
  let width = contentWidth + PADDING * 2;
  if (options.maxWidth && width > options.maxWidth) width = options.maxWidth;

  // Vertical layout: padding + title + name + section-gap + rows + section-gap + footer + padding.
  const rowsHeight = data.rows.length === 0
    ? 0
    : data.rows.length * ROW_SIZE + (data.rows.length - 1) * ROW_GAP;
  const height =
    PADDING +
    TITLE_SIZE +
    4 +
    NAME_SIZE +
    SECTION_GAP +
    rowsHeight +
    SECTION_GAP +
    FOOTER_SIZE +
    PADDING;

  return { width, height, rowLayout };
}

/**
 * Draw the report card into `ctx` at the requested corner of the canvas.
 * `ctx.canvas` provides the canvas bounds we anchor against.
 */
export function drawScanReport(
  ctx: CanvasRenderingContext2D,
  data: ScanReportData,
  corner: ScanReportCorner = 'bottom-right',
  margin = 24,
): void {
  // Cap the card at 48% of the canvas width (was 40%) — the Studio
  // 20%-larger card needs the extra headroom on narrower viewports.
  const maxCardWidth = Math.floor(ctx.canvas.width * 0.48);
  const { width, height } = measureScanReport(ctx, data, { maxWidth: maxCardWidth });

  // Anchor the card to the requested corner with a `margin` inset.
  let x = ctx.canvas.width - width - margin;
  let y = ctx.canvas.height - height - margin;
  if (corner === 'bottom-left') x = margin;
  if (corner === 'top-right') y = margin;
  if (corner === 'top-left') { x = margin; y = margin; }

  ctx.save();

  // Card background — rounded translucent dark with a 1-px hairline border.
  ctx.fillStyle = BG_FILL;
  ctx.strokeStyle = BG_STROKE;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, height, 8);
  ctx.fill();
  ctx.stroke();

  // Accent stripe down the left edge — visual cue this is the report card.
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x, y, 3, height);

  // Title (bold).
  let cy = y + PADDING + TITLE_SIZE;
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(data.title, x + PADDING, cy);

  // Scan name (secondary).
  cy += 4 + NAME_SIZE;
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = `${NAME_SIZE}px system-ui, -apple-system, sans-serif`;
  // Truncate the name if it overflows.
  const nameMax = width - PADDING * 2;
  let name = data.scanName;
  if (ctx.measureText(name).width > nameMax) {
    while (name.length > 4 && ctx.measureText(`${name}…`).width > nameMax) {
      name = name.slice(0, -1);
    }
    name = `${name}…`;
  }
  ctx.fillText(name, x + PADDING, cy);

  // Rows — left-aligned label, right-aligned value.
  cy += SECTION_GAP;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  for (const row of data.rows) {
    cy += ROW_SIZE;
    ctx.fillStyle = TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, x + PADDING, cy);
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.textAlign = 'right';
    ctx.fillText(row.value, x + width - PADDING, cy);
    cy += ROW_GAP;
  }
  // Undo the trailing ROW_GAP so the section spacing is correct below.
  if (data.rows.length > 0) cy -= ROW_GAP;

  // Footer (small, secondary, left-aligned).
  cy += SECTION_GAP + FOOTER_SIZE;
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = `${FOOTER_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(data.footer, x + PADDING, cy);

  ctx.restore();
}

/**
 * The full compositing pipeline used by every Studio exporter: take a PNG
 * Blob (the WYSIWYG snapshot from `adapter.snapshot()`), decode it onto a
 * 2-D canvas, draw the scan report in the requested corner, re-encode to a
 * PNG Blob.
 *
 * Robustness: if the Blob fails to decode (rare — browser-side issue) the
 * function returns the input Blob unchanged rather than throwing, so an
 * export that succeeded at the GL layer still produces an artifact even if
 * the report compositing breaks.
 */
export async function composeScanReportOntoBlob(
  source: Blob,
  data: ScanReportData,
  corner: ScanReportCorner = 'bottom-right',
): Promise<Blob> {
  let img: HTMLImageElement;
  try {
    img = await blobToImage(source);
  } catch (err) {
    console.warn('[export] scan-report composite skipped — image decode failed:', err);
    return source;
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(img, 0, 0);
  drawScanReport(ctx, data, corner);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('composeScanReportOntoBlob: canvas.toBlob returned null'));
    }, 'image/png');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Class-scope banner (escape-hatch closure for filtered raster exports)
// ─────────────────────────────────────────────────────────────────────────────

const BANNER_BG = 'rgba(180, 90, 20, 0.92)';   // amber — reads as a caveat
const BANNER_TEXT = '#ffffff';
const BANNER_FONT_SIZE = 16;
const BANNER_PAD_X = 16;
const BANNER_PAD_Y = 9;
const BANNER_MARGIN = 18;

/**
 * Draw a class-scope caveat banner across the top-centre of the canvas — e.g.
 * "Class filter active — Ground + Building · 2 of 5 classes". Called by the
 * Studio compose path only while a filter hides at least one class, so a
 * filtered raster carries its own disclosure and can't masquerade as a
 * full-cloud image. Pure 2-D canvas drawing — no three.js, no WebGPU.
 */
export function drawClassScopeBanner(
  ctx: CanvasRenderingContext2D,
  scopeStamp: string,
): void {
  const stamp = scopeStamp.trim();
  if (stamp.length === 0) return; // full / unfiltered view — draw nothing.
  const label = `Class filter active — ${stamp}`;

  ctx.save();
  ctx.font = `600 ${BANNER_FONT_SIZE}px system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(label).width;
  const bannerW = Math.min(
    textW + BANNER_PAD_X * 2,
    Math.max(0, ctx.canvas.width - BANNER_MARGIN * 2),
  );
  const bannerH = BANNER_FONT_SIZE + BANNER_PAD_Y * 2;
  const x = Math.round((ctx.canvas.width - bannerW) / 2);
  const y = BANNER_MARGIN;

  // Pill background with a hairline border, mirroring the report card chrome.
  ctx.fillStyle = BANNER_BG;
  ctx.strokeStyle = BG_STROKE;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, bannerW, bannerH, 8);
  ctx.fill();
  ctx.stroke();

  // Centred label, truncated with an ellipsis if it would overflow the pill.
  ctx.fillStyle = BANNER_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxText = bannerW - BANNER_PAD_X * 2;
  let drawn = label;
  if (ctx.measureText(drawn).width > maxText) {
    while (drawn.length > 4 && ctx.measureText(`${drawn}…`).width > maxText) {
      drawn = drawn.slice(0, -1);
    }
    drawn = `${drawn}…`;
  }
  ctx.fillText(drawn, ctx.canvas.width / 2, y + bannerH / 2 + 1);
  ctx.restore();
}

/**
 * Compose a class-scope banner onto a PNG Blob — decode, draw the banner,
 * re-encode. The Studio export pipeline calls this after the scan-report card
 * is composited, but only while a filter is active. With an empty stamp the
 * input Blob is returned unchanged, so an unfiltered export is byte-identical
 * to before. Decode failures return the input Blob (an export that succeeded
 * at the GL layer still produces an artifact).
 */
export async function composeClassScopeBannerOntoBlob(
  source: Blob,
  scopeStamp: string,
): Promise<Blob> {
  if (scopeStamp.trim().length === 0) return source;

  let img: HTMLImageElement;
  try {
    img = await blobToImage(source);
  } catch (err) {
    console.warn('[export] class-scope banner skipped — image decode failed:', err);
    return source;
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(img, 0, 0);
  drawClassScopeBanner(ctx, scopeStamp);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('composeClassScopeBannerOntoBlob: canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/**
 * Helper — a rounded-corner rect path for `fill` + `stroke`. Inline here so
 * the ScanReportRenderer is self-contained.
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Pretty-print a number with locale separators, capped to a sensible
 * precision. Exporters use this to format point counts in the report.
 */
export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format a metre value with appropriate precision: km for big footprints,
 * m for moderate, cm for fine. Exporters use this for footprint dimensions.
 */
export function formatMetres(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${(m * 100).toFixed(1)} cm`;
}

/**
 * Format a YYYY-MM-DD HH:MM timestamp in the user's local timezone — the
 * footer of every scan report. Pure function for testability.
 */
export function formatTimestamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
