/**
 * flowDrainageSheetPdf.test.ts: the Flow Pulse drainage sheet.
 *
 * The model is asserted directly (each section present or absent, placement,
 * peak flow only with a path or catchment, the depression table's truncation,
 * PREVIEW marking, the catchment study's gate); the PDF is checked for its
 * page count, since a compressed content stream cannot be text-asserted.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import {
  buildDrainageSheetModel, buildFlowDrainageSheetPdf, drainageChannelMask, drainageSheetFilename,
  tracedUnavailableReason, type FlowDrainageSheetOptions,
} from '../src/export/flowDrainageSheetPdf';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { linearUnitOf } from '../src/export/flowDrainageSheetUnits';
import {
  FLOW_PULSE_DEFAULTS, catchmentFrom, pulseFrom, runFlowPulse, type FlowPulseResult,
} from '../src/simulation/flowPulse/flowPulseRunner';
import { RAINFALL_DEFAULT } from '../src/simulation/flowPulse/rationalDischarge';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { buildValley } from './support/watershedValley';

const bowl = () => flowDtmOf([
  [5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5],
]);

function runOf(over: Partial<Parameters<typeof flowDtmOf>[1]> = {}, conditioning: 'raw' | 'priority-flood' = 'priority-flood'): FlowPulseResult {
  const r = runFlowPulse({ ...bowl(), ...over }, FLOW_PROJECTED_SCALE, { ...FLOW_PULSE_DEFAULTS, conditioning }, FLOW_TEST_IDENTITY);
  if (!r.ok) throw new Error(r.code);
  return r;
}

const selections = (r: FlowPulseResult): Pick<FlowDrainageSheetOptions, 'path' | 'catchment'> => ({
  path: { cells: pulseFrom(r, 0) },
  catchment: { mask: catchmentFrom(r, 2), outletCell: 2 },
});

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const render = { loadFont: async (name: string) => new Uint8Array(await readFile(join(FONT_DIR, name))) };

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe('sections follow the options', () => {
  it('includes every available section by default', () => {
    const r = runOf();
    const m = buildDrainageSheetModel(r, { ...selections(r), rainfall: RAINFALL_DEFAULT });
    expect(m.sections).toEqual(['map', 'summary', 'traced', 'depressions']);
    expect(m.map && m.summary && m.traced && m.depressions).toBeTruthy();
  });

  it('drops each unticked section', () => {
    const r = runOf();
    for (const off of ['map', 'summary', 'traced', 'depressions'] as const) {
      const m = buildDrainageSheetModel(r, { ...selections(r), sections: { [off]: false } });
      expect(m.sections).not.toContain(off);
      expect(m[off]).toBeNull();
    }
  });

  it('leaves the traced section out when nothing was traced, and says why in the dialog', () => {
    const m = buildDrainageSheetModel(runOf());
    expect(m.sections).not.toContain('traced');
    expect(m.map?.path).toBeNull();
    expect(tracedUnavailableReason(false, false)).toMatch(/Trace a path/);
    expect(tracedUnavailableReason(true, false)).toBeNull();
  });

  it('adds and drops pages with the sections; cover and method pages always print', async () => {
    const v = buildValley();
    const outlet = v.model.sections[0]!.outlet;
    const base = { dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT, path: { cells: pulseFrom(v.result, 70 * 120 + 50) }, catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet } };
    const all = await pageCount(await buildFlowDrainageSheetPdf(v.result, base, render));
    const none = await pageCount(await buildFlowDrainageSheetPdf(v.result, { ...base, sections: { map: false, summary: false, catchment: false, traced: false, depressions: false } }, render));
    // Cover, reading guide and site map, data quality and method, appendix A.
    expect(none).toBe(4);
    // Plus drainage map, hydrology summary, one page for path and depressions, two per catchment (3 studied).
    expect(all).toBeGreaterThanOrEqual(none + 3 + 6);
    const noMap = await pageCount(await buildFlowDrainageSheetPdf(v.result, { ...base, sections: { map: false } }, render));
    expect(noMap).toBeLessThan(all);
  }, 60_000);
});

describe('placement', () => {
  it('uses local grid coordinates without a world origin and raster frame', () => {
    const m = buildDrainageSheetModel(runOf(), { crsName: 'EPSG:32633', worldOrigin: { x: 500000, y: 4000000 } });
    expect(m.map?.placed).toBe(false);
    expect(m.map?.ox).toBe(0);
    expect(m.map?.crsText).toContain('not applied');
  });

  it('places the grid as the package does with both', () => {
    const m = buildDrainageSheetModel(runOf(), {
      crsName: 'EPSG:32633', worldOrigin: { x: 500000, y: 4000000 },
      gridFrame: { originH1: 10, originH2: 20, cellSize: 2 }, linearUnit: 'metre',
    });
    expect(m.map).toMatchObject({ placed: true, ox: 500010, oy: 4000020, cellX: 2, crsText: 'EPSG:32633', linearUnit: 'metre' });
    expect(m.map?.gridText).toContain('EPSG:32633');
  });

  it('names the linear unit from metres per unit', () => {
    expect(linearUnitOf(1)).toBe('metre');
    expect(linearUnitOf(0.3048)).toBe('foot');
    expect(linearUnitOf(1200 / 3937)).toBe('us-survey-foot');
    expect(linearUnitOf(0.5)).toBe('unknown');
    expect(linearUnitOf(null)).toBe('unknown');
  });
});

describe('peak flow', () => {
  it('is estimated only at a drawn path or catchment', () => {
    const r = runOf();
    const none = buildDrainageSheetModel(r, { rainfall: RAINFALL_DEFAULT }).summary!.join('\n');
    expect(none).toContain('No path or catchment was drawn');
    expect(none).not.toMatch(/At the (catchment outlet|path end)/);
    const both = buildDrainageSheetModel(r, { ...selections(r), rainfall: RAINFALL_DEFAULT }).summary!.join('\n');
    expect(both).toMatch(/At the catchment outlet .*rational method/);
    expect(both).toMatch(/At the path end/);
  });

  it('uses the Lab line threshold when a rainfall setting is given', () => {
    const r = runOf();
    expect(drainageChannelMask(r, RAINFALL_DEFAULT).basis).toContain('1 L/s');
    expect(drainageChannelMask(r, null).basis).toContain('Upstream count');
  });
});

describe('depression table', () => {
  it('shows the top rows by size and says how many', () => {
    const v = buildValley();
    const all = v.result.depressions.depressions.length;
    const t = buildDrainageSheetModel(v.result, { depressionRows: 2 }).depressions!;
    expect(t.rows.length).toBe(Math.min(2, all));
    expect(t.note).toContain(`${Math.min(2, all)} of ${all} shown`);
    expect(t.header).toEqual(['Rank', 'Cells', 'Area (m2)', 'Max fill depth (source units)', 'Outlet elev. local (source units)', 'Seed col', 'Seed row']);
  });
});

describe('PREVIEW marking', () => {
  it('marks a sampled run PREVIEW', () => {
    const m = buildDrainageSheetModel(runOf({ coverageMode: 'sampled' } as never));
    expect(m.preview).toBe(true);
    expect(m.statusLines[0]).toBe('PREVIEW - not survey-grade until validated against control.');
    expect(m.statusLines.join(' ')).toContain('sampled');
  });

  it('marks a Preview terrain verdict PREVIEW with the caveat', () => {
    const m = buildDrainageSheetModel(runOf(), { terrainCaveat: { verdict: 'Preview', interpolatedPercent: 40 } });
    expect(m.preview).toBe(true);
    expect(m.statusLines.join(' ')).toContain('Terrain verdict: Preview; 40%');
  });

  it('never claims survey grade on a complete run', () => {
    const m = buildDrainageSheetModel(runOf());
    expect(m.preview).toBe(false);
    expect(m.statusLines.join(' ')).toContain('not survey-grade');
    expect(m.statusLines.join(' ')).toContain('not rainfall-runoff, hydraulic or flood modelling');
  });
});

describe('the catchment study', () => {
  it('studies the largest watersheds of a complete conditioned run', () => {
    const v = buildValley();
    const m = buildDrainageSheetModel(v.result, { dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT });
    expect(m.sections).toContain('catchment');
    expect(m.catchmentStudy!.model.sections.length).toBeGreaterThan(0);
    expect(m.catchmentStudy!.thresholdText).toContain('1 L/s');
  });

  it('studies the drawn catchment first, then the two largest others', () => {
    const v = buildValley();
    const outlet = v.model.sections[0]!.outlet;
    const m = buildDrainageSheetModel(v.result, {
      dtm: v.dtm, verticalToMetres: 1, catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet },
    });
    const secs = m.catchmentStudy!.model.sections;
    expect(secs.map((s) => s.label)).toEqual(['C1', 'C2', 'C3']);
    expect(secs[0]!.outlet).toBe(outlet);
    expect(m.catchmentStudy!.names.C1).toContain('your catchment');
    const auto = buildDrainageSheetModel(v.result, { dtm: v.dtm, verticalToMetres: 1 });
    expect(auto.catchmentStudy!.model.sections.map((s) => s.label)).toEqual(['C1', 'C2']);
  });

  it('withholds heights without a vertical unit, giving the reason', () => {
    const v = buildValley();
    const outlet = v.model.sections[0]!.outlet;
    const m = buildDrainageSheetModel(v.result, { dtm: v.dtm, verticalToMetres: null, catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet } });
    const s = m.catchmentStudy!.model.sections[0]!;
    expect(s.quality.complete).toBe(true);
    expect(s.morph.reliefM).toEqual({ withheld: 'vertical-unresolved' });
    expect(s.channel.slope1085).toEqual({ withheld: 'vertical-unresolved' });
  });

  it('is withheld on a raw run, with the reason on the summary', () => {
    const r = runOf({}, 'raw');
    const m = buildDrainageSheetModel(r, { dtm: bowl() });
    expect(m.sections).not.toContain('catchment');
    expect(m.catchmentStudy!.model.sections).toEqual([]);
    expect(m.catchmentStudyWithheld).toMatch(/raw terrain/);
    expect(m.summary!.join('\n')).toContain('Not included: The run uses raw terrain');
  });
});

describe('filename and sample render', () => {
  it('names the file <basename>-drainage.pdf', () => {
    expect(drainageSheetFilename('site')).toBe('site-drainage.pdf');
  });

  it('renders the valley fixture, local and placed', async () => {
    const v = buildValley();
    const outlet = v.model.sections[0]!.outlet;
    const base = {
      basename: 'valley', title: 'Valley test site', dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT, verticalUnitLabel: 'm' as const,
      path: { cells: pulseFrom(v.result, 70 * 120 + 50) },
      catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet },
      generationDateIso: '2026-11-07T00:00:00.000Z',
    };
    const bytes = await buildFlowDrainageSheetPdf(v.result, base, render);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    const placed = await buildFlowDrainageSheetPdf(v.result, {
      ...base, crsName: 'WGS 84 / UTM zone 14N', worldOrigin: { x: 512000, y: 2150000 },
      gridFrame: { originH1: 0, originH2: 0, cellSize: 3 }, linearUnit: 'metre',
      terrainCaveat: { verdict: 'Preview', interpolatedPercent: 6 },
    }, render);
    if (process.env.DRAINAGE_SHEET_OUT) {
      writeFileSync(process.env.DRAINAGE_SHEET_OUT, bytes);
      writeFileSync(process.env.DRAINAGE_SHEET_OUT.replace(/\.pdf$/, '-placed.pdf'), placed);
    }
  }, 60_000);
});
