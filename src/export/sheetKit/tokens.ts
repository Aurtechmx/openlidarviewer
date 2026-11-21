/**
 * tokens.ts: colours, type sizes and line weights for the export sheets.
 *
 * One table per sheet style. Emitters read a token set instead of defining
 * their own colours, so the contour sheet, the profile sheet and the reports
 * agree. Pure data with no pdf-lib or DOM dependency, so a dialog can import
 * the style list without pulling in a PDF chunk.
 *
 * Colours are sRGB triples in [0, 1]. Classic keeps the exact values the
 * contour map sheet has drawn since v0.6, so a Classic sheet can match the
 * earlier output byte for byte.
 */

/** The sheet styles a user can pick. Light is the default. */
export type SheetStyle = 'light' | 'dark' | 'classic';

export const SHEET_STYLES: readonly SheetStyle[] = ['light', 'dark', 'classic'];

export const DEFAULT_SHEET_STYLE: SheetStyle = 'light';

/** An sRGB colour, each channel in [0, 1]. */
export type SheetRgb = readonly [number, number, number];

export interface SheetTokens {
  readonly style: SheetStyle;
  /** Plain-language name for the export dialog. */
  readonly label: string;
  // Surfaces
  readonly paper: SheetRgb;
  readonly panel: SheetRgb;
  readonly nodata: SheetRgb;
  readonly hatch: SheetRgb;
  // Text and rules
  readonly ink: SheetRgb;
  readonly dim: SheetRgb;
  readonly rule: SheetRgb;
  readonly halo: SheetRgb;
  // Map content
  readonly minor: SheetRgb;
  readonly index: SheetRgb;
  readonly contourLabel: SheetRgb;
  readonly outline: SheetRgb;
  readonly area: SheetRgb;
  readonly accent: SheetRgb;
  // Relief raster
  /** Hillshade output is mapped into [shadeLo, shadeHi] before tinting. */
  readonly shadeLo: number;
  readonly shadeHi: number;
  /** Elevation tint ramp, low to high. Empty means no tint. */
  readonly tint: readonly SheetRgb[];
  readonly tintAlpha: number;
  // Line weights, points
  readonly weight: {
    readonly minor: number;
    readonly index: number;
    readonly outline: number;
    readonly frame: number;
    readonly rule: number;
    readonly area: number;
  };
  /** Dash pattern for contour runs over filled cells, points. */
  readonly filledDash: readonly number[];
}

/** Type sizes in points, shared by every style. */
export const SHEET_TYPE = {
  kicker: 8,
  title: 18,
  subtitle: 8.5,
  section: 7,
  legend: 7.5,
  dataKey: 6.5,
  dataValue: 7.5,
  tick: 6,
  contourLabel: 6.5,
  note: 6.5,
  footer: 6,
} as const;

const hex = (h: number): SheetRgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const LIGHT: SheetTokens = {
  style: 'light',
  label: 'Light',
  paper: hex(0xf4f2ee),
  panel: hex(0xffffff),
  nodata: hex(0xd9d6d0),
  hatch: hex(0xb3ada2),
  ink: hex(0x1d2329),
  dim: hex(0x5f6770),
  rule: hex(0xc9ccd0),
  halo: hex(0xffffff),
  minor: hex(0x2f6b55),
  index: hex(0xa4461c),
  contourLabel: hex(0x8f3a14),
  outline: hex(0x1d2329),
  area: hex(0xd8342a),
  accent: hex(0xc42f25),
  shadeLo: 0.3,
  shadeHi: 1,
  tint: [hex(0xcfdcc4), hex(0xe4e0c5), hex(0xe6d2b4), hex(0xd9c0a6)],
  tintAlpha: 0.3,
  weight: { minor: 0.35, index: 0.9, outline: 0.8, frame: 0.6, rule: 0.4, area: 1.2 },
  filledDash: [2, 1.5],
};

const DARK: SheetTokens = {
  style: 'dark',
  label: 'Dark',
  paper: hex(0x0c1116),
  panel: hex(0x111921),
  nodata: hex(0x161e26),
  hatch: hex(0x2c3a46),
  ink: hex(0xe6edf3),
  dim: hex(0x8b98a5),
  rule: hex(0x26323d),
  halo: hex(0x0c1116),
  minor: hex(0x3fbf9f),
  index: hex(0xffb547),
  contourLabel: hex(0xffc46b),
  outline: hex(0x9fb3c4),
  area: hex(0xff4d5e),
  accent: hex(0x3fd0ff),
  shadeLo: 0.05,
  shadeHi: 0.55,
  tint: [hex(0x0f3b46), hex(0x1d4d48), hex(0x3b4a35), hex(0x5a4630)],
  tintAlpha: 0.55,
  weight: { minor: 0.35, index: 0.9, outline: 0.8, frame: 0.6, rule: 0.4, area: 1.2 },
  filledDash: [2, 1.5],
};

/** The contour map sheet's colours before v0.7.2: sepia lines on white, no relief. */
const CLASSIC: SheetTokens = {
  style: 'classic',
  label: 'Classic',
  paper: [1, 1, 1],
  panel: [1, 1, 1],
  nodata: [1, 1, 1],
  hatch: [0.8, 0.8, 0.8],
  ink: [0.12, 0.14, 0.18],
  dim: [0.42, 0.46, 0.52],
  rule: [0.79, 0.8, 0.82],
  halo: [1, 1, 1],
  minor: [0.36, 0.24, 0.13],
  index: [0.24, 0.14, 0.05],
  contourLabel: [0.24, 0.14, 0.05],
  outline: [0.2, 0.22, 0.26],
  area: [0.36, 0.24, 0.13],
  accent: [0.12, 0.14, 0.18],
  shadeLo: 1,
  shadeHi: 1,
  tint: [],
  tintAlpha: 0,
  weight: { minor: 0.35, index: 0.9, outline: 0.8, frame: 0.6, rule: 0.4, area: 1.2 },
  filledDash: [2, 1.5],
};

const TOKENS: Readonly<Record<SheetStyle, SheetTokens>> = { light: LIGHT, dark: DARK, classic: CLASSIC };

/** The token set for `style`. An unknown value falls back to the default style. */
export function sheetTokens(style: SheetStyle | string | null | undefined): SheetTokens {
  return TOKENS[style as SheetStyle] ?? TOKENS[DEFAULT_SHEET_STYLE];
}

/** True when `s` names a sheet style. */
export function isSheetStyle(s: unknown): s is SheetStyle {
  return typeof s === 'string' && (SHEET_STYLES as readonly string[]).includes(s);
}

/** The CSS form of a token colour, for SVG output: `#rrggbb`. */
export function cssColor(c: SheetRgb): string {
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

/** WCAG 2 relative luminance of a token colour. */
export function relativeLuminance(c: SheetRgb): number {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2 contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: SheetRgb, b: SheetRgb): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The tint ramp colour at `t` in [0, 1], linearly interpolated between the
 * ramp's stops. Returns null when the style has no tint.
 */
export function tintAt(tokens: SheetTokens, t: number): SheetRgb | null {
  const ramp = tokens.tint;
  if (ramp.length === 0) return null;
  if (ramp.length === 1) return ramp[0]!;
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(u));
  const f = u - i;
  const a = ramp[i]!, b = ramp[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
