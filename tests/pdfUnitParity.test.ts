/**
 * pdfUnitParity.test.ts
 *
 * The two PDF deliverables that convert between feet and metres must print
 * the same numbers the on-screen panels print for the same CRS. Golden values
 * were recorded on main before the PDFs were routed through the canonical
 * unit helpers (units/units.ts, io/crs.ts), so any drift fails here.
 */

import { describe, it, expect } from 'vitest';
import { buildMapSheetPdf } from '../src/render/measure/mapSheetPdf';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { extractTextOps } from './pdfTextOps';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';
import { crsFromEpsg, metresPerLinearUnit, toMetres } from '../src/io/crs';
import type { ContourFeatureModel, ContourFeature } from '../src/terrain/contour/contourFeatureModel';

function feature(value: number, isIndex: boolean, pts: Array<[number, number]>): ContourFeature {
  return { value, isIndex, grade: 'solid', meanConfidence: 90, closed: false, coordinates: pts };
}

const model: ContourFeatureModel = {
  features: [
    feature(100, true, [[0, 0], [5000, 1000], [10000, 0]]),
    feature(110, false, [[0, 3000], [5000, 4000], [10000, 3000]]),
  ],
  crs: 'NAD83 / California zone 5 (ftUS)',
  verticalDatum: 'NAVD88',
  intervalM: 10,
  contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 10000, maxY: 6000 },
  interpolatedFraction: 0.12,
  coverageMode: 'full',
  warnings: [],
};

async function scaleText(linearUnit: 'metre' | 'foot' | 'us-survey-foot'): Promise<string> {
  const bytes = await buildMapSheetPdf({
    model,
    labels: [],
    worldOrigin: { x: 6_500_000, y: 1_800_000 },
    crs: model.crs,
    verticalDatum: model.verticalDatum,
    linearUnit,
    readiness: 'previewOnly',
    title: 'Parity',
  });
  const ops = await extractTextOps(bytes);
  const hit = ops.find((o) => /^1:[\d,]+$/.test(o.text));
  if (!hit) throw new Error('no scale row');
  return hit.text;
}

describe('map sheet PDF scale follows the CRS linear unit', () => {
  it('the sheet factor is the CRS factor the panels read', () => {
    for (const u of ['metre', 'foot', 'us-survey-foot'] as const) {
      expect(metresPerLinearUnit(u)).toBe(crsFromEpsg(2229, { linearUnit: u }).linearUnitToMetres);
    }
    expect(metresPerLinearUnit('us-survey-foot')).toBe(1200 / 3937);
  });

  it('golden scale ratios per linear unit', async () => {
    expect({
      metre: await scaleText('metre'),
      foot: await scaleText('foot'),
      usft: await scaleText('us-survey-foot'),
    }).toMatchSnapshot();
  });

  it('a US-survey-foot sheet converts with the same factor the panels use', async () => {
    // EPSG:2229 is NAD83 / California zone 5 (ftUS). The panels convert with
    // crs.linearUnitToMetres via toMetres; the sheet's 1:N must equal the
    // metric sheet's 1:N scaled by that same factor.
    const crs = crsFromEpsg(2229, { linearUnit: 'us-survey-foot' });
    expect(crs.linearUnit).toBe('us-survey-foot');
    const n = (s: string): number => Number(s.slice(2).replace(/,/g, ''));
    const metric = n(await scaleText('metre'));
    const usft = n(await scaleText('us-survey-foot'));
    // Both 1:N values are rounded, so they agree to within one unit.
    expect(Math.abs(usft - toMetres(metric, crs))).toBeLessThanOrEqual(1);
  });
});

// A z-up 14 x 29 x 5 m box sampled on a 0.1 m grid.
function room(W = 14, D = 29, H = 5, step = 0.1): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  return Float32Array.from(t);
}

describe('space report PDF dimensions match the floor-plan panel', () => {
  const pos = room();
  const shape = classifyScanShape(pos);
  const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior', hasRgb: true });
  const floorPlan = extractFloorPlan(pos, { upAxis: shape.up });

  for (const unitSystem of ['metric', 'imperial'] as const) {
    it(`${unitSystem}: PDF "W … x D …" equals the panel's "Overall … x …"`, async () => {
      const bytes = await buildSpaceReportPdf({ space, name: 'Parity', floorPlan, unitSystem });
      const ops = await extractTextOps(bytes);
      const dims = ops.find((o) => o.text.startsWith('W '))?.text ?? '';
      expect(dims).toMatchSnapshot();
      const m = /^W (.+) x D (.+)$/.exec(dims);
      expect(m).not.toBeNull();
      const svg = floorPlanSvg(floorPlan, { unitSystem });
      const overall = /Overall (.+?) x (.+?)(?: · |<)/.exec(svg);
      expect(overall).not.toBeNull();
      expect([m![1], m![2]]).toEqual([overall![1], overall![2]]);
    });
  }
});
