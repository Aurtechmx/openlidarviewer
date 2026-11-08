/**
 * pdfSpy.ts: records the text, vector paths and images drawn on pdf-lib pages
 * so report tests can check what a helper drew and where.
 */
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';

export interface SpyText { text: string; x: number; y: number; size: number; font: PDFFont; width: number; rotated: boolean; page: PDFPage }
export interface SpyPath { d: string; dash?: number[]; borderWidth?: number; borderColor?: unknown; color?: unknown; page: PDFPage }
export interface SpyImage { x: number; y: number; width: number; height: number; page: PDFPage }

export interface PdfSpy { texts: SpyText[]; paths: SpyPath[]; images: SpyImage[]; wrap(page: PDFPage): PDFPage }

export function spyPdf(doc?: PDFDocument): PdfSpy {
  const texts: SpyText[] = [];
  const paths: SpyPath[] = [];
  const images: SpyImage[] = [];
  const wrap = (page: PDFPage): PDFPage => {
    const dt = page.drawText.bind(page);
    page.drawText = ((text: string, o: { x: number; y: number; font: PDFFont; size: number; rotate?: unknown }) => {
      texts.push({ text, x: o.x, y: o.y, size: o.size, font: o.font, width: o.font.widthOfTextAtSize(text, o.size), rotated: o.rotate !== undefined, page });
      return dt(text, o as never);
    }) as typeof page.drawText;
    const ds = page.drawSvgPath.bind(page);
    page.drawSvgPath = ((d: string, o: { borderDashArray?: number[]; borderWidth?: number; borderColor?: unknown; color?: unknown }) => {
      paths.push({ d, dash: o.borderDashArray, borderWidth: o.borderWidth, borderColor: o.borderColor, color: o.color, page });
      return ds(d, o as never);
    }) as typeof page.drawSvgPath;
    const di = page.drawImage.bind(page);
    page.drawImage = ((img: never, o: { x: number; y: number; width: number; height: number }) => {
      images.push({ x: o.x, y: o.y, width: o.width, height: o.height, page });
      return di(img, o as never);
    }) as typeof page.drawImage;
    return page;
  };
  if (doc) {
    const add = doc.addPage.bind(doc);
    doc.addPage = ((...a: never[]) => wrap(add(...a))) as typeof doc.addPage;
  }
  return { texts, paths, images, wrap };
}
