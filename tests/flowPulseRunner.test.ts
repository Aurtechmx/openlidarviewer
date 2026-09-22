/**
 * flowPulseRunner.test.ts: a run either happens or says why it did not.
 *
 * The runner is the seam a panel calls, so the properties that matter are the
 * ones a panel would otherwise have to get right by itself:
 *
 *   a precondition failure is a typed refusal, never a half-filled result;
 *   an unresolved scale withholds metres instead of refusing or fabricating;
 *   conditioning routes over a second surface and leaves the DTM alone;
 *   the limitations a reader sees follow from the run, not from a fixed list.
 *
 * Each is checked against a terrain whose answer can be read by eye, so a
 * wrong figure is visible rather than merely different from a recorded one.
 */
import { describe, expect, it } from 'vitest';

import {
  FLOW_PULSE_DEFAULTS,
  catchmentFrom,
  methodsFor,
  pulseFrom,
  runFlowPulse,
  type FlowPulseParams,
  type FlowRunIdentity,
} from '../src/simulation/flowPulse/flowPulseRunner';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const projected: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true,
};

const identity: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: '0.7.0-alpha.1', id: 'run-1',
  generatedAt: '2026-09-22T00:00:00.000Z', processingManifestHead: null,
};

/** A filled DtmGrid; `null` marks a cell with no reachable data. */
function dtmOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<DtmGrid> = {},
): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      coverage[r * w + c] = 2; // measured
    }
  }
  return {
    z, coverage, confidence: new Float32Array(n), counts: new Uint32Array(n),
    interpDistanceCells: new Float32Array(n), cols: w, rows: h, cellSizeM: 1,
    originH1: 0, originH2: 0, crs: null, verticalDatum: null, coverageMode: 'full',
    ...over,
  } as DtmGrid;
}

const params = (over: Partial<FlowPulseParams> = {}): FlowPulseParams => ({
  ...FLOW_PULSE_DEFAULTS, ...over,
});

/** A pit inside a rim with one notch, so the fill level is readable by eye. */
const notchedBowl = () => dtmOf([
  [5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5],
]);

describe('a precondition failure is a refusal, not a result', () => {
  it('refuses with NO_DTM when no terrain was supplied', () => {
    const r = runFlowPulse(null, projected, params(), identity);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_DTM');
    expect(r.reason).toMatch(/terrain analysis/i);
  });

  it('refuses with TOO_LARGE rather than routing an unbudgeted grid', () => {
    const r = runFlowPulse(dtmOf([[1, 2], [3, 4]]), projected, params({ maxCells: 3 }), identity);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TOO_LARGE');
    // The reason names both numbers, so a reader knows how far over it is.
    expect(r.reason).toMatch(/4 cells/);
    expect(r.reason).toMatch(/3 this run allows/);
  });

  it('refuses with NO_VALID_CELL when nothing is readable', () => {
    const r = runFlowPulse(dtmOf([[null, null]]), projected, params(), identity);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_VALID_CELL');
  });

  it('names the policy that emptied the grid when blocking did it', () => {
    // Interpolated-only terrain with `block` has nothing measured left. The
    // reason must point at the setting rather than blame the data.
    const n = 2;
    const dtm = dtmOf([[1, 2]]);
    (dtm.coverage as Uint8Array).fill(1); // all interpolated
    const r = runFlowPulse(dtm, projected, params({ interpolated: 'block' }), identity);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_VALID_CELL');
    expect(r.reason).toMatch(/Allow interpolated cells/);
    expect(n).toBe(2);
  });
});

describe('a completed run', () => {
  it('routes a plane and reports its outlets', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1, 0], [3, 2, 1, 0]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.cells).toBe(8);
    expect(r.summary.readableCells).toBe(8);
    expect(r.summary.sinkCount).toBe(0);
    expect(r.summary.outletCount).toBe(2); // the east column leaves the grid
    expect(r.summary.maxUpstreamCells).toBe(4);
  });

  it('seals a record whose digest covers the figures, and result carries a field digest too', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.record.kind).toBe('terrain-flow');
    expect(r.record.result).toEqual({ ...r.summary, fieldDigest: r.record.result.fieldDigest });
    expect(r.record.result.fieldDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names every method it ran, conditioning included', () => {
    expect(methodsFor(params())).toEqual([
      'olv.simulation.terrain-flow.d8',
      'olv.simulation.terrain-flow.accumulation',
    ]);
    expect(methodsFor(params({ conditioning: 'priority-flood' }))[0])
      .toBe('olv.simulation.terrain-flow.priority-flood');
    expect(methodsFor(params({ conditioning: 'priority-flood', fillNoData: 'outlet' }))[0])
      .toBe('olv.simulation.terrain-flow.priority-flood.gap-outlet');
  });
});

