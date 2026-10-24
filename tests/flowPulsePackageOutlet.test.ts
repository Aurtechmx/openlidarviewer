/**
 * flowPulsePackageOutlet.test.ts — the ZIP names the catchment it carries.
 *
 * A catchment mask on its own does not say which outlet it drains to or how
 * large it is. With a catchment selected the package now writes the outlet's
 * column and row, its cell-centre position in the rasters' frame, the cell
 * count, the area (withheld without metres), the edge-contamination flag, the
 * snap that moved a picked outlet, and, with a rainfall setting, the
 * rational-method peak flow at the outlet and at a traced path's end.
 */
import { describe, expect, it } from 'vitest';
import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import { FLOW_PULSE_DEFAULTS, catchmentFrom, pulseFrom, runFlowPulse, type FlowPulseResult } from '../src/simulation/flowPulse/flowPulseRunner';
import { edgeContamination } from '../src/simulation/flowPulse/edgeContamination';
import { rationalPeakM3s } from '../src/simulation/flowPulse/rationalDischarge';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import { FLOW_PROJECTED_SCALE as projected, FLOW_TEST_IDENTITY as identity, flowDtmOf as dtmOf } from './helpers/flowFixtures';
import { extractEntry, jsonOf, textOf } from './helpers/zipReader';

/** A valley falling south (row 0 is south) along column 2; 2 m cells. */
const valley = () => dtmOf([
  [3, 2, 1, 2, 3],
  [4, 3, 2, 3, 4],
  [5, 4, 3, 4, 5],
  [6, 5, 4, 5, 6],
  [7, 6, 5, 6, 7],
], { cellSizeM: 2 });

function runOf(scale: HorizontalScale = projected): FlowPulseResult {
  const r = runFlowPulse(valley(), scale, { ...FLOW_PULSE_DEFAULTS, conditioning: 'raw' }, identity, 'm');
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r;
}

interface OutletJson {
  outlet: { col: number; row: number; index: number; x: number; y: number; coordinateFrame: string };
  snappedFrom: { col: number; row: number; radiusCells: number } | null;
  cells: number;
  areaM2: number | null;
  areaIsLowerBound: boolean;
  edgeContaminated: boolean;
  peakFlow: { qM3s: number; intensityMmH: number; runoffC: number; lowerBound: boolean; runoffPreset: { id: string } | null } | { withheld: string } | null;
}

describe('catchment outlet provenance', () => {
  it('names the outlet cell, its position, cells, area and edge contamination', () => {
    const result = runOf();
    const outlet = 7; // col 2, row 1: the valley floor one cell in from the south edge
    const mask = catchmentFrom(result, outlet);
    const zip = buildFlowPulsePackage(result, {
      basename: 'flow', catchment: { mask, outletCell: outlet },
      worldOrigin: { x: 1000, y: 2000 }, gridFrame: { originH1: 10, originH2: 20, cellSize: 2 }, crsName: 'EPSG:6346',
    });
    const j = jsonOf<OutletJson>(zip, 'flow-catchment-outlet.json');
    const cells = mask.reduce((a, b) => a + b, 0);
    expect(j.outlet).toMatchObject({ col: 2, row: 1, index: 7, coordinateFrame: 'scan-crs' });
    expect(j.outlet.x).toBeCloseTo(1000 + 10 + 2.5 * 2, 9);
    expect(j.outlet.y).toBeCloseTo(2000 + 20 + 1.5 * 2, 9);
    expect(j.cells).toBe(cells);
    expect(j.areaM2).toBeCloseTo(cells * 4, 9);
    const ec = edgeContamination(result.grid, result.routed).contaminated[outlet] === 1;
    expect(j.edgeContaminated).toBe(ec);
    // The valley head is on the north edge and routes south, so this catchment is open.
    expect(ec).toBe(true);
    expect(j.areaIsLowerBound).toBe(true);
    expect(j.snappedFrom).toBeNull();
    expect(j.peakFlow).toBeNull();
    const readme = textOf(zip, 'flow-README.txt');
    expect(readme).toContain('Outlet cell        col 2, row 1');
    expect(readme).toContain(`Contributing area  at least ${cells * 4} m2.`);
    expect(readme).toContain('Edge contaminated  yes: the catchment reaches the survey edge');
    expect(readme).toContain('flow-catchment-outlet.json');
    const manifest = textOf(zip, 'flow-processing-manifest.json');
    expect(manifest).toContain('olv.simulation.terrain-flow.edge-contamination@1');
    expect(textOf(zip, 'SHA256SUMS.txt')).toContain('flow-catchment-outlet.json');
  });

  it('records a snapped outlet and the cell that was picked', () => {
    const result = runOf();
    const zip = buildFlowPulsePackage(result, {
      basename: 'flow', catchment: { mask: catchmentFrom(result, 7), outletCell: 7, snappedFrom: 8 },
    });
    const j = jsonOf<OutletJson>(zip, 'flow-catchment-outlet.json');
    expect(j.snappedFrom).toMatchObject({ col: 3, row: 1, radiusCells: 2 });
    expect(textOf(zip, 'flow-README.txt')).toContain('from the picked cell col 3, row 1, to the highest upstream count within 2 cells');
    expect(textOf(zip, 'flow-processing-manifest.json')).toContain('olv.simulation.terrain-flow.pour-point-snap@1');
  });

  it('withholds the area and the peak flow when the horizontal scale is unresolved', () => {
    const result = runOf({ ...projected, resolved: false });
    const zip = buildFlowPulsePackage(result, {
      basename: 'flow', catchment: { mask: catchmentFrom(result, 7), outletCell: 7 },
      rainfall: { intensityMmH: 25, runoffC: 0.2 },
    });
    const j = jsonOf<OutletJson>(zip, 'flow-catchment-outlet.json');
    expect(j.areaM2).toBeNull();
    expect(j.peakFlow).toEqual({ withheld: 'Withheld: the horizontal scale is not resolved' });
    expect(textOf(zip, 'flow-README.txt')).toContain('At the outlet    not estimated: the horizontal scale is not resolved.');
    expect(textOf(zip, 'flow-processing-manifest.json')).not.toContain('rational-peak');
  });

  it('writes no outlet file without a catchment', () => {
    expect(extractEntry(buildFlowPulsePackage(runOf(), { basename: 'flow' }), 'flow-catchment-outlet.json')).toBeNull();
  });
});

