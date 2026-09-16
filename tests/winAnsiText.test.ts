/**
 * winAnsiText.test.ts
 *
 * Every string drawn into a PDF passes through one transliteration table. The
 * symbol that prompted it is the density caveat: a terrain report quoting the
 * "≥4 pts/m² reliability threshold" printed "?4 pts/m²" on the sheet, because
 * none of the five per-sheet copies of the table mapped the symbol.
 *
 * These cases hold the table to what the sheets need: the symbols the analysis
 * text uses read as text, Latin-1 passes through because WinAnsi already has
 * it, and anything genuinely unknown still becomes a visible '?'.
 */
import { describe, it, expect } from 'vitest';
import { winAnsiSafe, WIN_ANSI_TRANSLITERATIONS } from '../src/winAnsiText';

describe('WinAnsi transliteration', () => {
  it('writes the density caveat as text, not as a question mark', () => {
    const caveat = 'point density 1.3 pts/m² is below the ≥4 pts/m² reliability threshold';
    const out = winAnsiSafe(caveat);
    expect(out).toContain('>=4 pts/m²');
    expect(out).not.toContain('?');
  });

  it('keeps Latin-1 untouched, since WinAnsi encodes it', () => {
    expect(winAnsiSafe('Münzinger 1.2 m² · 45° ± 0.3 µm')).toBe('Münzinger 1.2 m² · 45° ± 0.3 µm');
  });

  it('maps the comparison, arrow and Greek symbols the analysis text uses', () => {
    expect(winAnsiSafe('≤')).toBe('<=');
    expect(winAnsiSafe('≠')).toBe('!=');
    expect(winAnsiSafe('√2')).toBe('sqrt2');
    expect(winAnsiSafe('a → b')).toBe('a -> b');
    expect(winAnsiSafe('σ')).toBe('sigma');
  });

  it('leaves an unknown glyph visible as a question mark', () => {
    expect(winAnsiSafe('姿')).toBe('?');
    expect(winAnsiSafe('🙂')).toBe('??'); // one astral pair, two replacements
  });

  it('every stand-in is itself encodable, or the sheet would still throw', () => {
    for (const [ch, ascii] of Object.entries(WIN_ANSI_TRANSLITERATIONS)) {
      expect(winAnsiSafe(ascii), ch).toBe(ascii);
    }
  });
});
