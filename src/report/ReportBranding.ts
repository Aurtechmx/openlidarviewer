/**
 * ReportBranding.ts
 *
 * Brand defaults + the parsed colour the renderer uses. Kept pure (no
 * pdf-lib import) so tests can validate the colour-parsing math without
 * pulling the heavy renderer module in.
 *
 * Ships the colour + organisation + author + logo surface; custom font
 * registration is the natural next extension point.
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

/**
 * Resolved theme palette. The renderer reads these colours instead of
 * hard-coded values so the three named themes (`light-technical`,
 * `dark-inspection`, `minimal-engineering`) drop in without renderer
 * changes.
 */
export interface ReportThemePalette {
  /** Page background fill. */
  readonly pageBackground: ParsedColor;
  /** Primary body text. */
  readonly bodyText: ParsedColor;
  /** Muted text (labels, footer, dataset-row labels). */
  readonly mutedText: ParsedColor;
  /** Subtle rule colour (table separators, section dividers). */
  readonly rule: ParsedColor;
  /** Alternating row tint for table-style sections. */
  readonly rowTint: ParsedColor;
  /** Whether to draw the cover accent stripe. Minimal theme omits it. */
  readonly drawAccentStripe: boolean;
}

const PALETTES: Record<NonNullable<ReportBranding['theme']>, ReportThemePalette> = {
  'light-technical': {
    pageBackground: { r: 1, g: 1, b: 1 },
    bodyText: { r: 0.08, g: 0.10, b: 0.13 },
    mutedText: { r: 0.40, g: 0.43, b: 0.48 },
    rule: { r: 0.84, g: 0.86, b: 0.89 },
    rowTint: { r: 0.96, g: 0.97, b: 0.98 },
    drawAccentStripe: true,
  },
  'dark-inspection': {
    pageBackground: { r: 0.10, g: 0.12, b: 0.16 },
    bodyText: { r: 0.94, g: 0.95, b: 0.97 },
    mutedText: { r: 0.66, g: 0.70, b: 0.75 },
    rule: { r: 0.22, g: 0.26, b: 0.31 },
    rowTint: { r: 0.14, g: 0.17, b: 0.21 },
    drawAccentStripe: true,
  },
  'minimal-engineering': {
    pageBackground: { r: 1, g: 1, b: 1 },
    bodyText: { r: 0.08, g: 0.10, b: 0.13 },
    mutedText: { r: 0.45, g: 0.48, b: 0.53 },
    rule: { r: 0.78, g: 0.80, b: 0.83 },
    rowTint: { r: 0.98, g: 0.98, b: 0.99 },
    // Minimal engineering strips the accent stripe for an austere look —
    // section headers still use the accent colour as text, but no
    // chrome on the cover.
    drawAccentStripe: false,
  },
};

/**
 * Resolve a theme name to the colour palette the renderer reads. Defaults
 * to `light-technical` when no theme is set or the name is unknown.
 */
export function resolveTheme(name?: ReportBranding['theme']): ReportThemePalette {
  if (!name) return PALETTES['light-technical'];
  return PALETTES[name] ?? PALETTES['light-technical'];
}
