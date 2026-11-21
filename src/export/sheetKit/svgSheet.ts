/**
 * svgSheet.ts: the relief and footprint a Light or Dark contour SVG draws,
 * with the raster encoded as a PNG data URL. Asynchronous because PNG
 * encoding is; the SVG writer itself stays synchronous and pure.
 */
import { contourSheetRaster, contourSheetRelief, type SheetReliefInput } from './contourSheetModel';
import { encodePng } from './png';
import { sheetTokens, type SheetStyle, type SheetTokens } from './tokens';

/** Longest side of the raster embedded in an SVG, pixels. Smaller than the PDF's, as the SVG carries it as base64 text. */
const SVG_RASTER_SIDE = 1200;

export interface SvgSheet {
  readonly tokens: SheetTokens;
  readonly relief: {
    readonly href: string;
    readonly extent: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
    readonly outline: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
    readonly hasHoles: boolean;
    readonly highest: { readonly x: number; readonly y: number; readonly z: number } | null;
    readonly lowest: { readonly x: number; readonly y: number; readonly z: number } | null;
  } | null;
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The SVG sheet for `style` over `grid` (local frame). Null for Classic. */
export async function buildSvgSheet(style: SheetStyle, grid: SheetReliefInput | null): Promise<SvgSheet | null> {
  if (style === 'classic') return null;
  const tokens = sheetTokens(style);
  if (!grid) return { tokens, relief: null };
  const rel = contourSheetRelief(grid);
  if (!rel.extent) return { tokens, relief: null };
  const e = rel.extent;
  const w = e.maxX - e.minX, h = e.maxY - e.minY;
  const k = SVG_RASTER_SIDE / Math.max(w, h);
  const raster = contourSheetRaster(grid, tokens, e, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  const png = await encodePng(raster.rgba, raster.width, raster.height);
  return {
    tokens,
    relief: { href: `data:image/png;base64,${base64(png)}`, extent: e, outline: rel.outline, hasHoles: rel.hasHoles, highest: rel.highest, lowest: rel.lowest },
  };
}
