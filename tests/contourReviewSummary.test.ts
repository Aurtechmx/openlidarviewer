/**
 * contourReviewSummary.test.ts
 *
 * The review-bar model (spec §7.1/§22.5): recommendations surfaced from the
 * analysis result with rationale, the unit-safe interval row, and the evidence
 * row tied to the launch state.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContourReviewSummary,
  type ContourReviewInput,
} from '../src/terrain/contourStudio/contourReviewSummary';
import { baseContourStudioState } from '../src/terrain/contourStudio/contourStudioState';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type { ContourStudioLaunchState } from '../src/terrain/contourStudio/contourStudioLaunchState';
import { knownUnit, unknownUnit } from '../src/units/units';

function resultStub(over: {
  measured?: number; interpolated?: number; empty?: number; total?: number;
  lowConfidence?: number; edgeRisk?: number; groundIsDerived?: boolean;
  cellSizeM?: number; contourIntervalM?: number; recommendedM?: number | null;
  reasons?: string[]; rmse?: number; gateWarnings?: string[];
}): AnalyseContoursResult {
  return {
    cellStatusTally: {
      measured: over.measured ?? 800, interpolated: over.interpolated ?? 150,
      empty: over.empty ?? 50,
      lowConfidence: over.lowConfidence ?? 0, edgeRisk: over.edgeRisk ?? 0,
      total: over.total ?? 1000,
    },
    gridRecommendation: {
      cellSizeM: over.cellSizeM ?? 0.25,
      contourIntervalM: over.contourIntervalM ?? 0.5,
      cellOptionsM: [0.1, 0.25, 0.5],
      pointSpacingM: 0.2,
      reasons: over.reasons ?? ['Recommended from median ground spacing and memory budget.'],
    },
    gate: { options: [], recommendedM: 'recommendedM' in over ? (over.recommendedM ?? null) : 0.5, warnings: over.gateWarnings ?? [] },
    validation: { rmse: over.rmse ?? 0.09 },
  } as unknown as AnalyseContoursResult;
}

const AVAILABLE: ContourStudioLaunchState = {
  status: 'available', title: 't', message: 'm', visible: true, actionEnabled: true, actionLabel: 'Create Contour Deliverable',
};
const EXPLORATORY: ContourStudioLaunchState = {
  status: 'exploratory', title: 't', message: 'm', reasons: ['Vertical units are unknown; metric-supported contour intervals cannot be claimed.'],
  visible: true, actionEnabled: true, actionLabel: 'Create Exploratory Contours',
};

const metreInput = (launch: ContourStudioLaunchState): ContourReviewInput => ({
  launch, state: baseContourStudioState(), verticalUnit: knownUnit(1), sourceUnitLabel: 'm', crsProjected: true,
});

describe('buildContourReviewSummary', () => {
  it('produces the seven review rows in order', () => {
    const s = buildContourReviewSummary(resultStub({}), metreInput(AVAILABLE));
    expect(s.rows.map((r) => r.key)).toEqual([
      'source', 'grid', 'interval', 'support', 'validation', 'output', 'evidence',
    ]);
  });

  it('surfaces the grid recommendation with its engine rationale', () => {
    const s = buildContourReviewSummary(resultStub({ cellSizeM: 0.25, reasons: ['spacing rationale'] }), metreInput(AVAILABLE));
    const grid = s.rows.find((r) => r.key === 'grid')!;
    expect(grid.value).toContain('0.25 m');
    expect(grid.rationale).toContain('spacing rationale');
  });

  it('interval row is metric-supported on a projected metre CRS', () => {
    const s = buildContourReviewSummary(resultStub({ recommendedM: 0.5 }), metreInput(AVAILABLE));
    const interval = s.rows.find((r) => r.key === 'interval')!;
    expect(interval.value).toContain('0.5 m');
    expect(interval.value).toContain('supported (internal)');
  });

  it('interval row is cartographic-only when the vertical unit is unknown', () => {
    const input: ContourReviewInput = { ...metreInput(EXPLORATORY), verticalUnit: unknownUnit(), sourceUnitLabel: 'm' };
    const s = buildContourReviewSummary(resultStub({ recommendedM: 0.5 }), input);
    const interval = s.rows.find((r) => r.key === 'interval')!;
    expect(interval.value).toContain('cartographic-only');
    expect(interval.value).not.toMatch(/\bm\b/); // no fabricated metre unit
  });

  it('interval row is cartographic-only when the gate refused but the grid suggests a metre interval', () => {
    // Regression: gate.recommendedM null (interval gate refused any metric
    // interval) but grid.contourIntervalM is a valid 0.5 m fallback on a
    // projected metre CRS with a known unit. The review must not label the
    // grid fallback "supported (internal)" — support the gate refused cannot
    // be reasserted from a geometry-only suggestion.
    const s = buildContourReviewSummary(
      resultStub({ recommendedM: null, contourIntervalM: 0.5 }),
      metreInput(AVAILABLE),
    );
    const interval = s.rows.find((r) => r.key === 'interval')!;
    expect(interval.value).toContain('0.5 m');
    expect(interval.value).toContain('cartographic-only');
    expect(interval.value).not.toContain('supported (internal)');
    expect(interval.confidence).toBe('medium');
  });

  it('interval row reports none when nothing is supportable', () => {
    const s = buildContourReviewSummary(resultStub({ recommendedM: null, contourIntervalM: 0, gateWarnings: ['relief too low'] }), metreInput(EXPLORATORY));
    const interval = s.rows.find((r) => r.key === 'interval')!;
    expect(interval.value).toBe('none supportable');
    expect(interval.rationale).toContain('relief too low');
  });

  it('support row reports every cell bucket', () => {
    const s = buildContourReviewSummary(resultStub({ measured: 700, interpolated: 200, empty: 100, total: 1000 }), metreInput(AVAILABLE));
    const support = s.rows.find((r) => r.key === 'support')!;
    expect(support.value).toBe('70% measured · 20% interpolated · 0% low confidence · 0% edge risk · 10% void');
  });

  it('evidence row reflects the launch state', () => {
    const avail = buildContourReviewSummary(resultStub({}), metreInput(AVAILABLE));
    expect(avail.rows.find((r) => r.key === 'evidence')!.value).toContain('Supported');
    const expl = buildContourReviewSummary(resultStub({}), metreInput(EXPLORATORY));
    const ev = expl.rows.find((r) => r.key === 'evidence')!;
    expect(ev.value).toBe('Exploratory');
    expect(ev.rationale.some((r) => /vertical units are unknown/i.test(r))).toBe(true);
  });
});

/**
 * The support row must account for the WHOLE grid.
 *
 * It printed only measured / interpolated / empty out of a five-bucket
 * tally, so a real vineyard scan read "34% measured · 2% interpolated · 0%
 * unsupported" — 36%, with the other 64% (lowConfidence + edgeRisk) shown
 * nowhere. The direction is what makes it a defect rather than a rounding
 * nit: "0% unsupported" reads as "nothing here is weak" precisely when
 * two-thirds of the surface is weakened. The stub used to hardcode both
 * weak buckets to zero, which is why no test could see it.
 */
