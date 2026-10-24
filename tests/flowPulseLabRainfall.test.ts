/**
 * flowPulseLabRainfall.test.ts — what the Flow Pulse Lab says about rainfall,
 * survey edges, snapped outlets and the watershed GIF, through its pure seams.
 *
 * Pinned: a missing unit withholds square metres instead of assuming 1; an
 * edge-contaminated area and its peak flow read "at least"; the peak flow is
 * linear in rainfall and withheld without metres; the map's channel field
 * grows with rainfall; the GIF input carries the facts the GIF prints; the
 * outlet wording says flow leaves there; the gap-rim limitation matches what
 * routing reports.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { flowDtmOfCounted as dtmOf } from './helpers/flowFixtures';
import { edgeContamination } from '../src/simulation/flowPulse/edgeContamination';
import { rationalPeakM3s } from '../src/simulation/flowPulse/rationalDischarge';
import { catchmentClick } from '../src/simulation/flowPulse/flowClickGuard';
import { FLOW_PULSE_DEFAULTS, runFlowPulse, type FlowPulseResult } from '../src/simulation/flowPulse/flowPulseRunner';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';

beforeAll(installRecordingDom);

const lab = await import('../src/ui/fieldSimulation/flowPulseLab');
type LabInput = Parameters<typeof lab.runLabFlowPulse>[0] & object;
const textOf = (node: HTMLElement) => (node as unknown as RecordingEl).textContent;

/** A valley along column 2 (row 0 is the southern row, so it falls north), entering the survey at its south edge. */
const valleyRows = [
  [7, 6, 5, 6, 7],
  [6, 5, 4, 5, 6],
  [5, 4, 3, 4, 5],
  [4, 3, 2, 3, 4],
  [3, 2, 1, 2, 3],
];

function input(over: Partial<LabInput> = {}): LabInput {
  return {
    result: { dtm: dtmOf(valleyRows), horizontalScaleResolved: true } as never,
    isGeographic: false, worldOriginY: null, resolvedUnitToMetres: 1,
    layerId: 'scan-1', filename: 'site', crsName: 'EPSG:6346', ...over,
  };
}

function run(over: Partial<LabInput> = {}): FlowPulseResult {
  const r = lab.runLabFlowPulse(input(over), 'raw');
  if (!r.ok) throw new Error('fixture refused');
  return r;
}

describe('units', () => {
  it('withholds square metres when the unit is missing, rather than assuming one metre', () => {
    expect(lab.flowScaleOf(input({ resolvedUnitToMetres: null })).resolved).toBe(false);
    const r = run({ resolvedUnitToMetres: null });
    expect(r.contributingAreaM2).toBeNull();
    expect(lab.areaOfCells(r, 5)).toBeNull();
    expect(lab.flowScaleOf(input()).resolved).toBe(true);
  });
});

describe('edge contamination on screen', () => {
  it('marks the largest drainage as a lower bound in the card and the figures', () => {
    const r = run();
    const edge = edgeContamination(r.grid, r.routed);
    expect(edge.contaminated[lab.largestDrainageCell(r)]).toBe(1);
    const card = textOf(lab.renderFlowPulseLab(r, false, edge));
    expect(card).toContain('m² — at least: the catchment reaches the survey edge, so ground outside the survey may also drain here');
    expect(card).toContain('Edge-contaminated cells');
    expect(textOf(lab.flowPulseStats(r, edge))).toMatch(/≥ \d/);
    expect(textOf(lab.flowPulseStats(r, null))).not.toContain('≥');
  });

  it('writes the area plainly when the catchment is closed, and withholds it without metres', () => {
    expect(lab.contributingAreaText(3905, false)).toBe('3,905.0 m²');
    expect(lab.contributingAreaText(3905, true)).toBe('3,905.0 m² — at least: the catchment reaches the survey edge, so ground outside the survey may also drain here');
    expect(lab.contributingAreaText(null, true)).toBe('Withheld: the horizontal scale is not resolved');
  });
});

describe('peak flow in the Lab', () => {
  it('is Q = C i A over the catchment area, linear in rainfall, and withheld without metres', () => {
    const r = run();
    const a = lab.labPeakFlow(r, 10, { intensityMmH: 25, runoffC: 0.2 }, false);
    const b = lab.labPeakFlow(r, 10, { intensityMmH: 50, runoffC: 0.2 }, false);
    if (!a.ok || !b.ok) throw new Error('expected estimates');
    expect(a.qM3s).toBeCloseTo(rationalPeakM3s(0.2, 25, 10), 15);
    expect(b.qM3s / a.qM3s).toBeCloseTo(2, 12);
    const none = lab.labPeakFlow(run({ resolvedUnitToMetres: null }), 10, { intensityMmH: 25, runoffC: 0.2 }, false);
    expect(none.ok).toBe(false);
  });

  it('draws more of the network as the rainfall rises, and says what it draws', () => {
    const r = run();
    const light = lab.displayChannelField(r, { intensityMmH: 1, runoffC: 0.05 })!;
    const heavy = lab.displayChannelField(r, { intensityMmH: 200, runoffC: 1 })!;
    expect(heavy.channelCells).toBeGreaterThanOrEqual(light.channelCells);
    expect(lab.rainfallNote(heavy, { intensityMmH: 200, runoffC: 1 })).toContain('cells reach the line threshold of 1 L/s estimated peak flow');
    expect(lab.displayChannelField(run({ resolvedUnitToMetres: null }), { intensityMmH: 25, runoffC: 0.2 })).toBeNull();
    expect(lab.rainfallNote(null, { intensityMmH: 25, runoffC: 0.2 })).toContain('Withheld: the horizontal scale is not resolved');
  });
});