describe('the field digest binds the actual flow field, not only its summary', () => {
  // A square ramp falling east and the same ramp turned to fall south instead.
  // Both are monotonic in one direction: no sinks, no flats, one outlet edge,
  // so cells, readableCells, sinkCount, flatCount, outletCount and
  // maxUpstreamCells all come out identical. The receiver, direction and
  // status arrays do not: the outlet cells sit on opposite edges of the grid.
  const rampEast = () => dtmOf([[3, 2, 1], [3, 2, 1], [3, 2, 1]]);
  const rampSouth = () => dtmOf([[3, 3, 3], [2, 2, 2], [1, 1, 1]]);

  it('confirms the two terrains share one summary before comparing digests', () => {
    const east = runFlowPulse(rampEast(), projected, params(), identity);
    const south = runFlowPulse(rampSouth(), projected, params(), identity);
    expect(east.ok && south.ok).toBe(true);
    if (!east.ok || !south.ok) return;
    expect(east.summary).toEqual(south.summary);
  });

  it('seals two summary-identical, field-different runs to different record digests', () => {
    const east = runFlowPulse(rampEast(), projected, params(), identity);
    const south = runFlowPulse(rampSouth(), projected, params(), identity);
    expect(east.ok && south.ok).toBe(true);
    if (!east.ok || !south.ok) return;
    expect(east.record.result.fieldDigest).not.toBe(south.record.result.fieldDigest);
    expect(east.record.digest).not.toBe(south.record.digest);
  });

  it('gives one terrain the same field digest on a re-run', () => {
    const a = runFlowPulse(rampEast(), projected, params(), identity);
    const b = runFlowPulse(rampEast(), projected, params(), identity);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.result.fieldDigest).toBe(b.record.result.fieldDigest);
    expect(a.record.digest).toBe(b.record.digest);
  });

  it('gives a raw run and a conditioned run over the same terrain different field digests', () => {
    const raw = runFlowPulse(notchedBowl(), projected, params({ conditioning: 'raw' }), identity);
    const flooded = runFlowPulse(notchedBowl(), projected, params({ conditioning: 'priority-flood' }), identity);
    expect(raw.ok && flooded.ok).toBe(true);
    if (!raw.ok || !flooded.ok) return;
    expect(raw.record.result.fieldDigest).not.toBe(flooded.record.result.fieldDigest);
  });
});

describe('an unresolved scale withholds metres and still routes', () => {
  const unresolved: HorizontalScale = { ...projected, resolved: false };

  it('withholds contributing area rather than refusing', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), unresolved, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contributingAreaM2).toBeNull();
    expect(r.summary.maxContributingAreaM2).toBeNull();
    // Direction survives: cell counts are still reported.
    expect(r.summary.maxUpstreamCells).toBe(3);
    expect(r.limitations.join(' ')).toMatch(/withheld/);
  });

  it('reports square metres once the scale is known', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.maxContributingAreaM2).toBeCloseTo(3, 10);
  });
});

describe('a geographic frame with no latitude is refused', () => {
  const geographic: HorizontalScale = {
    isGeographic: true, latitudeDeg: null, unitToMetres: 1, resolved: false,
  };

  it('refuses with UNITS_UNRESOLVED rather than routing over a guessed cell shape', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), geographic, params(), identity);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('UNITS_UNRESOLVED');
    expect(r.reason).toMatch(/latitude/i);
  });

  it('routes a geographic frame once its latitude is known', () => {
    const r = runFlowPulse(
      dtmOf([[3, 2, 1]]), { ...geographic, latitudeDeg: 40, resolved: true }, params(), identity,
    );
    expect(r.ok).toBe(true);
  });

  it('still routes a projected frame whose unit is unresolved', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), { ...projected, resolved: false }, params(), identity);
    expect(r.ok).toBe(true);
  });
});

describe('conditioning is declared, and leaves the DTM alone', () => {
  it('raw mode keeps the pit and says so', () => {
    const dtm = notchedBowl();
    const before = Float32Array.from(dtm.z);
    const r = runFlowPulse(dtm, projected, params({ conditioning: 'raw' }), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.sinkCount).toBe(1);
    expect(r.summary.cellsRaised).toBeNull();
    expect(r.limitations.join(' ')).toMatch(/leaves real depressions in place/);
    expect([...dtm.z]).toEqual([...before]);
  });

  it('conditioned mode drains the pit and reports what it raised', () => {
    const dtm = notchedBowl();
    const before = Float32Array.from(dtm.z);
    const r = runFlowPulse(dtm, projected, params({ conditioning: 'priority-flood' }), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.sinkCount).toBe(0);
    expect(r.summary.cellsRaised).toBeGreaterThan(0);
    expect(r.limitations.join(' ')).toMatch(/conditioned drainage surface/);
    expect(r.limitations.join(' ')).toMatch(/canonical DTM is unchanged/);
    // The claim in that sentence, checked rather than trusted.
    expect([...dtm.z]).toEqual([...before]);
  });

  it('never calls the conditioned surface corrected terrain', () => {
    const r = runFlowPulse(notchedBowl(), projected, params({ conditioning: 'priority-flood' }), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.limitations.join(' ')).not.toMatch(/corrected terrain/i);
  });
});