describe('support row completeness', () => {
  const support = (r: Parameters<typeof resultStub>[0]) =>
    buildContourReviewSummary(resultStub(r), metreInput(AVAILABLE)).rows.find((x) => x.key === 'support')!;

  it('accounts for every bucket, not just the strong ones', () => {
    // The screenshot case: 34 measured, 2 interpolated, 64 weak, 0 void.
    const row = support({ measured: 340, interpolated: 20, lowConfidence: 600, edgeRisk: 40, empty: 0, total: 1000 });
    expect(row.value).toContain('34% measured');
    expect(row.value).toContain('2% interpolated');
    expect(row.value).toContain('60% low confidence');
    expect(row.value).toContain('4% edge risk');
    expect(row.value).toContain('0% void');
  });

  it('displayed percentages sum to exactly 100 even when rounding fights back', () => {
    // Three thirds each round to 33 and lose a point; the row must still
    // add up, or a reader checking the arithmetic loses trust in the panel.
    const row = support({ measured: 1, interpolated: 1, lowConfidence: 1, edgeRisk: 0, empty: 0, total: 3 });
    const sum = [...row.value.matchAll(/(\d+)%/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(sum).toBe(100);
  });

  it('does not call a mostly-weak surface high confidence', () => {
    // Confidence keyed off `empty` alone rated this 'high' because nothing
    // was strictly void — while 64% of it was weak.
    expect(support({ measured: 340, interpolated: 20, lowConfidence: 600, edgeRisk: 40, empty: 0, total: 1000 }).confidence)
      .not.toBe('high');
  });

  it('still reports a genuinely strong surface as high confidence', () => {
    expect(support({ measured: 950, interpolated: 50, lowConfidence: 0, edgeRisk: 0, empty: 0, total: 1000 }).confidence)
      .toBe('high');
  });
});

/**
 * The Source row must not claim a provenance the data lacks.
 *
 * It printed "Classified ground" whenever any measured cell existed. On a
 * scan whose classification is 0% covered, ground came from the viewer's
 * geometric filter — a derived estimate presented as a producer's survey
 * classification, which is the one direction the honesty contract forbids.
 */
describe('ground source provenance', () => {
  const sourceRow = (groundIsDerived: boolean) =>
    buildContourReviewSummary(resultStub({}), { ...metreInput(AVAILABLE), groundIsDerived }).rows.find((r) => r.key === 'source')!;

  it('says derived when the classification was derived by the viewer', () => {
    const row = sourceRow(true);
    expect(row.value).toMatch(/derived/i);
    expect(row.value).not.toMatch(/^Classified ground$/);
    expect(row.rationale.join(' ')).toMatch(/not from the source file|derived/i);
  });

  it('says classified only when the source file carried the classification', () => {
    expect(sourceRow(false).value).toBe('Classified ground');
  });

  it('never rates derived ground as high confidence', () => {
    // Derived ground can be dense and still wrong; density is not provenance.
    expect(sourceRow(true).confidence).not.toBe('high');
  });
});