describe('watershed GIF input', () => {
  it('carries the outlet, area, lower bound, peak flow, channel rule and file name', () => {
    const inp = input();
    const r = run();
    const outlet = { col: 2, row: 1 };
    const c = catchmentClick(r, outlet, false);
    if (!c.ok) throw new Error('catchment refused');
    const edge = edgeContamination(r.grid, r.routed);
    const g = lab.watershedGifInputFor(inp, r, c, { intensityMmH: 25, runoffC: 0.2 }, edge, { col: 3, row: 1 }, '2026-10-24T00:00:00.000Z', '0.7.0 (x)');
    expect(g.outlet).toBe(1 * r.grid.cols + 2);
    expect(g.unit).toBe('m');
    expect(g.facts).toMatchObject({
      outletCol: 2, outletRow: 1, sourceName: 'site', conditioning: 'raw', cells: c.cells,
      edgeContaminated: true, crsName: 'EPSG:6346', version: '0.7.0 (x)', snappedFrom: { col: 3, row: 1 },
    });
    expect(g.facts.areaM2).toBeCloseTo(c.cells * r.grid.cellMetresX * r.grid.cellMetresY, 9);
    expect(g.facts.peakFlow?.ok && g.facts.peakFlow.lowerBound).toBe(true);
    expect(g.facts.channelRule).toBe('estimated peak flow at least 1 L/s at 25 mm/h, C 0.2');
    expect(g.shade?.length).toBe(r.grid.cols * r.grid.rows);
    expect(lab.watershedGifFilename('site', 2, 1)).toBe('site-watershed-2-1.gif');
  });

  it('falls back to cell lengths and the count rule without metres', () => {
    const inp = input({ resolvedUnitToMetres: null });
    const r = run({ resolvedUnitToMetres: null });
    const c = catchmentClick(r, { col: 2, row: 0 }, false);
    if (!c.ok) throw new Error('catchment refused');
    const g = lab.watershedGifInputFor(inp, r, c, { intensityMmH: 25, runoffC: 0.2 }, edgeContamination(r.grid, r.routed), null, '2026-10-24T00:00:00.000Z');
    expect(g.unit).toBe('cells');
    expect(g.facts.areaM2).toBeNull();
    expect(g.facts.peakFlow?.ok).toBe(false);
    expect(g.facts.channelRule).toMatch(/^upstream count at least/);
  });
});

describe('wording', () => {
  it('an outlet is where flow leaves; a stream entering the survey is an edge channel', () => {
    const text = lab.FLOW_HOW_TO_READ.join(' ');
    expect(text).toContain('Outlets are where flow leaves the surface at its edge.');
    expect(text).not.toContain('where a stream enters it');
    expect(text).toContain('A stream that enters the survey shows as a channel that starts at the edge');
  });

  it('the snap sentence names both cells and the radius', () => {
    expect(lab.snapSentence({ col: 4, row: 5 }, { col: 5, row: 6 }))
      .toBe('Outlet snapped to the strongest channel within 2 cells: from col 4, row 5 to col 5, row 6.');
  });

  it('the gap-outlet limitation says a rim cell is reported as a sink or a flat', () => {
    // A slope with an enclosed hole, conditioned with gaps read as exits.
    const dtm = flowDtmOf([
      [5, 5, 5, 5, 5],
      [5, 4, 4, 4, 5],
      [5, 4, null, 4, 5],
      [5, 4, 4, 4, 5],
      [5, 5, 5, 5, 5],
    ]);
    const r = runFlowPulse(dtm, FLOW_PROJECTED_SCALE, { ...FLOW_PULSE_DEFAULTS, fillNoData: 'outlet' }, FLOW_TEST_IDENTITY);
    if (!r.ok) throw new Error('refused');
    const text = r.limitations.join(' ');
    expect(text).toContain('it is reported as a sink, or as a flat where a neighbour is level with it');
    // And the routing agrees: the ring around the hole holds no routed exit.
    expect(r.summary.sinkCount + r.summary.flatCount).toBeGreaterThan(0);
  });
});
