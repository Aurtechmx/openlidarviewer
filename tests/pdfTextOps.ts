/**
 * pdfTextOps.ts (test helper — not a suite)
 *
 * Decode every text-drawing operation out of a pdf-lib document so layout
 * tests can assert on REAL page positions instead of just "bytes exist".
 * pdf-lib Flate-compresses page content streams, so this loads the document
 * back, inflates each stream via `decodePDFRawStream`, and parses the
 * `BT … Tf … Tm … Tj … ET` blocks `drawText` emits (one block per call, text
 * hex-encoded in the font's WinAnsi bytes — identity for the ASCII range).
 */

import {
  PDFDocument,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';

/** One `drawText` call: page index, font size, and the baseline position. */
export interface PdfTextOp {
  readonly page: number;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** Extract every text op from a saved pdf-lib document, in draw order. */
export async function extractTextOps(bytes: Uint8Array): Promise<PdfTextOp[]> {
  const doc = await PDFDocument.load(bytes);
  const ops: PdfTextOp[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const contents = page.node.Contents();
    if (!contents) return;
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    let src = '';
    for (const s of streams) {
      if (s instanceof PDFRawStream) {
        src += Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') + '\n';
      }
    }
    for (const block of src.matchAll(/BT\n([^]*?)ET/g)) {
      const size = /\s(-?[\d.]+) Tf\n/.exec(block[1]);
      const tm = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\n/.exec(block[1]);
      const tj = /<([0-9A-Fa-f]*)> Tj/.exec(block[1]);
      if (!size || !tm || !tj) continue;
      const text = (tj[1].match(/../g) ?? [])
        .map((h) => String.fromCharCode(parseInt(h, 16)))
        .join('');
      ops.push({ page: pageIndex, size: Number(size[1]), x: Number(tm[5]), y: Number(tm[6]), text });
    }
  });
  return ops;
}
