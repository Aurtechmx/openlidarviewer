/**
 * svgRaster.ts: a contour SVG sheet drawn to a PNG in the browser, and text
 * chunks written into a PNG so the image carries its provenance.
 *
 * `rasterizeSvg` needs a DOM (an image element and a canvas); `withPngText`
 * is pure.
 */
import { pngChunk } from './png';
import { provenanceLines, type ExportProvenance } from '../../terrain/export/exportProvenance';

/** Read the width and height an SVG declares on its root element. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const m = /<svg\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Draw `svg` at `scale` times its own size and return PNG bytes. The SVG is
 * loaded as an image from a blob URL; images it embeds as data URLs draw,
 * and nothing is fetched from elsewhere.
 */
export async function rasterizeSvg(svg: string, scale: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const size = svgSize(svg);
  if (!size) throw new Error('The SVG declares no size to draw it at.');
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The contour sheet could not be drawn as an image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas is available to draw the contour sheet.');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The contour sheet could not be encoded as PNG.');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * `png` with tEXt chunks for `entries` inserted after IHDR. Keywords and text
 * are Latin-1 by the PNG specification; other characters are replaced with
 * '?'. Throws on bytes that are not a PNG.
 */
export function withPngText(png: Uint8Array, entries: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || SIG.some((b, i) => png[i] !== b)) throw new Error('Not a PNG.');
  const ihdrEnd = 8 + 12 + 13;
  const latin1 = (s: string): number[] => [...s].map((ch) => { const c = ch.codePointAt(0)!; return c < 256 ? c : 63; });
  const chunks = entries.map(([k, v]) => {
    const key = latin1(k).slice(0, 79);
    return pngChunk('tEXt', Uint8Array.from([...key, 0, ...latin1(v)]));
  });
  const total = png.length + chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  out.set(png.subarray(0, ihdrEnd), 0);
  let o = ihdrEnd;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  out.set(png.subarray(ihdrEnd), o);
  return out;
}

/**
 * The contour map PNG: the contour SVG sheet `svg` drawn at twice its own
 * size. A PNG carries no SVG metadata, so the export provenance (permit
 * included) goes into its text chunks.
 */
export async function contourMapPng(
  svg: { readonly filename: string; readonly content: string },
  provenance: ExportProvenance,
  basename: string,
  version: string,
): Promise<{ blob: Blob; filename: string }> {
  const png = await rasterizeSvg(svg.content, 2);
  const bytes = withPngText(png.bytes, [
    ['Software', `OpenLiDARViewer ${version}`],
    ['Title', `${basename} contour map`],
    ['Description', provenanceLines(provenance).join('\n')],
  ]);
  return { blob: new Blob([bytes as BlobPart], { type: 'image/png' }), filename: svg.filename.replace(/\.svg$/, '.png') };
}
