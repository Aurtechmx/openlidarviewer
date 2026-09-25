/**
 * observatoryCoverageGain.test.ts — unit tests per requirement for phase O10:
 * `olv.observation.coverage-gain` (OB-GAIN-01/02/03/05),
 * `olv.observation.station-suggestion` (OB-GAIN-04/06, OB-INV-05) and the
 * shared incidence module (`incidence.ts`). F11/F12/F15 are scored in
 * `observatoryFixturesO10.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COVERAGE_GAIN_PARAMETERS,
  DEFAULT_GAIN_STATE_WEIGHTS,
  blocksPlanningRay,
  generateCandidates,
  isWeakSurface,
  planningAuthority,
  planningDirections,
  resolveInstrumentModel,
  scoreCandidate,
  traceCandidateVisibility,
  validateInstrumentModel,
  type CandidateVisibility,
  type ObservationInstrumentModel,
  type PlanningField,
} from '../src/observation/coverageGain';
import { suggestStations, SUGGESTED_STATION_LABEL, type ReachabilityProvider, type ReachabilityVerdict } from '../src/observation/stationSuggestion';
import {
  VoxelMomentAccumulator,
  fitNormalFromResidentPoints,
  incidenceCosine,
  medianCosine,
  normalAngleFromVerticalDegrees,
  normalFromCovariance,
  symmetricEigenvalues3,
} from '../src/observation/incidence';
import { symEig3 } from '../src/math/symEig3';
import * as strength from '../src/observation/strength';
import { domainGrid, packVoxelKey, type ObservationDomain, type ObservationLedgerRow } from '../src/observation/ledger';
import type { ObservationState } from '../src/observation/types';

type Vec3 = readonly [number, number, number];

const MODEL: ObservationInstrumentModel = {
  heightAboveSurface: 1,
  minRange: 0,
  maxRange: 50,
  verticalFieldOfViewDegrees: 90,
  angularStepDegrees: 5,
  sameAsSourceIndex: null,
};

function row(sources: number, hit: number, pass: number): Pick<ObservationLedgerRow, 'counters' | 'perSource'> {
  return {
    counters: { hit, pass, behind: 0, noReturn: 0, saturated: false },
    perSource: Array.from({ length: sources }, (_, sourceIndex) => ({ sourceIndex, hit, pass, behind: 0, noReturn: 0, saturated: false, notDecoded: false })),
  };
}

/** A small field: everything OBSERVED_EMPTY unless `paint` says otherwise. */
function field(domain: ObservationDomain, h: number, paint: (ix: number, iy: number, iz: number) => { state: ObservationState; row?: ReturnType<typeof row>; normal?: Vec3 } | null): PlanningField {
  const grid = domainGrid(domain, h);
  const stateByKey = new Map<number, ObservationState>();
  const rowByKey = new Map<number, ReturnType<typeof row>>();
  const normalByKey = new Map<number, Vec3>();
  for (let iz = 0; iz < grid.nz; iz++) for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
    const key = packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
    const p = paint(ix, iy, iz);
    stateByKey.set(key, p?.state ?? 'OBSERVED_EMPTY');
    if (p?.row) rowByKey.set(key, p.row);
    if (p?.normal) normalByKey.set(key, p.normal);
  }
  return { domain, voxelEdge: h, grid, stateByKey, rowByKey, normalByKey };
}

const PARAMS = { ...DEFAULT_COVERAGE_GAIN_PARAMETERS, p_solid: 0.9, candidateSpacing: 2 };

