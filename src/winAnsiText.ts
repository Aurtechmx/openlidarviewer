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
