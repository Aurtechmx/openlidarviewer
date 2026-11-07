/**
 * reportFonts.ts: embeds the watershed report's four typefaces.
 *
 * Newsreader (titles) and Figtree (body) are static TrueType instances kept in
 * ./fonts, licensed under the SIL Open Font License 1.1 (see
 * docs/project/THIRD_PARTY_NOTICES.md for provenance and checksums). Each is
 * embedded as a subset, so the PDF carries only the glyphs it draws.
 *
 * This module and @pdf-lib/fontkit belong to the report's lazy chunk. Nothing
 * in the startup path may import it. Tests pass their own `load` that reads the
 * files from disk; the browser default fetches the bundled asset URLs.
 */
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';
import type { PDFDocument, PDFFont } from 'pdf-lib';

export interface ReportFonts {
  readonly title: PDFFont;
  readonly titleBold: PDFFont;
  readonly body: PDFFont;
  readonly bodyBold: PDFFont;
  /**
   * Standard Symbol font for the few characters none of the four families has.
   * The renderer draws exactly the characters in SYMBOL_ONLY_CHARS with it.
   */
  readonly symbol: PDFFont;
}

/** Characters absent from Newsreader and Figtree (√, π, Σ); draw them with `ReportFonts.symbol`. */
export const SYMBOL_ONLY_CHARS: readonly string[] = ['\u221A', '\u03C0', '\u03A3'];

/** Paths, relative to ./fonts, that `load` is asked for. */
export const REPORT_FONT_FILES = [
  'newsreader/Newsreader-Regular.ttf',
  'newsreader/Newsreader-Bold.ttf',
  'figtree/Figtree-Regular.ttf',
  'figtree/Figtree-Bold.ttf',
] as const;

type ReportFontFile = (typeof REPORT_FONT_FILES)[number];

/** Literal `new URL(...)` forms are what let the bundler emit each file as an asset. */
const FONT_URLS: Readonly<Record<ReportFontFile, URL>> = {
  'newsreader/Newsreader-Regular.ttf': new URL('./fonts/newsreader/Newsreader-Regular.ttf', import.meta.url),
  'newsreader/Newsreader-Bold.ttf': new URL('./fonts/newsreader/Newsreader-Bold.ttf', import.meta.url),
  'figtree/Figtree-Regular.ttf': new URL('./fonts/figtree/Figtree-Regular.ttf', import.meta.url),
  'figtree/Figtree-Bold.ttf': new URL('./fonts/figtree/Figtree-Bold.ttf', import.meta.url),
};

async function fetchFont(name: string): Promise<Uint8Array> {
  const url = FONT_URLS[name as ReportFontFile];
  if (!url) throw new Error(`Unknown report font file: ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load report font ${name} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function embedReportFonts(
  doc: PDFDocument,
  load: (name: string) => Promise<Uint8Array> = fetchFont,
): Promise<ReportFonts> {
  doc.registerFontkit(fontkit);
  const [regular, bold, bodyRegular, bodyBold] = await Promise.all(REPORT_FONT_FILES.map((f) => load(f)));
  // Sequential embeds keep object numbering, and so the saved bytes, deterministic.
  // A fixed name stops pdf-lib appending a random suffix, which would break byte-identical output.
  // Tabular figures, so numbers line up in tables and KPI rows.
  const embed = (bytes: Uint8Array, customName: string) => doc.embedFont(bytes, { subset: true, customName, features: { tnum: true } });
  const title = await embed(regular, 'Newsreader-Regular');
  const titleBold = await embed(bold, 'Newsreader-Bold');
  const body = await embed(bodyRegular, 'Figtree-Regular');
  const bodyBoldFont = await embed(bodyBold, 'Figtree-Bold');
  const symbol = await doc.embedFont(StandardFonts.Symbol);
  return { title, titleBold, body, bodyBold: bodyBoldFont, symbol };
}
