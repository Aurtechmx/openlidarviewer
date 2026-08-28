/**
 * profileAxisFitActualWidth.test.ts — x labels fit the ACTUAL chart width.
 *
 * The profile chart's x-label overlay is built before it is in a document, so
 * the fit could not read the real chart width and used a conservative 180px
 * floor (`MIN_CHART_PX`). On a chart wider than 180px — the normal case, panels
 * run 218-760px — that floor dropped labels that would easily have fitted,
 * leaving sparse, uneven ticks (e.g. 0, 40, 80, 140 with 120 dropped).
 *
 * The fix keeps the position math in box-fraction percentages (already width-
 * correct) but recomputes the fit DECISION against the real width after mount.
 * `profileXLabelSpansHtml` is the pure helper that decision runs through, and
 * `profileXLabelFitWidth` is the floor the re-fit width passes through. These
 * cases pin both DOM-free.
 */

import { describe, it, expect } from 'vitest';
import {
  profileXLabelSpansHtml,
  profileXLabelFitWidth,
  type ProfileXLabelCandidate,
} from '../src/ui/MeasurePanel';

const AXIS_FONT_PX = 11;

/** Evenly spaced candidates 0..100%, ends pulled in, plain metre labels. */
function evenCandidates(n: number, stepM: number): ProfileXLabelCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    pct: (i / (n - 1)) * 100,
    text: `${i * stepM} m`,
    anchor: i === 0 ? '0' : i === n - 1 ? '-100%' : '-50%',
  }));
}

/** The label texts the helper actually rendered, in strip order. */
function keptTexts(html: string): string[] {
  return [...html.matchAll(/olv-mp-axis-x[^>]*>([^<]+)</g)].map((m) => m[1]);
}

describe('the x-label fit reasons against the real width, not the 180px floor', () => {
  it('a wider chart keeps MORE labels than the 180px floor, incl. an intermediate', () => {
    const cands = evenCandidates(7, 50); // 0..300 m in 50 m steps

    const atFloor = keptTexts(profileXLabelSpansHtml(cands, 180, '90', AXIS_FONT_PX));
    const atWide = keptTexts(profileXLabelSpansHtml(cands, 400, '90', AXIS_FONT_PX));

    // The wider fit keeps strictly more, and everything the floor kept.
    expect(atWide.length).toBeGreaterThan(atFloor.length);
    for (const t of atFloor) expect(atWide).toContain(t);

    // At least one INTERIOR label the floor dropped is recovered by the wider
    // fit — the "missing 120" the bug produced.
    const ends = new Set([cands[0].text, cands[cands.length - 1].text]);
    const recoveredInterior = atWide.filter((t) => !atFloor.includes(t) && !ends.has(t));
    expect(recoveredInterior.length).toBeGreaterThan(0);
  });

  it('keeps every label when the width has room for them all', () => {
    const cands = evenCandidates(6, 40); // 0..200 m
    const wide = keptTexts(profileXLabelSpansHtml(cands, 760, '90', AXIS_FONT_PX));
    expect(wide.length).toBe(6);
  });

  it('a narrow chart thins labels but always keeps both ends (no clipping)', () => {
    const cands = evenCandidates(7, 50);
    const narrow = keptTexts(profileXLabelSpansHtml(cands, 180, '90', AXIS_FONT_PX));
    expect(narrow).toContain('0 m'); // first, flush-left
    expect(narrow).toContain('300 m'); // last, flush-right, carries the extent
    expect(narrow.length).toBeLessThan(7);
  });

  it('positions are box-fraction percentages, so they hold at any width', () => {
    const cands = evenCandidates(3, 50);
    const html = profileXLabelSpansHtml(cands, 400, '88.00', AXIS_FONT_PX);
    // The same percentage appears regardless of the pixel width passed in.
    expect(html).toContain('left:0.00%');
    expect(html).toContain('left:100.00%');
    expect(html).toContain('top:88.00%');
  });
});

describe('profileXLabelFitWidth floors the re-fit at MIN_CHART_PX', () => {
  it('passes a real width through untouched', () => {
    expect(profileXLabelFitWidth(400)).toBe(400);
    expect(profileXLabelFitWidth(218)).toBe(218);
  });

  it('never fits against LESS than the 180px floor', () => {
    expect(profileXLabelFitWidth(120)).toBe(180);
    expect(profileXLabelFitWidth(0)).toBe(180); // never mounted / display:none
    expect(profileXLabelFitWidth(Number.NaN)).toBe(180);
    expect(profileXLabelFitWidth(-50)).toBe(180);
  });
});
