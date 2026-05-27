/**
 * ReportBranding.ts
 *
 * Brand defaults + the parsed colour the renderer uses. Kept pure (no
 * pdf-lib import) so tests can validate the colour-parsing math without
 * pulling the heavy renderer module in.
 *
 * Future sessions extend this with custom font registration; v0.3.3 ships
 * the colour + organisation + author + logo surface.
 */

import type { ReportBranding } from './types';

/** OpenLiDARViewer's accent — the same `#00b2ff` the live UI uses. */
export const DEFAULT_ACCENT = '#00b2ff';

/** A parsed RGB triple, each component 0-1 (pdf-lib's colour convention). */
export interface ParsedColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse a `#rrggbb` (or `#rgb`) hex colour into the 0-1-per-channel shape
 * pdf-lib's `rgb(r, g, b)` helper expects. Returns the default accent when
 * the input is missing or malformed.
 */
export function parseAccentColor(hex?: string): ParsedColor {
  // `hexToRgb(DEFAULT_ACCENT)` always parses because DEFAULT_ACCENT is a
  // valid 6-digit hex string; assert non-null so the fallback type is
  // narrow and the function signature stays clean.
  const fallback = hexToRgb(DEFAULT_ACCENT) as ParsedColor;
  if (!hex || typeof hex !== 'string') return fallback;
  const parsed = hexToRgb(hex);
  return parsed ?? fallback;
}

function hexToRgb(hex: string): ParsedColor | null {
  let h = hex.replace(/^#/, '').trim();
  if (h.length === 3) {
    // Expand 3-digit short form: #abc -> #aabbcc.
    h = h.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/**
 * Build the effective branding — merges the caller's overrides over the
 * defaults. Pure data; the renderer reads the result.
 */
export function effectiveBranding(b?: ReportBranding): Required<Pick<ReportBranding, 'accentColor'>> & ReportBranding {
  return {
    accentColor: b?.accentColor ?? DEFAULT_ACCENT,
    ...(b ?? {}),
  };
}
