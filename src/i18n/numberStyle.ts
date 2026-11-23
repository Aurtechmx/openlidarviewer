/**
 * numberStyle.ts: how numbers are written in a human-readable export.
 *
 * Two styles, chosen apart from the language:
 *   point  1,234.56   Mexico, the United States, the United Kingdom
 *   comma  1 234,56   Spain, Brazil, France, Germany, SI
 *
 * Nothing here reads the host locale, so an export is the same on every
 * machine. Grouping uses a comma or U+00A0 (never U+202F, which WinAnsi and
 * the sheet fonts lack). Machine-readable outputs (CSV, JSON, GeoJSON, KML
 * coordinates, GeoTIFF tags, world files) never use these helpers: they
 * always write a point and no grouping.
 */
export type NumberStyle = 'point' | 'comma';

export const NUMBER_STYLES: ReadonlyArray<{ readonly id: NumberStyle; readonly sample: string }> = [
  { id: 'point', sample: '1,234.5' },
  { id: 'comma', sample: '1 234,5' },
];

const NBSP = ' ';

/** Narrow an arbitrary value to a number style, `point` otherwise. */
export function asNumberStyle(v: unknown): NumberStyle {
  return v === 'comma' ? 'comma' : 'point';
}

/**
 * Swap the decimal mark of a number already written with a point, such as the
 * output of `toFixed` or a magnitude helper. Only digits around a point change;
 * text around the number is left as it is.
 */
export function withDecimalMark(style: NumberStyle, s: string): string {
  return style === 'comma' ? s.replace(/(\d)\.(\d)/g, '$1,$2') : s;
}

/** `value.toFixed(digits)` in the given style, without grouping. */
export function fixed(style: NumberStyle, value: number, digits: number): string {
  return withDecimalMark(style, value.toFixed(digits));
}

/** A whole number with thousands grouping: `357,192` or `357 192`. */
export function grouped(style: NumberStyle, value: number): string {
  const n = Math.round(value);
  const digits = Math.abs(n).toString();
  const sep = style === 'comma' ? NBSP : ',';
  const body = digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return (n < 0 ? '-' : '') + body;
}
