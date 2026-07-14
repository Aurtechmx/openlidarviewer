/**
 * activeColorbar.ts
 *
 * The SINGLE spec-builder behind both colorbar consumers: the live on-screen
 * legend overlay (`ui/ColorbarOverlay`) and the snapshot burn-in
 * (`Viewer.snapshot({ colorbar: true })`). Both surfaces render whatever this
 * function returns, so the values burned into an exported figure can never
 * disagree with the legend the analyst saw on screen — one source, two
 * renderings.
 *
 * Per-mode honesty rules (each is a deliberate scientific decision):
 *
 *   - **elevation** — the default elevation ramp (Turbo, exactly what
 *     `colorByElevation` paints), the CRS-declared unit or NO unit at all
 *     (an unknown unit must never be presented as metres), and a
 *     "p5–p95 window" note whenever the percentile trim narrowed the ramp,
 *     so a reader knows the endpoints are not the true extremes.
 *   - **intensity** — a GRAYSCALE bar, because `colorByIntensity` paints
 *     grayscale; and no unit, because LAS intensity is a dimensionless DN
 *     whose scaling the app cannot vouch for.
 *   - **gpsTime** — normalised to seconds from the ramp window's start.
 *     Absolute GPS adjusted standard times are ~3e8 s, so raw ticks would be
 *     unreadable noise; the colour pass already normalises against the
 *     cloud window, so the offset encoding is exactly what the pixels show.
 *     The note says so, plus the percentile clipping the window carries.
 *   - **returnNumber** — the raw ordinal window on the CVD-safe scalar ramp.
 *   - everything else — `null`. rgb/classification/normal are not global
 *     scalars; density normalises per chunk (no single window to label);
 *     coverage/confidence are bucketed overlays whose legend lives in the
 *     Analyse panel. A continuous bar on any of them would fabricate a
 *     mapping the renderer does not use.
 *
 * Pure data + string math — no DOM, no three.js — so both the lazy UI chunk
 * and the lazy Viewer chunk can import it without dragging either's
 * dependencies into the other.
 */

import type { ColorMode } from './colorModes';
import { DEFAULT_ELEVATION_PALETTE, DEFAULT_SCALAR_PALETTE } from './colorModes';
import type { ColorbarSpec } from './colorbar';

/**
 * The viewer facts the spec-builder consumes. The caller (Viewer) owns HOW
 * these are read (static cloud vs streaming ranges, render-origin shifts);
 * this module owns WHAT the legend says about them.
 */
export interface ActiveColorbarSource {
  /** The active colour mode. */
  readonly mode: ColorMode;
  /**
   * The ramp window the active colouring actually normalises against, in
   * display values (elevation: world/source units with the render origin
   * added back; gpsTime: raw absolute seconds — normalised here). `null`
   * when the mode has no labelable window (categorical mode, missing
   * attribute, range not yet seeded on a streaming cloud).
   */
  readonly range: { readonly min: number; readonly max: number } | null;
  /**
   * Symmetric percentile trim that produced `range` (5 → p5–p95). 0 or
   * absent = the raw finite extremes; anything else earns a window note so
   * the endpoints are never mistaken for true min/max.
   */
  readonly trimPercent?: number;
  /**
   * Elevation unit label from the CRS service ('m' / 'ft'), or null when the
   * CRS (or its vertical unit) is unknown. Honesty rule: null ⇒ the legend
   * shows bare numbers, never a guessed unit.
   */
  readonly elevationUnit?: string | null;
}

/** A ready-to-render colorbar: the generator spec plus the honesty note. */
export interface ActiveColorbar {
  /** The mode this legend describes — drives per-mode dismissal in the overlay. */
  readonly mode: ColorMode;
  /** Feed to `buildColorbarSvg` (overlay) or rasterise via stops (burn-in). */
  readonly spec: ColorbarSpec;
  /** Honest sub-caption (trim window / normalisation), when one applies. */
  readonly note?: string;
}

/** The continuous scalar modes that carry an on-screen/burned-in colorbar. */
const SCALAR_BAR_MODES: ReadonlySet<ColorMode> = new Set([
  'elevation',
  'intensity',
  'gpsTime',
  'returnNumber',
]);

/**
 * Build the colorbar for the active colour mode, or `null` when the mode /
 * range does not support an honest continuous legend. See the module header
 * for the per-mode rules.
 */