describe('incidence.ts — one incidence estimate for strength and Coverage Gain', () => {
  it('strength re-exports the same normal fit, not a copy', () => {
    expect(strength.fitNormalFromResidentPoints).toBe(fitNormalFromResidentPoints);
  });

  it('the closed-form eigen solve agrees with symEig3 on eigenvalues and the smallest eigenvector', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let k = 0; k < 500; k++) {
      // A near-planar neighbourhood with a random orientation, plus fully random covariances.
      const pts: number[] = [];
      const flat = k % 2 === 0;
      for (let i = 0; i < 12; i++) pts.push(rand() * 3, rand() * 2, flat ? rand() * 0.05 : rand());
      const a = rand() * Math.PI, b = rand() * Math.PI;
      const rot = (x: number, y: number, z: number): [number, number, number] => {
        const x1 = x * Math.cos(a) - y * Math.sin(a), y1 = x * Math.sin(a) + y * Math.cos(a);
        return [x1 * Math.cos(b) + z * Math.sin(b), y1, -x1 * Math.sin(b) + z * Math.cos(b)];
      };
      const P: number[] = [];
      for (let i = 0; i < pts.length; i += 3) P.push(...rot(pts[i]!, pts[i + 1]!, pts[i + 2]!));
      const n = P.length / 3;
      const m = [0, 1, 2].map((ax) => P.filter((_, i) => i % 3 === ax).reduce((s, v) => s + v, 0) / n);
      const c = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const d = [P[i * 3]! - m[0]!, P[i * 3 + 1]! - m[1]!, P[i * 3 + 2]! - m[2]!];
        c[0] += d[0]! * d[0]! / n; c[1] += d[0]! * d[1]! / n; c[2] += d[0]! * d[2]! / n;
        c[3] += d[1]! * d[1]! / n; c[4] += d[1]! * d[2]! / n; c[5] += d[2]! * d[2]! / n;
      }
      const ref = symEig3(c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!);
      const vals = symmetricEigenvalues3(c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!);
      for (let i = 0; i < 3; i++) expect(vals[i]).toBeCloseTo(ref.values[i]!, 10);
      const normal = normalFromCovariance(c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!)!;
      const v = ref.vectors[2];
      expect(Math.abs(normal[0] * v[0] + normal[1] * v[1] + normal[2] * v[2])).toBeCloseTo(1, 8);
    }
  });

  it('streamed voxel moments give the same normal as the index-list fit', () => {
    const pts = Float64Array.from([0, 0, 0, 1, 0, 0.1, 0, 1, -0.1, 1, 1, 0.05, 0.5, 0.3, 0.02]);
    const direct = fitNormalFromResidentPoints(pts, [0, 1, 2, 3, 4])!;
    const acc = new VoxelMomentAccumulator();
    for (let i = 0; i < 5; i++) acc.add(7, pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
    const streamed = acc.normals().get(7)!;
    const dot = Math.abs(direct[0] * streamed[0] + direct[1] * streamed[1] + direct[2] * streamed[2]);
    expect(dot).toBeCloseTo(1, 9);
  });

  it('a voxel with fewer than 3 points or collinear points has no normal', () => {
    const acc = new VoxelMomentAccumulator();
    acc.add(1, 0, 0, 0);
    acc.add(1, 1, 0, 0);
    for (let i = 0; i < 4; i++) acc.add(2, i, 0, 0);
    expect(acc.normals().size).toBe(0);
  });

  it('|cos i| is sign-free and clamped; the median averages the middle pair', () => {
    expect(incidenceCosine([0, 0, -1], [0, 0, 1])).toBe(1);
    expect(incidenceCosine([1, 0, 0], [0, 0, 1])).toBe(0);
    expect(medianCosine([0.2, 0.8, 0.4, 0.6])).toBeCloseTo(0.5, 12);
    expect(Number.isNaN(medianCosine([]))).toBe(true);
    expect(normalAngleFromVerticalDegrees([0, 0, -1])).toBeCloseTo(0, 9);
    expect(normalAngleFromVerticalDegrees([1, 0, 0])).toBeCloseTo(90, 9);
  });
});

describe('OB-GAIN-01 — instrument model', () => {
  it('refuses a model no planning ray can be built from', () => {
    expect(() => validateInstrumentModel({ ...MODEL, maxRange: 0 })).toThrow(/maxRange/);
    expect(() => validateInstrumentModel({ ...MODEL, minRange: 60 })).toThrow(/must exceed/);
    expect(() => validateInstrumentModel({ ...MODEL, angularStepDegrees: 0 })).toThrow(/angularStepDegrees/);
    expect(() => validateInstrumentModel({ ...MODEL, heightAboveSurface: Number.NaN })).toThrow(/heightAboveSurface/);
    expect(() => validateInstrumentModel(MODEL)).not.toThrow();
  });

  it('"same as source N" copies that source\'s declared parameters and records N', () => {
    const declared = { heightAboveSurface: 2, minRange: 1, maxRange: 80, verticalFieldOfViewDegrees: 300, angularStepDegrees: 2 };
    const resolved = resolveInstrumentModel({ ...MODEL, sameAsSourceIndex: 1 }, [null, declared]);
    expect(resolved).toEqual({ ...declared, sameAsSourceIndex: 1 });
  });

  it('"same as source N" refuses a source that declares nothing', () => {
    expect(() => resolveInstrumentModel({ ...MODEL, sameAsSourceIndex: 0 }, [null])).toThrow(/declares no instrument parameters/);
  });

  it('planning directions are unit vectors at bin centres inside the vertical field of view, never on an axis or a 45° diagonal', () => {
    const d = planningDirections(MODEL);
    expect(d.length / 3).toBe(72 * 18);
    for (let i = 0; i < d.length; i += 3) {
      const [x, y, z] = [d[i]!, d[i + 1]!, d[i + 2]!];
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      const el = (Math.asin(z) * 180) / Math.PI;
      expect(Math.abs(el)).toBeLessThan(45);
      expect(Math.abs(Math.abs(x) - Math.abs(y))).toBeGreaterThan(1e-6);
      expect(Math.abs(x)).toBeGreaterThan(1e-6);
      expect(Math.abs(y)).toBeGreaterThan(1e-6);
    }
  });
});

