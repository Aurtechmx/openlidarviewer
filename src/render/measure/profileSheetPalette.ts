/**
 * profileSheetPalette.ts: the colours and type sizes of the Light and Dark
 * profile drawing set, after the blue of a cyanotype print.
 *
 * One hue from paper to ink, and one yellow that marks only what is steep. The
 * palette is a {@link SheetTokens}, so the shared relief raster, footer and
 * text helpers draw in it unchanged. Pure data.
 */
import { sheetTokens, type SheetRgb, type SheetStyle, type SheetTokens } from '../../export/sheetKit/tokens';

const hex = (h: number): SheetRgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export interface ProfilePalette extends SheetTokens {
  /** The cut face of the ground. */
  readonly earth: SheetRgb;
  /** The station band the ground stands on. */
  readonly base: SheetRgb;
  /** The sampled line. */
  readonly surface: SheetRgb;
  /** Ground-class returns, and every other return. */
  readonly groundDot: SheetRgb;
  readonly otherDot: SheetRgb;
  /** Bars and small filled shapes. */
  readonly solid: SheetRgb;
  /** The steep mark, and the text set on it. */
  readonly hot: SheetRgb;
  readonly hotInk: SheetRgb;
  /** Secondary text on the base. */
  readonly baseDim: SheetRgb;
}

const LIGHT: ProfilePalette = {
  ...sheetTokens('light'),
  paper: hex(0xf4f7f8), panel: hex(0xf4f7f8), nodata: hex(0xdde4ea), hatch: hex(0xa9b8c6),
  ink: hex(0x0c2340), dim: hex(0x4d6178), rule: hex(0xcfd9e0), halo: hex(0xf4f7f8),
  minor: hex(0x4d6178), index: hex(0x0c2340), contourLabel: hex(0x0c2340), outline: hex(0x0c2340),
  accent: hex(0x0c2340), warn: hex(0x8a3d00),
  shadeLo: 0.38, shadeHi: 1, tint: [hex(0xe8f0f5), hex(0xb9d0e3), hex(0x6c98c0)], tintAlpha: 0.75,
  earth: hex(0xc9dbe9), base: hex(0xdce8f1), surface: hex(0x0e2f55), groundDot: hex(0x1c3f68), otherDot: hex(0x5b8fbf),
  solid: hex(0x5c7896), hot: hex(0xf5b700), hotInk: hex(0x0c2340), baseDim: hex(0x3d546b),
};

const DARK: ProfilePalette = {
  ...sheetTokens('dark'),
  paper: hex(0x0b2747), panel: hex(0x0b2747), nodata: hex(0x12304f), hatch: hex(0x2d5178),
  ink: hex(0xeef4f8), dim: hex(0xa9c2da), rule: hex(0x24466d), halo: hex(0x0b2747),
  minor: hex(0x9db9d4), index: hex(0xeef4f8), contourLabel: hex(0xeef4f8), outline: hex(0xeef4f8),
  accent: hex(0xeef4f8), warn: hex(0xffb27a),
  shadeLo: 0.1, shadeHi: 0.62, tint: [hex(0x0f3660), hex(0x2c639c), hex(0x6fa5d8)], tintAlpha: 0.6,
  earth: hex(0x1d4f86), base: hex(0x163f6d), surface: hex(0xeef4f8), groundDot: hex(0xe3edf4), otherDot: hex(0x6fa5d8),
  solid: hex(0x6fa5d8), hot: hex(0xffc21a), hotInk: hex(0x0c2340), baseDim: hex(0xbcd2e6),
};

/** The palette of a styled profile set. */
export function profilePalette(style: SheetStyle): ProfilePalette {
  return style === 'dark' ? DARK : LIGHT;
}

/** Type sizes, points. Nothing on the set is set smaller than `small`. */
export const PROFILE_TYPE = {
  small: 9.5, label: 10.5, figure: 11.5, body: 12, value: 13, head: 15, lead: 18, sheet: 34, title: 42,
} as const;

/** A grade at or above this, either way, is marked. */
export const STEEP_PERCENT = 30;
