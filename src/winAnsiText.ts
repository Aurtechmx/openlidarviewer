/**
 * winAnsiText.ts
 *
 * pdf-lib's StandardFonts encode WinAnsi (CP1252) and throw on any character
 * outside it, so every string drawn into a PDF is transliterated first. Five
 * sheet builders each carried their own copy of that table, and the copies had
 * drifted: a report warning quoting the "≥4 pts/m² reliability threshold"
 * printed "?4 pts/m²", because no copy mapped the symbol.
 *
 * The table lives here so a glyph fixed once is fixed on every sheet. It covers
 * the mathematical, arrow and typographic symbols the analysis text actually
 * uses; anything still unmapped becomes '?', which keeps the sheet rendering
 * and leaves the substitution visible.
 *
 * Latin-1 characters (accents, ², ³, °, ±, µ, ·) are already WinAnsi and pass
 * through untouched; they never reach the table.
 */

/** Non-WinAnsi characters that appear in drawn text, and their ASCII stand-ins. */
export const WIN_ANSI_TRANSLITERATIONS: Readonly<Record<string, string>> = {
  // Comparison and arithmetic.
  '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '−': '-', '√': 'sqrt', '∞': 'inf',
  '∂': 'd', '∈': ' in ', '∑': 'sum', 'Σ': 'sum', 'Δ': 'd', '⁻': '-', 'ⁿ': 'n', 'ᵀ': 'T',
  // Greek used in formulas and axis labels.
  'α': 'alpha', 'ε': 'eps', 'θ': 'theta', 'π': 'pi', 'σ': 'sigma', 'τ': 'tau', 'φ': 'phi',
  // Arrows.
  '→': '->', '←': '<-', '↔': '<->', '⇄': '<->', '⇒': '=>',
  // Marks and separators.
  '✓': '[OK]', '✗': '[X]', '✕': '[X]', '⚠': '[!]', '●': '*', '▾': 'v', '─': '-',
  '×': 'x', '—': '-', '–': '-', '•': '-', '…': '...', '’': "'", '‘': "'",
  '“': '"', '”': '"', '⌘': 'Cmd',
};

/**
 * Return `s` with every character pdf-lib's StandardFonts cannot encode
 * replaced: a known symbol by its ASCII stand-in, anything else by '?'.
 */
export function winAnsiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => WIN_ANSI_TRANSLITERATIONS[ch] ?? '?');
}

/**
 * The most characters of one FILE-DERIVED free-text field a PDF sheet prints:
 * a declared source-metadata value, or a value a sheet copies from the input
 * file. Text the user typed (notes, titles, names) is the user's own content
 * and is never capped, and neither is anything {@link mayCapField} protects
 * (a CRS definition, a digest, a unit). 8,000 characters is about 85 wrapped
 * lines, a page and a half of body text, far longer than a real declared value
 * (declared E57 values are typically a few dozen characters). The cap exists
 * for hostile or corrupt files: an E57 that declares a megabyte in one field
 * would otherwise add hundreds of pages to a report.
 */
export const PDF_FIELD_CHAR_CAP = 8_000;

/** A field cut to {@link PDF_FIELD_CHAR_CAP}, with the count of characters left out. */
export interface CappedText {
  readonly text: string;
  readonly omitted: number;
}

/**
 * Cut `s` to at most `cap` characters, never splitting a surrogate pair. Runs
 * of whitespace are collapsed to one space first, and the collapsed text is
 * what is kept and counted, so pretty-printing indentation never uses up the
 * cap (wrapping collapses it anyway).
 */
export function capFieldText(s: string, cap: number = PDF_FIELD_CHAR_CAP): CappedText {
  const text = s.replace(/\s+/g, ' ').trim();
  if (text.length <= cap) return { text, omitted: 0 };
  let end = cap;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), omitted: text.length - end };
}

/**
 * Whether a field may be capped, judged by its label. A field that carries a
 * coordinate reference definition, a digest or hash, an identifier or a unit
 * is printed whole however long it is: a cut WKT or SHA-256 is a wrong value,
 * not a shortened one.
 */
export function mayCapField(label: string): boolean {
  return !/coordinate|crs|wkt|srs|epsg|datum|projection|digest|sha|hash|guid|unit/i.test(label);
}

/**
 * Split text into the paragraphs a PDF sheet draws: a line break in the source
 * (LF, CR LF, CR, or a Unicode line or paragraph separator) starts a new line,
 * and every other run of whitespace, tabs included, becomes one space. Blank
 * lines inside the text are kept as empty paragraphs; text that is only
 * whitespace gives none. Without this, the WinAnsi fallback turned each line
 * break and tab into '?'.
 */
export function pdfParagraphs(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed.split(/\r\n|[\r\n\u2028\u2029]/).map((p) => p.replace(/\s+/g, ' ').trim());
}

/** The line printed in place of the characters {@link capFieldText} left out. */
export function omissionMarker(omitted: number): string {
  return `[… ${omitted.toLocaleString('en-US')} characters omitted from this PDF]`;
}

/**
 * Break `text` into lines no wider than `maxWidth` as measured by `measure`.
 * Breaks at whitespace; a word wider than the line on its own is hard-broken
 * character by character, so every line fits and the loop always ends. The
 * caller passes text that is already WinAnsi-safe, so the measured string is
 * the drawn string. Returns no lines for blank input.
 */
export function wrapToWidth(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (measure(word) <= maxWidth) {
      line = word;
    } else {
      let chunk = '';
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * `text` shortened to fit `maxWidth` with `suffix` appended, marking the cut
 * with an ellipsis. Used for the one-line "<label> (continued)" repeat at the
 * top of a page, which must never itself wrap.
 */
export function clipWithSuffix(
  text: string,
  suffix: string,
  measure: (s: string) => number,
  maxWidth: number,
): string {
  const whole = `${text}${suffix}`;
  if (measure(whole) <= maxWidth) return whole;
  // Binary search for the longest prefix that fits: the label can be a capped
  // 8,000-character field, and trimming one character at a time is quadratic.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}...${suffix}`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}...${suffix}`;
}