const GROUND_DOMAIN: ObservationDomain = { min: [0, 0, 0], max: [8, 8, 4] };

describe('OB-GAIN-02 — candidates', () => {
  const ground = (extra?: (ix: number, iy: number, iz: number) => ReturnType<Parameters<typeof field>[2]>) =>
    field(GROUND_DOMAIN, 1, (ix, iy, iz) => extra?.(ix, iy, iz) ?? (iz === 0 ? { state: 'SURFACE', row: row(1, 10, 0), normal: [0, 0, 1] } : null));

  it('one candidate per spacing cell, standing on level ground at instrument height, indexed in grid order', () => {
    const g = generateCandidates(ground(), MODEL, PARAMS);
    expect(g.candidates.length).toBe(16);
    expect(g.qualifyingCount).toBe(16);
    expect(g.droppedByCap).toBe(0);
    expect(g.candidates.map((c) => c.candidateIndex)).toEqual([...Array(16).keys()]);
    for (const c of g.candidates) expect(c.position[2]).toBe(0.5 + MODEL.heightAboveSurface);
    // Row-major over (y, x) cells, each keeping the voxel nearest its cell centre (ties to the lower key).
    expect(g.candidates[0]!.position.slice(0, 2)).toEqual([0.5, 0.5]);
    expect(g.candidates[1]!.position.slice(0, 2)).toEqual([2.5, 0.5]);
    expect(g.candidates[4]!.position.slice(0, 2)).toEqual([0.5, 2.5]);
  });

  it('a steep normal, a missing normal or a blocked column disqualifies the standing voxel', () => {
    const f = ground((ix, iy, iz) => {
      if (iz === 0 && ix < 2 && iy < 2) return { state: 'SURFACE', row: row(1, 10, 0), normal: [1, 0, 0] };
      if (iz === 0 && ix >= 6 && iy < 2) return { state: 'SURFACE', row: row(1, 10, 0) };
      if (iz === 1 && ix < 2 && iy >= 6) return { state: 'SURFACE', row: row(1, 10, 0), normal: [0, 0, 1] };
      return null;
    });
    const g = generateCandidates(f, MODEL, PARAMS);
    for (const c of g.candidates) {
      const [x, y] = c.position;
      expect(x < 2 && y < 2).toBe(false);
      expect(x >= 6 && y < 2).toBe(false);
      expect(x < 2 && y >= 6 && c.position[2] === 1.5).toBe(false);
    }
  });

  it('a PARTIAL voxel above passes the column test only when it would not stop a planning ray', () => {
    const f = (hit: number, pass: number) => ground((_ix, _iy, iz) => (iz === 1 ? { state: 'PARTIAL', row: row(1, hit, pass) } : null));
    expect(generateCandidates(f(1, 9), MODEL, PARAMS).candidates.length).toBe(16);
    expect(generateCandidates(f(3, 0), MODEL, PARAMS).candidates.length).toBe(0);
  });

  it('the cap keeps an evenly strided subset and records what it dropped', () => {
    const g = generateCandidates(ground(), MODEL, { ...PARAMS, candidateCap: 4 });
    expect(g.candidates.length).toBe(4);
    expect(g.cap).toBe(4);
    expect(g.droppedByCap).toBe(12);
    expect(g.candidates.map((c) => c.position.slice(0, 2))).toEqual([[0.5, 0.5], [0.5, 2.5], [0.5, 4.5], [0.5, 6.5]]);
  });
});

