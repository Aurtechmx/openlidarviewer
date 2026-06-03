/**
 * snapshotSvg.ts
 *
 * Helpers for the screenshot-export compositor (design §6.7): assemble a
 * standalone, self-styled SVG document from a live overlay's markup, and
 * rasterise it to an image ready to draw onto a canvas.
 *
 * The live overlays style their markers with CSS classes defined in the app
 * stylesheet. A serialised SVG rasterised on its own — drawn into a 2-D canvas
 * for the PNG export — has no access to that external stylesheet, so a snapshot
 * SVG must carry its own `<style>`. Each overlay owns the CSS for its snapshot;
 * these helpers just assemble and rasterise the document.
 *
 * Browser-bound (`Blob` / `URL` / `Image`); not imported in Node tests.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Assemble a standalone SVG document string: a sized root carrying an embedded
 * `<style>` block and the given inner markup. `width`/`height` are in CSS
 * pixels — the same units the overlays project into — and the compositor
 * scales the rasterised result up to the export resolution.
 */
export function standaloneSvg(
  inner: string,
  width: number,
  height: number,
  css: string,
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return (
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<style>${css}</style>${inner}</svg>`
  );
}

/**
 * Parse an SVG element's `viewBox` into `[width, height]` in CSS pixels,
 * falling back to `[0, 0]` when it is missing or malformed.
 */
export function viewBoxSize(element: SVGSVGElement): [number, number] {
  const parts = (element.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
  const w = parts.length === 4 && Number.isFinite(parts[2]) ? parts[2] : 0;
  const h = parts.length === 4 && Number.isFinite(parts[3]) ? parts[3] : 0;
  return [w, h];
}

/**
 * Rasterise a standalone SVG string to a decoded `HTMLImageElement`, ready to
 * `drawImage` onto a canvas. Resolves `null` if the SVG fails to decode, so a
 * single bad overlay never aborts the whole export.
 *
 * The SVG is self-contained (inline `<style>`, no external refs), so an image
 * decoded from it does not taint the destination canvas — `toBlob` still works.
 */
export async function loadSvgImage(svg: string): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    // Safe once `decode()` has settled — the bitmap is retained in memory.
    URL.revokeObjectURL(url);
  }
}
