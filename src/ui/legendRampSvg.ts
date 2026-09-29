/**
 * legendRampSvg.ts
 *
 * The on-screen legend's horizontal ramp: a fluid SVG that fills the card's
 * inner width (every x is a percentage), a 16 px gradient bar, nice ticks
 * under it and, for elevation, the distribution strip above it. The strip's
 * bars take the ramp colour at their own height, so each bar reads as "this
 * many points are painted this colour".
 *
 * The strip is decorative (`aria-hidden`); its text alternative goes into the
 * SVG's accessible name. The figure/PDF burn-in keeps the fixed-size
 * generator in render/colorbar.ts; this one is only for the live card.
 */

import { colorbarStops, formatColorbarValue, niceTicks, type ColorbarSpec } from '../render/colorbar';
import type { ElevationHistogram } from '../render/elevationHistogram';

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const pct = (t: number): string => `${(t * 100).toFixed(2)}%`;

/** Vertical layout, in px. The strip sits between the title and the bar. */
export const RAMP_LAYOUT = { histTop: 18, histH: 22, barH: 16 } as const;

export function buildLegendRampSvg(
  spec: ColorbarSpec,
  hist: ElevationHistogram | null,
  summary: string,
): string {
  const { histTop, histH, barH } = RAMP_LAYOUT;
  const barY = hist ? histTop + histH + 2 : histTop + 2;
  const H = barY + barH + 18;
  const label = esc(spec.label);
  const unit = spec.unit ? ` ${esc(spec.unit)}` : '';
  const gradId = `olv-legend-${spec.palette}`;
  const stops = colorbarStops(spec.palette, 24)
    .map((s) => `<stop offset="${(s.t * 100).toFixed(1)}%" stop-color="rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})"/>`)
    .join('');
  const span = spec.max - spec.min;

  const ticks = niceTicks(spec.min, spec.max, spec.ticks ?? 5)
    .map((v) => {
      const t = (v - spec.min) / span;
      // Labels near an edge anchor inward so they never clip at the card side.
      const anchor = t < 0.06 ? 'start' : t > 0.94 ? 'end' : 'middle';
      const x = pct(t);
      return `<line x1="${x}" x2="${x}" y1="${barY + barH}" y2="${barY + barH + 4}" stroke="currentColor" stroke-opacity="0.55"/>` +
        `<text x="${x}" y="${barY + barH + 15}" font-size="10" text-anchor="${anchor}" fill="currentColor">${formatColorbarValue(v)}</text>`;
    })
    .join('');

  let strip = '';
  if (hist) {
    const n = hist.bins.length;
    const colours = colorbarStops(spec.palette, n);
    let peak = 0;
    for (const c of hist.bins) if (c > peak) peak = c;
    const bars: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = hist.bins[i];
      if (c === 0 || peak === 0) continue;
      // A non-empty bin keeps at least 1 px so a thin tail stays visible.
      const h = Math.max(1, (c / peak) * histH);
      const rgb = colours[i].rgb;
      bars.push(
        `<rect x="${pct(i / n)}" width="${pct(0.82 / n)}" y="${(histTop + histH - h).toFixed(1)}" height="${h.toFixed(1)}" fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"/>`,
      );
    }
    strip =
      `<g class="olv-colorbar-hist" aria-hidden="true">` +
      `<line x1="0" x2="100%" y1="${histTop + histH + 0.5}" y2="${histTop + histH + 0.5}" stroke="currentColor" stroke-opacity="0.25"/>` +
      `${bars.join('')}</g>`;
  }

  const name = esc(`${spec.label}${spec.unit ? ` ${spec.unit}` : ''} colour scale.${summary ? ` ${summary}` : ''}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}" role="img" aria-label="${name}">` +
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">${stops}</linearGradient></defs>` +
    `<text x="0" y="12" font-size="11" font-weight="600" fill="currentColor">${label}${unit}</text>` +
    strip +
    `<rect class="olv-colorbar-ramp" x="0" y="${barY}" width="100%" height="${barH}" rx="2" fill="url(#${gradId})" stroke="currentColor" stroke-opacity="0.4" stroke-width="0.5"/>` +
    `${ticks}</svg>`;
}