describe('OB-GAIN-03 — planning-ray visibility and gain terms', () => {
  const LINE: ObservationDomain = { min: [0, 0, 0], max: [10, 1, 1] };
  const oneRay: ObservationInstrumentModel = { ...MODEL, verticalFieldOfViewDegrees: 1, angularStepDegrees: 90 };
  // Explicit directions: one ray along +x down a 10x1x1 slab.
  const dirX = Float64Array.from([1, 0, 0]);

  it('SURFACE stops a ray and is itself visible; nothing behind it is', () => {
    const f = field(LINE, 1, (ix) => (ix === 4 ? { state: 'SURFACE', row: row(1, 10, 0) } : ix > 4 ? { state: 'SHADOWED' } : null));
    const v = traceCandidateVisibility(f, 0, [0.5, 0.5, 0.5], oneRay, 0.9, dirX);
    expect([...v.keys]).toEqual([0, 1, 2, 3, 4]);
  });

  it('PARTIAL stops a ray only when its hit fraction reaches p_solid', () => {
    expect(blocksPlanningRay('PARTIAL', row(1, 9, 1), 0.9)).toBe(true);
    expect(blocksPlanningRay('PARTIAL', row(1, 1, 4), 0.9)).toBe(false);
    expect(blocksPlanningRay('SURFACE', undefined, 0.9)).toBe(true);
    expect(blocksPlanningRay('CONFLICT', row(2, 10, 10), 0.9)).toBe(false);
    const passing = field(LINE, 1, (ix) => (ix === 2 ? { state: 'PARTIAL', row: row(1, 1, 4) } : { state: 'SHADOWED' }));
    expect(traceCandidateVisibility(passing, 0, [0.5, 0.5, 0.5], oneRay, 0.9, dirX).keys.length).toBe(10);
  });

  it('min and max range bound the ray', () => {
    const f = field(LINE, 1, () => ({ state: 'SHADOWED' }));
    const v = traceCandidateVisibility(f, 0, [0.5, 0.5, 0.5], { ...oneRay, minRange: 2, maxRange: 5 }, 0.9, dirX);
    expect([...v.keys]).toEqual([2, 3, 4, 5]);
  });

  it('every state weight, the incidence term, redundancy and NOT_READ are reported separately', () => {
    const states: ObservationState[] = ['SHADOWED', 'UNADDRESSED', 'NO_RETURN_PATH', 'CONFLICT', 'SURFACE', 'NOT_READ', 'OBSERVED_EMPTY', 'PARTIAL', 'SURFACE', 'SHADOWED'];
    const f = field(LINE, 1, (ix) => {
      if (ix === 4) return { state: 'SURFACE', row: row(1, 10, 0), normal: [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3), 0] };
      if (ix === 8) return { state: 'SURFACE', row: row(2, 10, 0) };
      if (ix === 7) return { state: 'PARTIAL', row: row(1, 1, 4) };
      return { state: states[ix]! };
    });
    const vis: CandidateVisibility = { candidateIndex: 3, keys: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), incidence: Float64Array.from([1, 1, 1, 1, 0.5, 1, 1, 1, 1, 1]), rayCount: 1 };
    const t = scoreCandidate(f, vis, PARAMS);
    expect(t.weightedCounts).toEqual({ SHADOWED: 2, UNADDRESSED: 1, NO_RETURN_PATH: 1, CONFLICT: 1, WEAK_SURFACE: 1 });
    // 1 + 1 + 0.25 + 0.5 + 0.5*0.5 (weak surface at incidence 0.5) + 1 (second SHADOWED)
    expect(t.weightedVisibilitySum).toBeCloseTo(4, 12);
    expect(t.redundantCount).toBe(1); // the strong SURFACE seen by two sources
    expect(t.redundantPenalty).toBeCloseTo(PARAMS.redundancyWeight, 12);
    expect(t.gain).toBeCloseTo(4 - PARAMS.redundancyWeight, 12);
    expect(t.excludedVoxelCount).toBe(1);
    expect(t.visibleVoxelCount).toBe(10);
  });

  it('the incidence term is the best |cos i| over the rays reaching a voxel with a normal, 1 otherwise', () => {
    const f = field(LINE, 1, (ix) => (ix === 3 ? { state: 'SURFACE', row: row(1, 10, 0), normal: [1, 0, 0] } : null));
    const dirs = Float64Array.from([1, 0, 0, Math.cos(0.1), Math.sin(0.1), 0]);
    const v = traceCandidateVisibility(f, 0, [0.5, 0.5, 0.5], oneRay, 0.9, dirs);
    const i = [...v.keys].indexOf(3);
    expect(v.incidence[i]).toBe(1);
    expect(v.incidence[0]).toBe(1);
  });

  it('weak SURFACE follows the declared floors on sources and consistency', () => {
    const floors = PARAMS.weakSurfaceFloors;
    expect(isWeakSurface(row(1, 10, 0), floors)).toBe(true);
    expect(isWeakSurface(row(2, 10, 0), floors)).toBe(false);
    expect(isWeakSurface(row(2, 8, 2), floors)).toBe(true);
    expect(isWeakSurface(undefined, floors)).toBe(true);
  });

  it('default weights are SPEC §5.6 OB-GAIN-03 exactly', () => {
    expect(DEFAULT_GAIN_STATE_WEIGHTS).toEqual({ SHADOWED: 1.0, UNADDRESSED: 1.0, NO_RETURN_PATH: 0.25, CONFLICT: 0.5, WEAK_SURFACE: 0.5 });
  });
});

