/**
 * reportStyle.ts: the Light and Dark styles for the text reports (terrain
 * intelligence, space, Contour Studio deliverable).
 *
 * A report keeps its content and layout; a style changes its type to Figtree
 * and Courier, its colours to the style's tokens, and paints every page in the
 * style's paper. Classic is the report as before, byte for byte: the caller
 * gets null and embeds its standard fonts as it always did.
 */
import { rgb, type PDFDocument, type RGB } from 'pdf-lib';
import { embedSheetFonts, type SheetFonts } from './fonts';
import { drawPaper } from './primitives';
import { sheetTokens, type SheetRgb, type SheetStyle, type SheetTokens } from './tokens';

export interface StyledReport {
  readonly tokens: SheetTokens;
  readonly fonts: SheetFonts;
  /** A token colour as pdf-lib's RGB. */
  color(c: SheetRgb): RGB;
  /** A colour between two tokens, `k` of the way from `a` to `b`. */
  mix(a: SheetRgb, b: SheetRgb, k: number): RGB;
  /** Stop painting new pages. Call once drawing is done, before the save. */
  done(): void;
}

/**
 * Set up `doc` for a Light or Dark report: embed the sheet fonts and paint
 * every page added from now on in the style's paper. Null for Classic or no
 * style. Call before the first page is added.
 */
export async function startStyledReport(
  doc: PDFDocument,
  style: SheetStyle | null | undefined,
  loadFont?: (name: string) => Promise<Uint8Array>,
): Promise<StyledReport | null> {
  if (style !== 'light' && style !== 'dark') return null;
  const tokens = sheetTokens(style);
  const fonts = await embedSheetFonts(doc, loadFont);
  const addPage = doc.addPage.bind(doc);
  doc.addPage = ((...a: Parameters<PDFDocument['addPage']>) => {
    const page = addPage(...a);
    drawPaper(page, tokens);
    return page;
  }) as PDFDocument['addPage'];
  return {
    tokens,
    fonts,
    color: (c) => rgb(c[0], c[1], c[2]),
    mix: (a, b, k) => rgb(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k),
    done: () => { doc.addPage = addPage; },
  };
}
