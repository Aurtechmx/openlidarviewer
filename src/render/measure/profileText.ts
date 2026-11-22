/**
 * profileText.ts: text fitting for the profile sheet set, against the font's
 * real metrics and WinAnsi-safe first, as the Classic faces need.
 */
import type { PDFFont } from 'pdf-lib';
import { winAnsiSafe } from '../../winAnsiText';

/** Greedy word wrap against the font's real metrics. WinAnsi-safe first. */
export function wrapText(s: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = winAnsiSafe(s).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line === '' ? w : `${line} ${w}`;
    if (line === '' || font.widthOfTextAtSize(next, size) <= maxW) {
      line = next;
    } else {
      out.push(line);
      line = w;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** Trim to fit `maxW`, marking the trim so a truncated id never reads whole. */
export function clipText(s: string, font: PDFFont, size: number, maxW: number): string {
  const safe = winAnsiSafe(s);
  if (font.widthOfTextAtSize(safe, size) <= maxW) return safe;
  let cut = safe;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > maxW) {
    cut = cut.slice(0, -1);
  }
  return `${cut}...`;
}
