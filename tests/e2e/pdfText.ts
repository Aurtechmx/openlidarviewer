/**
 * pdfText.ts: the text a PDF draws, one string operand per line.
 *
 * Embedded fonts write glyph ids, not characters, so each font's ToUnicode
 * map is read and the strings drawn in that font are decoded through it.
 * Standard fonts write their characters directly and are read as Latin-1.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

type CMap = Map<number, string>;

function streamText(s: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(s).decode()).toString('latin1');
}

function utf16(hex: string): string {
  return Buffer.from(hex, 'hex').swap16().toString('utf16le');
}

/** The code-to-text pairs of a ToUnicode CMap. */
function parseCMap(text: string): CMap {
  const map: CMap = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(p[1]!, 16), utf16(p[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1]!, 16), hi = parseInt(r[2]!, 16);
      if (r[3]!.startsWith('[')) {
        [...r[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((d, i) => map.set(lo + i, utf16(d[1]!)));
      } else {
        const base = utf16(r[3]!.slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + c - lo));
      }
    }
  }
  return map;
}

function decodeHex(hex: string, cmap: CMap | null): string {
  const h = hex.replace(/\s+/g, '');
  if (!cmap) return Buffer.from(h, 'hex').toString('latin1');
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) out += cmap.get(parseInt(h.slice(i, i + 4), 16)) ?? '';
  return out;
}

const OPS = /(\/[^\s/[\]()<>]+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;

/** Every string a page's content draws, decoded through the font it is drawn in. */
function pageStrings(content: string, fonts: Map<string, CMap | null>, out: string[]): void {
  let cmap: CMap | null = null;
  for (const m of content.matchAll(OPS)) {
    if (m[1] !== undefined) cmap = fonts.get(m[1]) ?? null;
    else if (m[2] !== undefined) out.push(decodeHex(m[2], cmap));
    else if (m[3] !== undefined) out.push(m[3]);
    else if (m[4] !== undefined) {
      out.push([...m[4].matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g)].map((s) => (s[1] !== undefined ? decodeHex(s[1], cmap) : s[2]!)).join(''));
    }
  }
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = new Map<string, CMap | null>();
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      const tu = font.lookup(PDFName.of('ToUnicode'));
      fonts.set(name.toString(), tu instanceof PDFRawStream ? parseCMap(streamText(tu)) : null);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((r) => doc.context.lookup(r as PDFRef))
      : [contents];
    const text = streams.filter((s): s is PDFRawStream => s instanceof PDFRawStream).map(streamText).join('\n');
    pageStrings(text, fonts, out);
  }
  return out.join('\n');
}
