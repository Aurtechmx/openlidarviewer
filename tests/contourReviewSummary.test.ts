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
  cellSizeM?: number; contourIntervalM?: number; recommendedM?: number | null;
  reasons?: string[]; rmse?: number; gateWarnings?: string[];
}): AnalyseContoursResult {
  return {
    cellStatusTally: {
      measured: over.measured ?? 800, interpolated: over.interpolated ?? 150,
      empty: over.empty ?? 50, lowConfidence: 0, edgeRisk: 0, total: over.total ?? 1000,
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

  it('interval row reports none when nothing is supportable', () => {
    const s = buildContourReviewSummary(resultStub({ recommendedM: null, contourIntervalM: 0, gateWarnings: ['relief too low'] }), metreInput(EXPLORATORY));
    const interval = s.rows.find((r) => r.key === 'interval')!;
    expect(interval.value).toBe('none supportable');
    expect(interval.rationale).toContain('relief too low');
  });

  it('support row reports measured/interpolated/unsupported percentages', () => {
    const s = buildContourReviewSummary(resultStub({ measured: 700, interpolated: 200, empty: 100, total: 1000 }), metreInput(AVAILABLE));
    const support = s.rows.find((r) => r.key === 'support')!;
    expect(support.value).toBe('70% measured · 20% interpolated · 10% unsupported');
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