describe('rainfall in the package', () => {
  it('records intensity, C and the peak flow at the outlet and at the path end', () => {
    const result = runOf();
    const mask = catchmentFrom(result, 7);
    const path = { cells: pulseFrom(result, 22) };
    const rainfall = { intensityMmH: 40, runoffC: 0.2, presetId: 'lawn-heavy' };
    const zip = buildFlowPulsePackage(result, { basename: 'flow', catchment: { mask, outletCell: 7 }, path, rainfall });
    const j = jsonOf<OutletJson>(zip, 'flow-catchment-outlet.json');
    const area = mask.reduce((a, b) => a + b, 0) * 4;
    if (!j.peakFlow || 'withheld' in j.peakFlow) throw new Error('expected a peak flow');
    expect(j.peakFlow.qM3s).toBeCloseTo(rationalPeakM3s(0.2, 40, area), 15);
    expect(j.peakFlow.intensityMmH).toBe(40);
    expect(j.peakFlow.runoffC).toBe(0.2);
    expect(j.peakFlow.lowerBound).toBe(true);
    expect(j.peakFlow.runoffPreset?.id).toBe('lawn-heavy');
    const geo = jsonOf<{ features: Array<{ properties: Record<string, unknown> }> }>(zip, 'flow-flow-path.geojson');
    const end = path.cells[path.cells.length - 1]!;
    const props = geo.features[0]!.properties;
    expect(props.endUpstreamCells).toBe(result.accumulation.upstreamCells[end]);
    expect((props.endPeakFlow as { qM3s: number }).qM3s)
      .toBeCloseTo(rationalPeakM3s(0.2, 40, result.accumulation.upstreamCells[end]! * 4), 15);
    const readme = textOf(zip, 'flow-README.txt');
    expect(readme).toContain('Rainfall intensity   40 mm/h');
    expect(readme).toContain('Coefficient C        0.2: Grass on heavy soil, the midpoint of 0.18 to 0.22');
    expect(readme).toContain('lasts at least its time of concentration');
    expect(textOf(zip, 'flow-processing-manifest.json')).toContain('olv.simulation.terrain-flow.rational-peak@1');
  });

  it('keeps the README to the project rule: a sentence naming flood, discharge or runoff is a negation', () => {
    const result = runOf();
    const zip = buildFlowPulsePackage(result, {
      basename: 'flow', catchment: { mask: catchmentFrom(result, 7), outletCell: 7 },
      rainfall: { intensityMmH: 25, runoffC: 0.5 },
    });
    const flat = textOf(zip, 'flow-README.txt').replace(/\s+/g, ' ');
    for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
      if (/\b(flood|discharge|runoff)\b/i.test(sentence)) expect(sentence.toLowerCase(), sentence).toMatch(/\b(not|never|no)\b/);
    }
  });

  it('records the setting alone when nothing was selected', () => {
    const readme = textOf(buildFlowPulsePackage(runOf(), { basename: 'flow', rainfall: { intensityMmH: 25, runoffC: 0.2 } }), 'flow-README.txt');
    expect(readme).toContain('No outlet or path was selected, so no peak flow was estimated.');
    expect(readme).toContain('Coefficient C        0.2, set by hand');
  });
});
