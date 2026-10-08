/**
 * profileChartCoverageGap.test.ts
 *
 * A profile sample with no coverage (a NaN height, or any height whose corridor
 * count is 0) is a gap. The general report's profile chart, its slope line, the
 * live panel chart and the dedicated profile sheet must all break the line
 * there, so no drawn segment joins the samples on either side of a gap and no
 * grade is computed through an uncovered height.
 *
 * Fixture: a 30 m section from (0,0,100) to (30,0,106) with samples at
 * d = 0, 10, 20, 30. The sample at d = 10 is uncovered.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PDFPage } from 'pdf-lib';
import { installFakeDom, type FakeEl } from './support/measurePanelDom';
import { buildMeasurementRows, generateReport, composeReportInputs } from '../src/report';
import type { ReportInputs, ReportMeasurementRow } from '../src/report';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { Measurement, ProfileChartSample } from '../src/render/measure/types';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';

beforeAll(() => installFakeDom());

const GAPS: ReadonlyArray<{ readonly name: string; readonly gap: ProfileChartSample }> = [
  { name: 'a NaN height', gap: { distance: 10, height: Number.NaN, count: 0 } },
  { name: 'a finite height with count 0', gap: { distance: 10, height: 150, count: 0 } },
];

function samples(gap: ProfileChartSample): ProfileChartSample[] {
  return [
    { distance: 0, height: 100, count: 9 },
    gap,
    { distance: 20, height: 104, count: 9 },
    { distance: 30, height: 106, count: 9 },
  ];
}

function profileMeasurement(gap: ProfileChartSample): Measurement {
  return {
    id: 'p1',
    kind: 'profile',
    name: 'Section A',
    points: [[0, 0, 100], [30, 0, 106]],
    profileChart: samples(gap),
  } as unknown as Measurement;
}

function profileRow(gap: ProfileChartSample): ReportMeasurementRow {
  const [row] = buildMeasurementRows([profileMeasurement(gap)], 'metric');
  return row;
}

/** Split a chart series into its covered runs (by distance), breaking at NaN heights. */
function runsOf(chart: ReadonlyArray<{ distance: number; height: number }>): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  for (const s of chart) {
    if (!Number.isFinite(s.height)) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push(s.distance);
    }
  }
  if (run.length) out.push(run);
  return out;
}

/** The chart polyline segments the general report draws (0.9 pt accent lines). */
async function reportChartSegments(row: ReportMeasurementRow): Promise<Array<{ x0: number; x1: number }>> {
  const inputs: ReportInputs = {
    ...composeReportInputs({
      templateId: 'technical-report',
      title: 'Inspection',
      metadata: {
        fileName: 'scan.laz', format: 'LAZ', sourcePointCount: 100,
        width: 30, depth: 1, height: 6, density: 1,
        hasRgb: false, hasIntensity: false, hasClassification: false,
      },
      visuals: [], annotations: [], measurements: [],
      unitSystem: 'metric' as never,
    }),
    measurements: [row],
  };
  const orig = PDFPage.prototype.drawLine;
  const segs: Array<{ x0: number; x1: number }> = [];
  PDFPage.prototype.drawLine = function (this: PDFPage, opts: Parameters<PDFPage['drawLine']>[0]) {
    if (opts.thickness === 0.9) segs.push({ x0: opts.start.x, x1: opts.end.x });
    return orig.call(this, opts);
  } as PDFPage['drawLine'];
  try {
    const result = await generateReport(inputs, { timeoutMs: Infinity });
    expect(result.failedSections).toEqual([]);
  } finally {
    PDFPage.prototype.drawLine = orig;
  }
  return segs;
}

/** The number of profile polylines the dedicated sheet strokes (1.6 pt curve). */
async function profileSheetRuns(gap: ProfileChartSample): Promise<number> {
  const orig = PDFPage.prototype.drawSvgPath;
  let n = 0;
  PDFPage.prototype.drawSvgPath = function (this: PDFPage, path: string, opts?: Parameters<PDFPage['drawSvgPath']>[1]) {
    if (opts?.borderWidth === 1.6) n++;
    return orig.call(this, path, opts);
  } as PDFPage['drawSvgPath'];
  try {
    await buildProfilePdf({ name: 'Section A', samples: samples(gap), generatedAt: new Date('2026-01-01T00:00:00Z') });
  } finally {
    PDFPage.prototype.drawSvgPath = orig;
  }
  return n;
}

/** The profile paths the live panel chart draws, as their vertex counts. */
function panelRuns(gap: ProfileChartSample): number[] {
  const panel = new MeasurePanel({
    onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  const summary: MeasurementSummary = {
    id: 'p1', kind: 'profile', name: 'Section A', value: '30.00 m', profileChart: samples(gap),
  };
  panel.update([summary]);
  const chart = (panel.element as unknown as FakeEl).querySelector('div.olv-mp-chart')!;
  return [...chart.innerHTML.matchAll(/<path d="([^"]+)"/g)]
    .map((m) => (m[1].match(/[ML]/g) ?? []).length);
}

describe.each(GAPS)('profile chart with $name at d = 10', ({ gap }) => {
  it('the report builder marks the uncovered sample as a gap and keeps the others', () => {
    const chart = profileRow(gap).profileExtras!.chart!;
    expect(chart.map((s) => s.distance)).toEqual([0, 10, 20, 30]);
    expect(runsOf(chart)).toEqual([[0], [20, 30]]);
  });

  it('the general report draws no segment across the gap', async () => {
    const segs = await reportChartSegments(profileRow(gap));
    // Only 20 -> 30 is a segment; its width is a third of the plotted span.
    expect(segs).toHaveLength(1);
    const plotted = 240 - 2 * 5;
    for (const s of segs) expect(Math.abs(s.x1 - s.x0)).toBeLessThanOrEqual(plotted / 3 + 1e-6);
  });

  it('the slope summary ignores the uncovered sample', () => {
    const slope = profileRow(gap).profileExtras!.slopeSummary;
    expect(slope).not.toMatch(/500\.00%|460\.00%/);
    // 20 -> 30 rises 2 m over 10 m: +20 %.
    expect(slope).toContain('Max +20.00%');
  });

  it('the dedicated sheet and the general report break into the same runs', async () => {
    const chart = profileRow(gap).profileExtras!.chart!;
    expect(await profileSheetRuns(gap)).toBe(runsOf(chart).length);
  });

  it('the live panel chart breaks at the gap', () => {
    const runs = panelRuns(gap);
    expect(Math.max(...runs)).toBeLessThanOrEqual(2);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(3);
  });
});
