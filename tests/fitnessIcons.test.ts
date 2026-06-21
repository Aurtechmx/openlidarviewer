/**
 * fitnessIcons.test.ts — the scorecard icon set stays in the house style and the
 * tone glyphs are shape-distinct (not colour-only), per the design-council
 * accessibility fix.
 */

import { describe, it, expect } from 'vitest';
import { fitnessIcon, fitnessToneGlyph } from '../src/ui/fitnessIcons';
import type { FitnessKey, FitnessTone } from '../src/terrain/quality/scanFitness';

const KEYS: FitnessKey[] = ['georeferencing', 'coverage', 'density', 'accuracy', 'classification', 'integrity'];
const TONES: FitnessTone[] = ['ready', 'okay', 'review'];

describe('fitnessIcons — house style', () => {
  it('every dimension icon is a 24×24 currentColor line glyph', () => {
    for (const k of KEYS) {
      const s = fitnessIcon(k);
      expect(s, k).toMatch(/^<svg viewBox="0 0 24 24"/);
      expect(s, k).toContain('stroke="currentColor"');
      expect(s.trim(), k).toMatch(/<\/svg>$/);
    }
  });

  it('every dimension has a distinct icon', () => {
    const set = new Set(KEYS.map(fitnessIcon));
    expect(set.size).toBe(KEYS.length);
  });
});

describe('fitnessIcons — tone glyphs are shape-distinct, not colour-only', () => {
  it('each tone has its own glyph in the house style', () => {
    const glyphs = TONES.map(fitnessToneGlyph);
    for (const g of glyphs) expect(g).toMatch(/^<svg viewBox="0 0 24 24"/);
    expect(new Set(glyphs).size).toBe(TONES.length); // all three differ in shape
  });

  it('ready is a check, review is a triangle (recognisable distinct marks)', () => {
    // Check = a single open polyline; triangle = a closed 3-point path + a dot.
    expect(fitnessToneGlyph('ready')).toContain('<path d="M5 12.5l4.5 4.5L19 7"');
    expect(fitnessToneGlyph('review')).toMatch(/Z|21 19\.5H3z/); // closed triangle
    expect(fitnessToneGlyph('okay')).toContain('M6 12h12'); // neutral dash
  });
});
