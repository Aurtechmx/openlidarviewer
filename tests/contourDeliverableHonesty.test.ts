/**
 * contourDeliverableHonesty.test.ts — two ways a shipped contour deliverable
 * contradicted itself, both found by reading real exported files.
 *
 *   THE WORD. `interpolatedFraction` is the share of drawn length that is NOT
 *   solid, which is dashed (interpolated) AND gap (uncertain) together. The map
 *   sheet printed it as "interpolated" alone, three lines under a legend that
 *   draws those two as separate swatches. On a real sheet that read "100%
 *   interpolated" while 504 of the exported features carried
 *   `provenance: "measured"` and thirty solid contours were on the page.
 *
 *   THE ROUNDING. Plain rounding turned the fraction into a universal claim at
 *   both ends: 0.998 printed as "100%" on a sheet drawing solid contours, and
 *   0.004 rounded to 0%, which the caption then worded as "ALL contour length
 *   is from confident, measured terrain" while some of it was not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gradePercent, interpolatedCaption, tallySegments } from '../src/terrain/contour/evidenceGrade';
import type { ContourSegment } from '../src/terrain/contour/contoursAt';

/** A unit-length segment of the given grade. */
const seg = (grade: ContourSegment['grade'], n: number): ContourSegment[] =>
  Array.from({ length: n }, (_, i) => ({
    x1: 0, y1: i, x2: 1, y2: i, grade,
  } as ContourSegment));

describe('gradePercent', () => {
  it('reserves 0 and 100 for the exact cases', () => {
    expect(gradePercent(0)).toBe(0);
    expect(gradePercent(1)).toBe(100);
  });

  it('never rounds a mostly-interpolated set up to "all of it"', () => {
    // The shipped sheet's number. Math.round would say 100.
    expect(gradePercent(0.998)).toBe(99);
    expect(gradePercent(0.9999)).toBe(99);
  });

  it('never rounds a mostly-solid set down to "none of it"', () => {
    // The mirror case, and the worse one: it asserts full confidence.
    expect(gradePercent(0.004)).toBe(1);
    expect(gradePercent(0.0001)).toBe(1);
  });

  it('rounds ordinary values normally', () => {
    expect(gradePercent(0.34)).toBe(34);
    expect(gradePercent(0.5)).toBe(50);
  });

  it('passes NaN through rather than inventing a number', () => {
    expect(Number.isNaN(gradePercent(Number.NaN))).toBe(true);
  });
});

describe('interpolatedCaption', () => {
  it('claims all-measured only when nothing is dashed or gap', () => {
    expect(interpolatedCaption(tallySegments(seg('solid', 10))))
      .toBe('All contour length is from confident, measured terrain.');
  });

  it('does not claim all-measured when a sliver is not', () => {
    // 1 of 1000 is 0.1%, which rounds to zero. The old caption then told the
    // reader every metre was confident, measured terrain.
    const caption = interpolatedCaption(tallySegments([...seg('solid', 999), ...seg('gap', 1)]));
    expect(caption).not.toContain('All contour length');
    expect(caption).toContain('1%');
  });

  it('names BOTH grades it is counting', () => {
    const caption = interpolatedCaption(tallySegments([...seg('dashed', 1), ...seg('gap', 1)]));
    expect(caption).toContain('interpolated (dashed)');
    expect(caption).toContain('uncertain (gap)');
  });

  it('says so plainly when nothing was drawn', () => {
    expect(interpolatedCaption(tallySegments([]))).toBe('No contours drawn.');
  });
});

describe('the fraction counts gap as well as dashed', () => {
  it('is the non-solid share, not the dashed share', () => {
    // The sheet's real composition: about half gap, about half dashed, a
    // sliver solid. Reporting this as "interpolated" alone mislabels the half
    // that is gap, and the exported features say so themselves.
    const tally = tallySegments([...seg('gap', 831), ...seg('dashed', 820), ...seg('solid', 30)]);
    expect(tally.gap.count).toBe(831);
    expect(tally.dashed.count).toBe(820);
    expect(tally.solid.count).toBe(30);
    // Equal-length segments here, so the length share equals the count share.
    // The real sheet's 0.998 is length-weighted and differs; what both share is
    // that the number must not print as 100 while solid contours are drawn.
    expect(tally.interpolatedFraction).toBeCloseTo(1651 / 1681, 6);
    expect(gradePercent(tally.interpolatedFraction)).toBe(98);
    expect(gradePercent(tally.interpolatedFraction)).toBeLessThan(100);
  });
});

/**
 * Both contour export paths must tell provenance the vertical scale.
 *
 * The bundled deliverable passed it; the standalone GeoJSON/DXF/SVG button did
 * not. So one exported file carried `elevationUnit: "metre"` on all 1681
 * features and `zUnit: "m"` in its complexity block, while its own metadata
 * said `contourIntervalUnit: "unknown"` — the same axis, answered two ways,
 * because one of two sibling call sites omitted one option.
 *
 * A source assertion, deliberately: the divergence is between two call sites in
 * a DOM-bound panel, and what has to hold is that neither forgets the option.
 */
describe('every contour export path resolves the vertical unit', () => {
  it('passes verticalUnitToMetres wherever it builds contour provenance', () => {
    const src = readFileSync(new URL('../src/ui/AnalysePanel.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/buildExportProvenance\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      // The options object runs to the closing `});` of the call.
      const opts = src.slice(m.index!, src.indexOf('});', m.index!));
      expect(opts).toContain('verticalUnitToMetres');
    }
  });
});
