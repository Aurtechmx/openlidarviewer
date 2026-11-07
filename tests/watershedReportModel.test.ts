/**
 * watershedReportModel.test.ts: the report model composes the catchment
 * measures, picks which catchments to print, and decides whether the run may
 * be exported at all. Grids are drawn by hand so each answer can be read off.
 */
import { describe, expect, it } from 'vitest';
import { FLOW_PULSE_DEFAULTS, runFlowPulse, type FlowPulseResult } from '../src/simulation/flowPulse/flowPulseRunner';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import {
  buildWatershedReportModel,
  watershedReportGate,
  type ReportOutlet,
} from '../src/simulation/flowPulse/watershed/watershedReportModel';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { edgeContamination } from '../src/simulation/flowPulse/edgeContamination';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const W = 20;
const H = 20;

function grid(f: (c: number, r: number) => number): ReturnType<typeof flowDtmOf> {
  return flowDtmOf(Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => f(c, r))));
}

function run(dtm: DtmGrid, scale: HorizontalScale = FLOW_PROJECTED_SCALE, over = {}): FlowPulseResult {
  const r = runFlowPulse(dtm, scale, { ...FLOW_PULSE_DEFAULTS, ...over }, FLOW_TEST_IDENTITY);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

/** Every row drains west to its own border cell: twenty open watersheds of 20 cells. */
const plane = () => grid((c) => c + 10);
/** The left half drains west row by row into complete 11-cell watersheds; the right half is one big open watershed. */
const twoPlanes = () => grid((c, r) => (c < 10 ? c + 10 : 40 - c + r * 0.01));

const FIXED = new Date('2026-10-25T12:00:00Z');
function build(result: FlowPulseResult, dtm: DtmGrid, outlets: ReportOutlet[], over: Record<string, unknown> = {}) {
  return buildWatershedReportModel({
    result, dtm, outlets, language: 'en', title: 'Site', thresholdM2: 2500,
    verticalToMetres: 1, originZ: 100, crsName: 'EPSG:32610', generatedAt: FIXED,
    software: 'OpenLiDARViewer test', sourceSha256: null, ...over,
  });
}

describe('watershedReportGate', () => {
  it('refuses incomplete coverage, unresolved scale, raw routing and a missing run', () => {
    const ok = run(plane());
    expect(watershedReportGate(ok, 'priority-flood')).toEqual({ ok: true });
    const partial = { ...ok, basis: { ...ok.basis, complete: false } } as FlowPulseResult;
    expect(watershedReportGate(partial, 'priority-flood')).toEqual({ ok: false, reason: 'incomplete-coverage' });
    const unscaled = { ...ok, basis: { ...ok.basis, horizontalScaleResolved: false } } as FlowPulseResult;
    expect(watershedReportGate(unscaled, 'priority-flood')).toEqual({ ok: false, reason: 'scale-unresolved' });
    expect(watershedReportGate(ok, 'raw')).toEqual({ ok: false, reason: 'raw-routing' });
    expect(watershedReportGate(null, 'priority-flood')).toEqual({ ok: false, reason: 'no-run' });
  });
});

describe('selection', () => {
  it('uses the picked outlets in order with their labels', () => {
    const dtm = plane();
    const m = build(run(dtm), dtm, [
      { cell: 5 * W, label: 'C1', snappedFromCell: null },
      { cell: 2 * W, label: 'Gauge', snappedFromCell: 7 },
    ]);
    expect(m.sections.map((s) => s.label)).toEqual(['C1', 'Gauge']);
    expect(m.sections.map((s) => s.outlet)).toEqual([5 * W, 2 * W]);
    expect(m.sections.every((s) => !s.automatic)).toBe(true);
    expect(m.sections[0].mask[5 * W + 3]).toBe(1);
    expect(m.sections[0].mask[2 * W + 3]).toBe(0);
    expect(m.sections[0].downstreamPathCells[0]).toBe(5 * W);
  });

  it('selects complete watersheds before open ones when none were picked', () => {
    const dtm = twoPlanes();
    const result = run(dtm);
    const m = build(result, dtm, []);
    expect(m.sections).toHaveLength(3);
    expect(m.sections.every((s) => s.automatic)).toBe(true);
    for (const s of m.sections) {
      expect(s.quality.complete).toBe(true);
      const id = m.partition.label[s.outlet];
      expect(s.label).toBe(`W${id}`);
    }
    // the big open watershed is not chosen while complete ones remain
    const big = m.partition.watersheds.find((w) => !w.complete && w.cells > 100)!;
    expect(m.sections.map((s) => m.partition.label[s.outlet])).not.toContain(big.id);
  });

  it('selects the largest open watersheds when every watershed is open, and none is supported', () => {
    const dtm = plane();
    const m = build(run(dtm), dtm, []);
    expect(m.sections).toHaveLength(3);
    expect(m.sections.map((s) => s.label)).toEqual(['W1', 'W2', 'W3']);
    for (const s of m.sections) {
      expect(s.quality.complete).toBe(false);
      expect(s.quality.verdict).not.toBe('supported');
    }
  });
});



describe('check on site', () => {
  /** Row 10 falls west with a deep pit at col 12 and a shallow one at col 5. */
  const pitted = () => grid((c, r) => {
    if (r === 10 && c === 12) return 0;
    if (r === 10 && c === 5) return 12;
    return c + 10;
  });

  it('flags the largest depression on the main channel', () => {
    const dtm = pitted();
    const result = run(dtm);
    const m = build(result, dtm, [{ cell: 10 * W, label: 'C1', snappedFromCell: null }]);
    const s = m.sections[0];
    expect(s.depressions.length).toBeGreaterThan(0);
    expect(s.depressions.some((d) => d.onMainChannel)).toBe(true);
    expect(s.checkOnSite).not.toBeNull();
    const onChannel = s.depressions.filter((d) => d.onMainChannel);
    const biggest = Math.max(...onChannel.map((d) => d.cells));
    expect(s.checkOnSite!.cells).toBe(biggest);
    expect(onChannel.map((d) => d.seedCell)).toContain(s.checkOnSite!.seedCell);
  });

  it('names only a hollow that has a cell on the main channel', () => {
    const dtm = pitted();
    const m = build(run(dtm), dtm, [{ cell: 10 * W, label: 'C1', snappedFromCell: null }]);
    for (const s of m.sections) {
      const channel = new Set(s.channel.cells);
      for (const d of s.depressions) {
        if (d.onMainChannel) expect(d.onFlowLine).toBe(true);
        if (!d.onFlowLine) expect(d.onMainChannel).toBe(false);
      }
      if (s.checkOnSite !== null) {
        const named = s.depressions.find((d) => d.seedCell === s.checkOnSite!.seedCell)!;
        expect(named.onMainChannel).toBe(true);
        expect(channel.size).toBeGreaterThan(0);
      }
    }
  });

  it('is null for a catchment with no depression', () => {
    const dtm = pitted();
    const m = build(run(dtm), dtm, [{ cell: 3 * W, label: 'C1', snappedFromCell: null }]);
    expect(m.sections[0].depressions).toEqual([]);
    expect(m.sections[0].checkOnSite).toBeNull();
  });
});

describe('vertical figures', () => {
  it('withholds vertical figures and marks elevations relative when the vertical unit or origin is unknown', () => {
    const dtm = twoPlanes();
    const result = run(dtm);
    const pick = [{ cell: 20, label: 'C1', snappedFromCell: null }];
    const known = build(result, dtm, pick);
    expect(known.site.elevationsRelative).toBe(false);
    expect(known.site.verticalResolved).toBe(true);
    expect('value' in known.sections[0].morph.reliefM).toBe(true);

    const noUnit = build(result, dtm, pick, { verticalToMetres: null });
    expect(noUnit.site.verticalResolved).toBe(false);
    expect(noUnit.sections[0].morph.reliefM).toEqual({ withheld: 'vertical-unresolved' });

    const noOrigin = build(result, dtm, pick, { originZ: null });
    expect(noOrigin.site.elevationsRelative).toBe(true);
    expect(noOrigin.sections[0].morph.elevationsRelative).toBe(true);
  });
});

describe('site and provenance', () => {
  it('carries the run digests, the method ids and the site figures', () => {
    const dtm = plane();
    const result = run(dtm);
    const m = build(result, dtm, [], { sourceSha256: 'abc' });
    expect(m.provenance.runDigest).toBe(result.record.digest);
    expect(m.provenance.fieldDigest).toBe(String(result.record.result.fieldDigest));
    expect(m.provenance.sourceSha256).toBe('abc');
    expect(m.provenance.generatedAt).toBe(FIXED);
    expect(m.provenance.methodIds).toEqual(expect.arrayContaining([
      ...result.record.methods,
      'olv.simulation.terrain-flow.watersheds',
      'olv.simulation.terrain-flow.catchment-quality',
      'olv.simulation.terrain-flow.narrative',
    ]));
    expect(m.site.analysedAreaM2).toBe(400);
    expect(m.site.cellSizeM).toEqual([1, 1]);
    expect(m.site.measuredShare).toBe(1);
    expect(m.site.crsName).toBe('EPSG:32610');
    expect(m.network.thresholdM2).toBe(2500);
  });
});

describe('touching depressions', () => {
  it('treat touching pits as one depression and flag a separate off-channel pit as not on the channel', () => {
    // Row 10 falls west; two touching pits at cols 12-13 on the channel; a lone pit on row 14 (a different row).
    const dtm = grid((c, r) => {
      if (r === 10 && (c === 12 || c === 13)) return 0;
      if (r === 14 && c === 8) return 0;
      return c + 10;
    });
    const m = build(run(dtm), dtm, [{ cell: 10 * W, label: 'C1', snappedFromCell: null }]);
    const s = m.sections[0];
    expect(s.depressions.filter((d) => d.onMainChannel)).toHaveLength(1);
    expect(s.depressions.every((d) => s.mask[d.seedCell] === 1)).toBe(true);
    expect(s.depressions.filter((d) => !d.onMainChannel).every((d) => d.seedCell !== s.checkOnSite!.seedCell)).toBe(true);
  });
});

describe('edge selections', () => {
  it('gives no sections when every watershed is minor', () => {
    // 120 rows of 3 cells: each watershed is 0.8 percent of the grid, under the 0.01 minimum.
    const dtm = flowDtmOf(Array.from({ length: 120 }, (_, r) => Array.from({ length: 3 }, (_, c) => c + 10 + r * 0)));
    const m = build(run(dtm), dtm, []);
    expect(m.partition.watersheds.every((w) => w.minor)).toBe(true);
    expect(m.sections).toEqual([]);
  });

  it('follows the outlet\'s own contamination for a nested outlet', () => {
    const dtm = plane();
    const result = run(dtm);
    // the border terminal is open; a cell upstream whose row inflow is only interior is still routed from the border row.
    const up = build(result, dtm, [{ cell: 5 * W + 10, label: 'C1', snappedFromCell: null }]).sections[0];
    const edge = edgeContaminationOf(result);
    expect(up.quality.complete).toBe(edge[5 * W + 10] === 0);
  });

  it('refuses an outlet on a NoData cell', () => {
    const rows = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => (r === 8 && c === 8 ? null : c + 10)));
    const dtm = flowDtmOf(rows);
    expect(() => build(run(dtm), dtm, [{ cell: 8 * W + 8, label: 'C1', snappedFromCell: null }])).toThrow(RangeError);
  });
});

function edgeContaminationOf(result: FlowPulseResult): Uint8Array {
  return edgeContamination(result.grid, result.routed).contaminated;
}

describe('section geometry', () => {
  it('places the high point upslope and the downstream path toward the data edge', () => {
    const dtm = plane();
    const result = run(dtm);
    const outlet = 5 * W + 5;
    const g = build(result, dtm, [{ cell: outlet, label: 'C1', snappedFromCell: null }]).sections[0].geometry;
    expect(g.highPoint.dxM).toBeGreaterThan(0);
    expect(g.highPoint.dyM).toBe(0);
    expect(g.downstream).not.toBeNull();
    expect(g.downstream!.dxM).toBeLessThan(0);
    expect(g.downstream!.lengthM).toBeGreaterThan(0);
  });
});