/** A surface falling east with a survey hole beside a two-cell depression. */
const holeSlope = () => dtmOf([
  [10, 9, 8, 7, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
  [10, 4, 3, null, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
]);

/** Nine measured cells inside a closed ring of NoData. */
const island = () => dtmOf([
  [9, 9, 9, 9, 9, 9, 9],
  [9, null, null, null, null, null, 9],
  [9, null, 5, 5, 5, null, 9],
  [9, null, 5, 1, 5, null, 9],
  [9, null, 5, 5, 5, null, 9],
  [9, null, null, null, null, null, 9],
  [9, 9, 9, 9, 9, 9, 9],
]);

describe('conditioning reads NoData as routing does, unless told otherwise', () => {
  const flood = (over: Partial<FlowPulseParams> = {}) => params({ conditioning: 'priority-flood', ...over });

  it('defaults to the wall', () => {
    expect(FLOW_PULSE_DEFAULTS.fillNoData).toBe('wall');
  });

  it('fills a depression beside a survey hole and routes it out past the hole', () => {
    const r = runFlowPulse(holeSlope(), projected, flood(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.sinkCount).toBe(0);
    expect(r.summary.cellsRaised).toBe(2);
    expect(r.summary.cellsUnreachable).toBe(0);
    expect(r.record.parameters.fillNoData).toBe('wall');
    expect(r.record.methods[0]).toBe('olv.simulation.terrain-flow.priority-flood');
  });

  it('counts an enclosed island and says it was left as it is', () => {
    const r = runFlowPulse(island(), projected, flood(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.cellsUnreachable).toBe(9);
    expect(r.record.result.cellsUnreachable).toBe(9);
    // The pit inside the island is still a sink, and the limitation says why.
    expect(r.summary.sinkCount).toBe(1);
    expect(r.limitations.join(' ')).toMatch(/9 cell\(s\) are enclosed by NoData/);
  });

  it('declares a gap read as a drainage exit in the parameters, methods and limitations', () => {
    const r = runFlowPulse(holeSlope(), projected, flood({ fillNoData: 'outlet' }), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.cellsRaised).toBe(0);
    expect(r.summary.sinkCount).toBe(1);
    expect(r.record.parameters.fillNoData).toBe('outlet');
    expect(r.record.methods[0]).toBe('olv.simulation.terrain-flow.priority-flood.gap-outlet');
    expect(r.limitations.join(' ')).toMatch(/drainage exit/);
  });

  it('records two readings of one terrain as two computations', () => {
    const wall = runFlowPulse(holeSlope(), projected, flood(), identity);
    const outlet = runFlowPulse(holeSlope(), projected, flood({ fillNoData: 'outlet' }), identity);
    expect(wall.ok && outlet.ok).toBe(true);
    if (!wall.ok || !outlet.ok) return;
    expect(wall.record.digest).not.toBe(outlet.record.digest);
  });

  it('leaves the reading out of a raw run, where nothing reads it', () => {
    const r = runFlowPulse(holeSlope(), projected, params({ fillNoData: 'outlet' }), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.parameters.fillNoData).toBeNull();
    expect(r.summary.cellsUnreachable).toBeNull();
    expect(r.record.methods).not.toContain('olv.simulation.terrain-flow.priority-flood.gap-outlet');
  });
});

describe('the limitations follow the run', () => {
  it('always states that accumulation is not water', () => {
    const r = runFlowPulse(dtmOf([[2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.limitations.join(' ');
    expect(all).toMatch(/not rainfall, runoff, infiltration or flood modelling/);
    expect(all).toMatch(/counts cells/);
  });

  it('reports an undeclared Withheld handling, since nothing applies the policy', () => {
    const r = runFlowPulse(dtmOf([[2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.limitations.join(' ')).toMatch(/Withheld/);
  });

  it('says nothing about flats when the surface has none', () => {
    const r = runFlowPulse(dtmOf([[3, 2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.limitations.join(' ')).not.toMatch(/unresolved/);
  });
});

describe('queries over a completed run', () => {
  it('traces a pulse downstream to the outlet', () => {
    const r = runFlowPulse(dtmOf([[4, 3, 2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...pulseFrom(r, 0)]).toEqual([0, 1, 2, 3]);
  });

  it('collects the catchment of an outlet', () => {
    const r = runFlowPulse(dtmOf([[4, 3, 2, 1]]), projected, params(), identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...catchmentFrom(r, 3)].filter((v) => v === 1)).toHaveLength(4);
  });
});
