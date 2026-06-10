/**
 * floorPlanSvg.ts
 *
 * Render a {@link FloorPlan} as a standalone, top-down SVG sketch — a clean
 * print style (NOT the app's dark theme; this is a downloadable artifact). The
 * sketch shows: the density-traced footprint outline, the dominant wall lines, a
 * scale bar, W × D dimension labels (m + ft), an orientation note (the sketch is
 * NOT north-aligned), and a prominent "approximate / not a survey" caption.
 *
 * Pure string output, deterministic, no DOM. Every interpolated value is
 * XML-escaped so a scan name with `<`/`&`/`"` can never break the markup.
 */

import type { FloorPlan } from './floorPlan';
import { metresToFeet } from '../spaceMetrics';

export interface FloorPlanSvgOptions {
  /** Title printed at the top of the sheet (e.g. the scan name). */
  readonly title?: string;
  /** Target sheet width in px (the drawing area scales to fit). Default 720. */
  readonly width?: number;
}

const APPROX_CAPTION =
  'Approximate sketch from point density — not a measured floor plan / survey.';

/** XML-escape a string for safe insertion into SVG text / attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A round-number scale bar length ≤ maxM, in metres. */
function niceBar(maxM: number): number {
  if (maxM <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
  for (const mult of [5, 2, 1]) {
    const v = mult * pow;
    if (v <= maxM) return v;
  }
  return pow;
}

/**
 * Render the floor-plan sketch to an SVG string. The plan-metre coordinates are
 * fitted into a padded drawing area with Y flipped (north up in the sketch's own
 * frame — NOT true north, which the orientation note states).
 */
export function floorPlanSvg(plan: FloorPlan, opts: FloorPlanSvgOptions = {}): string {
  const W = Math.max(360, Math.floor(opts.width ?? 720));
  const titleH = 54;
  const footerH = 96;
  const pad = 36;
  const [minX, minY, maxX, maxY] = plan.bbox;
  const planW = Math.max(1e-6, maxX - minX);
  const planD = Math.max(1e-6, maxY - minY);

  // Drawing area between the title and footer; keep the plan aspect.
  const drawW = W - 2 * pad;
  const drawTop = titleH;
  const targetDrawH = Math.max(180, Math.round(drawW * (planD / planW)));
  const drawH = Math.min(560, targetDrawH);
  const scale = Math.min(drawW / planW, drawH / planD);
  const usedW = planW * scale;
  const usedH = planD * scale;
  const offX = pad + (drawW - usedW) / 2;
  const offY = drawTop + (drawH - usedH) / 2;
  const totalH = drawTop + drawH + footerH;

  // plan-metre (x east, y north) → SVG px (y flipped so north is up).
  const px = (x: number): number => offX + (x - minX) * scale;
  const py = (y: number): number => offY + (maxY - y) * scale;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" font-family="Helvetica, Arial, sans-serif">`,
  );
  // Print-clean background.
  parts.push(`<rect x="0" y="0" width="${W}" height="${totalH}" fill="#ffffff"/>`);

  // ── Title ──
  const title = escapeXml((opts.title ?? 'Floor plan').trim() || 'Floor plan');
  parts.push(`<text x="${pad}" y="28" font-size="18" font-weight="bold" fill="#1a1d22">${title}</text>`);
  parts.push(`<text x="${pad}" y="46" font-size="11" fill="#6a6f78">Interior footprint sketch (top-down)</text>`);

  if (plan.outline.length < 3) {
    parts.push(
      `<text x="${pad}" y="${drawTop + 40}" font-size="12" fill="#8a2f1e">No footprint outline could be traced yet.</text>`,
    );
  } else {
    // ── Footprint outline (blocky, density-traced) ──
    let d = '';
    plan.outline.forEach((p, i) => {
      d += `${i === 0 ? 'M' : 'L'}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)} `;
    });
    d += 'Z';
    parts.push(`<path d="${d}" fill="#eef1f5" stroke="#2a2e35" stroke-width="1.6" stroke-linejoin="round"/>`);

    // ── Dominant wall lines (thicker, drawn over the outline) ──
    for (const wall of plan.walls) {
      const [a, b] = wall.segment;
      parts.push(
        `<line x1="${px(a[0]).toFixed(1)}" y1="${py(a[1]).toFixed(1)}" x2="${px(b[0]).toFixed(1)}" y2="${py(b[1]).toFixed(1)}" stroke="#1a1d22" stroke-width="3" stroke-linecap="round"/>`,
      );
    }
  }

  // ── Dimension labels (W × D, m + ft) ──
  const wFt = metresToFeet(plan.widthM);
  const dFt = metresToFeet(plan.depthM);
  const dimY = drawTop + drawH + 26;
  parts.push(
    `<text x="${pad}" y="${dimY}" font-size="12" fill="#1a1d22">Width ${plan.widthM.toFixed(1)} m (${wFt.toFixed(1)} ft) x Depth ${plan.depthM.toFixed(1)} m (${dFt.toFixed(1)} ft)</text>`,
  );

  // ── Scale bar ──
  const barM = niceBar(Math.max(planW, planD) / 4);
  if (barM > 0 && scale > 0) {
    const barPx = barM * scale;
    const bx = W - pad - barPx;
    const by = drawTop + drawH + 18;
    parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barPx.toFixed(1)}" height="6" fill="#1a1d22"/>`);
    parts.push(
      `<text x="${(bx + barPx).toFixed(1)}" y="${(by - 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#1a1d22">${barM} m</text>`,
    );
  }

  // ── Orientation note + honesty caption (footer) ──
  const fy = drawTop + drawH + 46;
  parts.push(
    `<text x="${pad}" y="${fy}" font-size="10" fill="#6a6f78">Orientation: sketch frame only — not aligned to true north.</text>`,
  );
  parts.push(
    `<text x="${pad}" y="${fy + 18}" font-size="11" font-weight="bold" fill="#8a2f1e">${escapeXml(APPROX_CAPTION)}</text>`,
  );
  parts.push(
    `<text x="${pad}" y="${fy + 34}" font-size="9.5" fill="#6a6f78">${escapeXml('Gaps are unscanned areas, not openings. Right-angles are not assumed.')}</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}