export function buildActiveColorbarSpec(source: ActiveColorbarSource): ActiveColorbar | null {
  if (!SCALAR_BAR_MODES.has(source.mode)) return null;
  const range = source.range;
  if (!range) return null;
  // A poisoned (non-finite) or flat window cannot be labelled: a one-colour
  // bar says nothing, and NaN endpoints would render as garbage ticks.
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return null;
  if (!(range.max > range.min)) return null;

  const trim = source.trimPercent ?? 0;
  const windowNote = trim > 0 ? `p${trim}–p${100 - trim} window` : null;

  switch (source.mode) {
    case 'elevation': {
      return {
        mode: 'elevation',
        spec: {
          palette: DEFAULT_ELEVATION_PALETTE,
          min: range.min,
          max: range.max,
          label: 'Elevation',
          // `undefined` (not '') when unknown so the generator omits the
          // suffix entirely — the honesty rule made structural.
          unit: source.elevationUnit || undefined,
        },
        note: windowNote ?? undefined,
      };
    }
    case 'intensity': {
      return {
        mode: 'intensity',
        spec: {
          palette: 'grayscale',
          min: range.min,
          max: range.max,
          label: 'Intensity',
        },
        note: windowNote ?? undefined,
      };
    }
    case 'gpsTime': {
      const parts = ['seconds from window start'];
      if (windowNote) parts.push(windowNote);
      return {
        mode: 'gpsTime',
        spec: {
          palette: DEFAULT_SCALAR_PALETTE,
          min: 0,
          max: range.max - range.min,
          label: 'GPS time',
          unit: 's',
        },
        note: parts.join(' · '),
      };
    }
    case 'returnNumber': {
      return {
        mode: 'returnNumber',
        spec: {
          palette: DEFAULT_SCALAR_PALETTE,
          min: range.min,
          max: range.max,
          label: 'Return number',
        },
        note: windowNote ?? undefined,
      };
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Burn-in layout — the pure half of the snapshot rasteriser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Geometry for the colorbar burned into a snapshot. All values are canvas
 * pixels at the OUTPUT resolution: every metric derives from the canvas
 * height (the same rule `drawScaleBar` uses), so a 4× supersampled export
 * reads identically to a 1× one.
 */
export interface ColorbarBurnInLayout {
  /** Outer padding from the canvas edges. */
  readonly pad: number;
  /** Gradient bar width. */
  readonly barWidth: number;
  /** Gradient bar height. */
  readonly barHeight: number;
  /** Left edge of the gradient bar. */
  readonly barX: number;
  /** Top edge of the gradient bar. */
  readonly barY: number;
  /** Tick-label font size. */
  readonly fontSize: number;
  /** Title font size. */
  readonly titleFontSize: number;
  /** Tick mark length (drawn to the left of the bar, labels beyond). */
  readonly tickLength: number;
}

/**
 * Lay out the burn-in colorbar: a vertical bar hugging the RIGHT edge,
 * vertically centred. That corner is deliberately chosen against the other
 * snapshot furniture: the scale bar owns the bottom-left, the Studio's
 * scan-report card is composed onto the bottom-right AFTER the snapshot,
 * and the class-scope banner runs across the very top — the right-middle is
 * the one region none of them touch.
 */
export function burnInColorbarLayout(
  canvasWidth: number,
  canvasHeight: number,
): ColorbarBurnInLayout {
  // Same padding rule as drawScaleBar so the two overlays sit on a shared
  // visual margin at every export resolution.
  const pad = Math.max(12, Math.round(canvasHeight * 0.022));
  const fontSize = Math.max(11, Math.round(canvasHeight * 0.016));
  const titleFontSize = Math.max(12, Math.round(canvasHeight * 0.018));
  // ~28 % of the canvas height reads like a figure colorbar; the floor keeps
  // ticks legible on small canvases, and the cap guarantees the bar (plus
  // its title above) always fits inside the canvas with padding to spare.
  const maxBar = Math.max(32, canvasHeight - 2 * (pad + titleFontSize + 8));
  const barHeight = Math.min(Math.max(96, Math.round(canvasHeight * 0.28)), maxBar);
  const barWidth = Math.max(10, Math.round(canvasHeight * 0.014));
  const tickLength = Math.max(4, Math.round(barWidth * 0.5));
  const barX = canvasWidth - pad - barWidth;
  const barY = Math.round((canvasHeight - barHeight) / 2);
  return { pad, barWidth, barHeight, barX, barY, fontSize, titleFontSize, tickLength };
}