describe('OB-GAIN-04 — greedy selection against a hypothetical copy', () => {
  const LINE: ObservationDomain = { min: [0, 0, 0], max: [10, 1, 1] };
  const f = field(LINE, 1, () => ({ state: 'SHADOWED' }));
  const vis = (i: number, keys: number[]): CandidateVisibility => ({ candidateIndex: i, keys: Float64Array.from(keys), incidence: new Float64Array(keys.length).fill(1), rayCount: 1 });

  it('re-scores the rest against what earlier picks already reach', () => {
    const r = suggestStations(f, [vis(0, [0, 1, 2, 3, 4, 5]), vis(1, [0, 1, 2, 3, 4]), vis(2, [6, 7, 8])], { ...PARAMS, redundancyWeight: 0 }, 2);
    expect(r.selectedCandidateIndices).toEqual([0, 2]);
    expect(r.gainAtSelection).toEqual([6, 3]);
    expect(r.termsAtSelection[1]!.redundantCount).toBe(0);
    expect(r.stopReason).toBe('declared-count-reached');
  });

  it('breaks ties by candidate index', () => {
    const r = suggestStations(f, [vis(0, [0, 1]), vis(1, [2, 3])], PARAMS, 1);
    expect(r.selectedCandidateIndices).toEqual([0]);
  });

  it('stops early when no remaining candidate adds coverage', () => {
    const r = suggestStations(f, [vis(0, [0, 1, 2]), vis(1, [0, 1])], PARAMS, 3);
    expect(r.selectedCandidateIndices).toEqual([0]);
    expect(r.stopReason).toBe('no-positive-gain');
    expect(suggestStations(f, [], PARAMS, 2).stopReason).toBe('no-candidates');
  });

  it('refuses a non-positive or fractional station count', () => {
    expect(() => suggestStations(f, [], PARAMS, 0)).toThrow(/stationCount/);
    expect(() => suggestStations(f, [], PARAMS, 1.5)).toThrow(/stationCount/);
  });

  it('never writes to the canonical state map (OB-INV-05)', () => {
    const before = [...f.stateByKey];
    suggestStations(f, [vis(0, [0, 1, 2]), vis(1, [3, 4])], PARAMS, 2);
    expect([...f.stateByKey]).toEqual(before);
  });

  it('labels a suggestion as not observed', () => {
    expect(SUGGESTED_STATION_LABEL).toBe('SUGGESTED STATION (not observed)');
  });
});

describe('OB-GAIN-05 — planning authority', () => {
  it('measured only over basis full, nothing unread and declared origins', () => {
    expect(planningAuthority('full', [{ id: 's1', originStatus: 'DECLARED' }], 0)).toEqual({ authority: 'measured', reasons: [] });
  });

  it('preview otherwise, naming every reason', () => {
    const v = planningAuthority('resident-only', [{ id: 's1', originStatus: 'ASSUMED' }, { id: 's2', originStatus: 'RECONSTRUCTED_STRONG' }], 3);
    expect(v.authority).toBe('preview');
    expect(v.reasons).toEqual(['basis resident-only', '3 voxel(s) not read in this load', 'assumed origin: s1', 'reconstructed origin: s2']);
  });
});

describe('OB-GAIN-06 — ReachabilityProvider interface only', () => {
  it('a conforming provider always carries an evidence reference', () => {
    const provider: ReachabilityProvider = {
      verdictAt: (position) => ({ verdict: (position[2] > 0 ? 'reachable' : 'unknown') as ReachabilityVerdict, evidenceRef: 'fixture:flat-ground' }),
    };
    const verdict = provider.verdictAt([0, 0, 1]);
    expect(['reachable', 'unreachable', 'unknown']).toContain(verdict.verdict);
    expect(verdict.evidenceRef.length).toBeGreaterThan(0);
  });
});
