/**
 * paletteContrast.ts — read interface-palette tokens from a stylesheet and
 * compute WCAG 2.x contrast ratios between them.
 */

/** The body of the first `selector {` block in a stylesheet. */
export function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`block ${selector} not found`);
  return css.slice(start, css.indexOf('\n}', start));
}

/** The 6-digit hex value a block declares for a token, or null. */
export function hexIn(body: string, token: string): string | null {
  return new RegExp(`(?:^|[\\s;{])${token}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(body)?.[1] ?? null;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
