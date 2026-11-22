/**
 * reportStyle.ts: the Light and Dark styles for the text reports (terrain
 * intelligence, space, Contour Studio deliverable).
 *
 * A report keeps its content and layout; a style changes its type to Figtree
 * and Courier, its colours to the style's tokens, and paints every page in the
 * style's paper. Classic is the report as before, byte for byte: the caller
 * gets null and embeds its standard fonts as it always did.
 */
import { StandardFonts, rgb, type PDFDocument, type PDFFont, type RGB } from 'pdf-lib';
import { pdfInfoDate } from '../../pdfInfoDate';
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

/** What a report draws with: the style, or null for Classic, and its two faces. */
export interface OpenedReport {
  readonly kit: StyledReport | null;
  readonly font: PDFFont;
  readonly bold: PDFFont;
}

/**
 * Stamp a report's Info dictionary and pick its faces. The title is announced
 * in the viewer's title bar (ViewerPreferences DisplayDocTitle) and the
 * language is tagged, the supported accessibility hooks of this PDF library.
 * CreationDate and ModDate come from `date`, or the epoch when the report
 * prints none, so two builds of the same input are byte-identical (see
 * src/pdfInfoDate.ts). Light and Dark take the sheet fonts; Classic embeds
 * Helvetica as before.
 */
export async function openReport(
  doc: PDFDocument,
  title: string,
  date: Parameters<typeof pdfInfoDate>[0],
  render: { readonly style?: SheetStyle | null; readonly loadFont?: (name: string) => Promise<Uint8Array> },
): Promise<OpenedReport> {
  doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setLanguage('en-US');
  doc.setAuthor('OpenLiDARViewer');
  const infoStamp = pdfInfoDate(date);
  doc.setCreationDate(infoStamp);
  doc.setModificationDate(infoStamp);
  const kit = await startStyledReport(doc, render.style, render.loadFont);
  const font = kit ? kit.fonts.sans : await doc.embedFont(StandardFonts.Helvetica);
  const bold = kit ? kit.fonts.sansBold : await doc.embedFont(StandardFonts.HelveticaBold);
  return { kit, font, bold };
}
