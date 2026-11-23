/**
 * fonts.ts: the typefaces the export sheets embed.
 *
 * Newsreader (titles) and Figtree (labels and body) are static TrueType
 * instances kept in ./fonts, licensed under the SIL Open Font License 1.1 (see
 * docs/project/THIRD_PARTY_NOTICES.md for provenance and checksums). Each is
 * embedded as a subset, so the PDF carries only the glyphs it draws. Figures
 * are set in Figtree with tabular numerals, so they align in columns; Courier
 * stands in only when Figtree could not load.
 *
 * This module and @pdf-lib/fontkit belong to the export chunks. Nothing in the
 * startup path may import it. Tests pass their own `load` that reads the files
 * from disk; the browser default fetches the bundled asset URLs.
 */
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { winAnsiSafe } from '../../winAnsiText';

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
export const SYMBOL_ONLY_CHARS: readonly string[] = ['√', 'π', 'Σ'];

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

/** The fonts a map or profile sheet draws with. */
export interface SheetFonts {
  /** Labels, headings and notes: Figtree, or Helvetica when Figtree could not load. */
  readonly sans: PDFFont;
  readonly sansBold: PDFFont;
  /** Figures in data blocks, scale and coordinate ticks: Figtree with tabular numerals, or Courier in the fallback. */
  readonly mono: PDFFont;
  readonly monoBold: PDFFont;
  /** True when Figtree could not be loaded and Helvetica stands in. */
  readonly fallback: boolean;
}

/** Paths, relative to ./fonts, that `embedSheetFonts` asks `load` for. */
export const SHEET_FONT_FILES = ['figtree/Figtree-Regular.ttf', 'figtree/Figtree-Bold.ttf'] as const;

/**
 * Embed the sheet fonts. Figtree is loaded through `load`; if that fails (an
 * offline copy without the font files, a blocked fetch) the sheet falls back
 * to Helvetica rather than failing the export, and `fallback` says so.
 */
export async function embedSheetFonts(
  doc: PDFDocument,
  load: (name: string) => Promise<Uint8Array> = fetchFont,
): Promise<SheetFonts> {
  let bytes: Uint8Array[] | null = null;
  try {
    bytes = await Promise.all(SHEET_FONT_FILES.map((f) => load(f)));
  } catch {
    bytes = null;
  }
  // Embed order is fixed so object numbering, and so the saved bytes, stay deterministic.
  let sans: PDFFont, sansBold: PDFFont;
  if (bytes) {
    doc.registerFontkit(fontkit);
    const embed = (b: Uint8Array, customName: string) => doc.embedFont(b, { subset: true, customName, features: { tnum: true } });
    sans = await embed(bytes[0]!, 'Figtree-Regular');
    sansBold = await embed(bytes[1]!, 'Figtree-Bold');
  } else {
    sans = await doc.embedFont(StandardFonts.Helvetica);
    sansBold = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  if (bytes) return { sans, sansBold, mono: sans, monoBold: sansBold, fallback: false };
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);
  return { sans, sansBold, mono, monoBold, fallback: true };
}

/** A negative figure, alone or with a unit. */
const FIGURE = /^-\d[\d.,\u00a0]*( ?(%|m|ft|°))?$/;

const CHARSETS = new WeakMap<PDFFont, Set<number>>();

/**
 * `s` made drawable in `font`. The standard fonts (Courier, and Helvetica when
 * Figtree did not load) encode WinAnsi only, so other characters are replaced
 * with their ASCII stand-ins. Characters Figtree lacks are replaced with '?'
 * instead of failing the export.
 */
export function drawableText(s: string, font: PDFFont, fonts: SheetFonts): string {
  if (fonts.fallback) return winAnsiSafe(s);
  // A figure's sign is a minus, not a hyphen. Only a string that is nothing but
  // a figure and its unit is touched, so names and dates print as given.
  if (FIGURE.test(s)) s = s.replace('-', '−');
  let supported = CHARSETS.get(font);
  if (!supported) {
    supported = new Set(font.getCharacterSet());
    CHARSETS.set(font, supported);
  }
  let out = '';
  for (const ch of s) {
    if (supported.has(ch.codePointAt(0)!)) { out += ch; continue; }
    // A known stand-in (an en dash for a minus, say) when Figtree has it, else one '?'.
    const alt = winAnsiSafe(ch);
    out += alt !== '?' && [...alt].every((c) => supported.has(c.codePointAt(0)!)) && !alt.includes('?') ? alt : '?';
  }
  return out;
}
