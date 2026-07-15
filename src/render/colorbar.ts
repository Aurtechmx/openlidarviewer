/**
 * colorbar.ts
 *
 * A pure colorbar / legend generator for the perceptual elevation-and-scalar
 * ramps. A quantitative point-cloud figure is not publishable without a labelled
 * colorbar: it maps colour back to a value + unit, names the field, and — because
 * it samples the SAME ramp the points on screen use ({@link elevationRampColor})
 * — it can never disagree with the colouring it labels.
 *
 * This is the shared foundation for two publishability surfaces: the on-screen
 * legend overlay and the colorbar burned into figure / map-sheet exports. It
 * emits a self-contained, deterministic SVG string (no DOM, no external CSS), so
 * the same bytes render on screen, in a PDF, or beside a PNG.
 *
 * Pure and deterministic. Tick values are "nice" round numbers; every text value
 * is XML-escaped so an arbitrary field name can never break the SVG (or inject
 * markup when the string is shown on screen).
 */

import { elevationRampColor, type ElevationPalette } from './colorModes';

/**
 * The ramps a colorbar can label. Every named perceptual palette, plus
 * `'grayscale'` — the intensity mode's actual painting (`colorByIntensity`
 * without a palette maps t → round(t·255) on all three channels). The
 * grayscale entry exists for the honesty rule: an intensity legend must
 * sample the SAME mapping the points use, and that mapping is not one of the
 * elevation ramps.
 */
export type ColorbarRamp = ElevationPalette | 'grayscale';

export interface ColorbarSpec {
  /** The ramp to render (matches the on-screen colouring). */
  readonly palette: ColorbarRamp;
  /** Data value at the ramp's low end. */
  readonly min: number;
  /** Data value at the ramp's high end. */
  readonly max: number;
  /** Field name shown as the title (e.g. 'Elevation', 'Intensity'). */
  readonly label: string;
  /** Unit suffix on the tick values (e.g. 'm', 'ft', ''). */
  readonly unit?: string;
  /** Target tick count. Default 5. */
  readonly ticks?: number;
  /** Bar orientation. Default 'vertical'. */
  readonly orientation?: 'vertical' | 'horizontal';
}

export interface ColorbarStop {
  /** Normalised position 0..1 along the ramp. */
  readonly t: number;
  /** The ramp colour at `t`, [r, g, b] in 0-255. */
  readonly rgb: readonly [number, number, number];
}

/** Sample the ramp at `samples` evenly-spaced stops (inclusive of 0 and 1). */
export function colorbarStops(palette: ColorbarRamp, samples = 24): ColorbarStop[] {
  const n = Math.max(2, Math.floor(samples));
  const out: ColorbarStop[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (palette === 'grayscale') {
      // Mirror `colorByIntensity`'s grayscale mapping EXACTLY (t → round(t·255)
      // per channel) — the intensity legend must never show a grey the
      // renderer wouldn't paint for the same normalised value.
      const grey = Math.round(t * 255);
      out.push({ t, rgb: [grey, grey, grey] });
    } else {
      out.push({ t, rgb: elevationRampColor(t, palette) });
    }
  }
  return out;
}

/**
 * "Nice" round tick values spanning [min, max] — the standard 1/2/5×10ⁿ step
 * selection so a colorbar reads 0, 25, 50, 75, 100 rather than raw data extents.
 * Returns an ascending list including the rounded ends. Degenerate (min===max or
 * non-finite) inputs yield a single midpoint tick.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return Number.isFinite(min) ? [min] : [];
  }
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const span = hi - lo;
  const rawStep = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * mag;
  const first = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= hi + step * 1e-6; v += step) {
    // Snap tiny FP dust to 0 and round to the step's precision.
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return ticks;
}

/** XML-escape a text value for safe inclusion in the SVG. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a tick value: integer when whole, else up to 2 dp, trimmed. Exported
 * so the legend overlay's explicit min–max range line formats its endpoints
 * with the SAME rule the SVG's tick labels use — two formatters would let the
 * range line and the ticks disagree on the same number.
 */
export function formatColorbarValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(2)));
}

/**
 * Build a self-contained SVG colorbar. Vertical: a gradient bar with the title
 * above and tick labels down the right side. The gradient uses discrete `<stop>`
 * elements sampled from the ramp, so it renders identically everywhere.
 */
export function buildColorbarSvg(spec: ColorbarSpec): string {
  const orientation = spec.orientation ?? 'vertical';
  const label = esc(spec.label);
  const unit = spec.unit ? ` ${esc(spec.unit)}` : '';
  const stops = colorbarStops(spec.palette, 24);
  const gradId = `olv-cbar-${spec.palette}`;

  const stopEls = stops
    .map((s) => `<stop offset="${(s.t * 100).toFixed(1)}%" stop-color="rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})"/>`)
    .join('');

  const ticks = niceTicks(spec.min, spec.max, spec.ticks ?? 5);
  const range = spec.max - spec.min;
  const posOf = (v: number): number => (range === 0 ? 0.5 : (v - spec.min) / range);

  if (orientation === 'horizontal') {
    const W = 220, barH = 12, x0 = 8, y0 = 22, barW = W - 2 * x0;
    const tickEls = ticks
      .map((v) => {
        const x = x0 + posOf(v) * barW;
        return `<line x1="${x.toFixed(1)}" y1="${y0 + barH}" x2="${x.toFixed(1)}" y2="${y0 + barH + 4}" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>` +
          `<text x="${x.toFixed(1)}" y="${y0 + barH + 15}" font-size="9" text-anchor="middle" fill="currentColor">${formatColorbarValue(v)}</text>`;
      })
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="52" viewBox="0 0 ${W} 52" role="img" aria-label="${label}${unit} colour scale">` +
      `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">${stopEls}</linearGradient></defs>` +
      `<text x="${x0}" y="14" font-size="11" font-weight="600" fill="currentColor">${label}${unit}</text>` +
      `<rect x="${x0}" y="${y0}" width="${barW}" height="${barH}" fill="url(#${gradId})" stroke="currentColor" stroke-opacity="0.4" stroke-width="0.5"/>` +
      `${tickEls}</svg>`;
  }

  // Vertical (default): gradient runs bottom (min) → top (max).
  const H = 200, barW = 14, x0 = 8, y0 = 22, barH = H - y0 - 12;
  const yOf = (v: number): number => y0 + (1 - posOf(v)) * barH;
  const tickEls = ticks
    .map((v) => {
      const y = yOf(v);
      return `<line x1="${x0 + barW}" y1="${y.toFixed(1)}" x2="${x0 + barW + 4}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>` +
        `<text x="${x0 + barW + 7}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="start" fill="currentColor">${formatColorbarValue(v)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="${H}" viewBox="0 0 70 ${H}" role="img" aria-label="${label}${unit} colour scale">` +
    `<defs><linearGradient id="${gradId}" x1="0%" y1="100%" x2="0%" y2="0%">${stopEls}</linearGradient></defs>` +
    `<text x="${x0}" y="14" font-size="11" font-weight="600" fill="currentColor">${label}${unit}</text>` +
    `<rect x="${x0}" y="${y0}" width="${barW}" height="${barH}" fill="url(#${gradId})" stroke="currentColor" stroke-opacity="0.4" stroke-width="0.5"/>` +
    `${tickEls}</svg>`;
}
