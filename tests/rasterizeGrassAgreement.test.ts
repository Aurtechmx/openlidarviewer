/**
 * rasterizeGrassAgreement.test.ts: OLV's per-cell rasterisation against GRASS
 * `r.in.xyz`, over cells that hold about nine returns each.
 *
 * The candidates are `rasterizeDtm` and `buildDsm`, the production functions.
 * Nothing here recomputes a bin or a reduction; a harness that did would be
 * comparing the formula to itself.
 *
 * WHY THIS EXISTS ALONGSIDE THE PDAL LEG. The DTM and DSM claims already carry
 * a PDAL `writers.gdal` comparison, and that comparison was run with
 * `radius: 0.45` against `resolution: 1` over fixtures holding one return per
 * cell centre. A radius below half a cell means each output cell sees the one
 * return that belongs to it, so mean, min and max are the same number and the
 * result speaks to grid origin, cell indexing and row order. That is worth
 * testing and its own record says exactly that. It is not a test of how many
 * returns inside one cell are reduced to one elevation, which is what this file
 * measures.
 *
 * References are committed, so this runs where GRASS is not installed.
 * Regenerating them is a separate job:
 *
 *   node validation/external-oracles/rasterize/make-fixtures.mjs
 *   GRASSBIN=... node validation/external-oracles/rasterize/run-grass.mjs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDsm } from '../src/terrain/surface/buildDsm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/external-oracles/rasterize');

interface GridSpec {
  originH1: number;
  originH2: number;
  cols: number;
  rows: number;
  cellSizeM: number;
}
interface Case {
  id: string;
  why: string;
  pointsFile: string;
  pointCount: number;
  pointsSha256: string;
  filledCells: number;
  emptyCells: number;
  meanPointsPerFilledCell: number;
  maxPointsInOneCell: number;
}
interface Fixtures {
  grid: GridSpec;
  cases: Case[];
}
interface GrassResult {
  id: string;
  pointsSha256: string;
  filledCells: number;
  mean: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  counts: number[];
}
interface Reference {
  fixturesSha256: string;
  caseCount: number;
  grid: GridSpec;
  methods: string[];
  oracles: {
    oracleId: string;
    role: string;
    executablePath: string;
    versionOutput: string;
    commandLine: string;
  }[];
  results: GrassResult[];
}
interface Protocol {
  metrics: { toleranceAbsM: number; minimumComparableCells: number };
  freezeStatus: string;
}

const fixturesRaw = readFileSync(resolve(DIR, 'fixtures.json'), 'utf8');
const fixtures: Fixtures = JSON.parse(fixturesRaw);
const reference: Reference = JSON.parse(
  readFileSync(resolve(DIR, 'references/grass-rasterize.json'), 'utf8'),
);
const protocol: Protocol = JSON.parse(readFileSync(resolve(DIR, 'protocol.json'), 'utf8'));

/**
 * The tolerance is the protocol's, read rather than restated.
 *
 * It was registered before any residual was computed, and its basis is the
 * candidate's storage: `DemRaster.z` and `SurfaceGrid.z` are `Float32Array`,
 * every fixture elevation is under 128 m, and one float32 step there is
 * 7.63e-6 m. GRASS answers in double. A copy of the number in this file could
 * drift away from the registered one, which is the failure a preregistration
 * exists to prevent.
 */
const TOL_M = protocol.metrics.toleranceAbsM;

const pointsFor = (c: Case): TerrainPoint[] => {
  const text = readFileSync(resolve(DIR, c.pointsFile), 'utf8');
  const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  expect(digest, `${c.pointsFile} has moved since the fixtures were written`).toBe(c.pointsSha256);
  const out: TerrainPoint[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [x, y, z] = line.split(',');
    out.push({ x: Number(x), y: Number(y), z: Number(z) });
  }
  return out;
};

const grassFor = (id: string) => reference.results.find((r) => r.id === id) as GrassResult;

/** Candidate values for one reduction, indexed the way the reference is. */
const candidateGrid = (points: TerrainPoint[], method: 'mean' | 'min' | 'max') => {
  const grid = fixtures.grid;
  if (method === 'max') {
    const dsm = buildDsm(points, { grid, verticalAxis: 'z' });
    return { z: dsm.z, counts: null as Uint32Array | null };
  }
  const raster = rasterizeDtm(points, new Uint8Array(points.length).fill(1), {
    grid,
    aggregation: method,
    verticalAxis: 'z',
  });
  return { z: raster.z, counts: raster.counts };
};

interface Residuals {
  comparableCells: number;
  maxAbsDiff: number;
  rmse: number;
  signedBias: number;
  withinToleranceFraction: number;
  emptyMismatches: number;
}

/**
 * Residuals of candidate minus reference.
 *
 * The bias is signed and is candidate minus GRASS, stated that way because a
 * bias reported without a direction is not a measurement. A cell empty on one
 * side and filled on the other is counted separately rather than skipped: that
 * is a binning disagreement and must not disappear into a comparable-cell
 * denominator.
 */
const residuals = (got: Float32Array, want: (number | null)[]): Residuals => {
  let n = 0;
  let maxAbs = 0;
  let sumSq = 0;
  let sum = 0;
  let within = 0;
  let emptyMismatches = 0;
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const g = got[i];
    const gEmpty = !Number.isFinite(g);
    if ((w === null) !== gEmpty) {
      emptyMismatches++;
      continue;
    }
    if (w === null) continue;
    const d = g - w;
    n++;
    sum += d;
    sumSq += d * d;
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
    if (a <= TOL_M) within++;
  }
  return {
    comparableCells: n,
    maxAbsDiff: maxAbs,
    rmse: n > 0 ? Math.sqrt(sumSq / n) : 0,
    signedBias: n > 0 ? sum / n : 0,
    withinToleranceFraction: n > 0 ? within / n : 0,
    emptyMismatches,
  };
};

describe('rasterize oracle, bound to what produced it', () => {
  it('was generated from the committed fixtures', () => {
    const digest = `sha256:${createHash('sha256').update(fixturesRaw).digest('hex')}`;
    expect(reference.fixturesSha256).toBe(digest);
  });

  it('used the grid the candidate is given', () => {
    // A reference on a different grid would disagree for a reason that has
    // nothing to do with either implementation.
    expect(reference.grid).toEqual(fixtures.grid);
  });

  it('names GRASS with the executable, version and command line it ran', () => {
    expect(reference.oracles).toHaveLength(1);
    const o = reference.oracles[0];
    expect(o.oracleId).toBe('grass-8.5.0');
    expect(o.role).toBe('independent-same-quantity-implementation');
    expect(o.versionOutput).toMatch(/GRASS\s+8\./);
    expect(o.executablePath.startsWith('/')).toBe(true);
    expect(o.commandLine).toMatch(/r\.in\.xyz/);
  });

  it('covers every fixture with every reduction', () => {
    expect(reference.caseCount).toBe(fixtures.cases.length);
    expect(reference.methods).toEqual(['mean', 'min', 'max', 'n']);
    for (const c of fixtures.cases) expect(grassFor(c.id), `${c.id} missing`).toBeTruthy();
  });

  it('declares its freeze status', () => {
    expect(protocol.freezeStatus).toBe('preregistered');
  });
});

describe('the cells actually hold a neighbourhood', () => {
  // The point of the study. At one return per cell, mean, min and max are the
  // same number and the comparison degenerates into an indexing test, which is
  // what the existing PDAL leg already covers.
  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    '%s averages several returns per filled cell',
    (_id, c) => {
      const g = grassFor(c.id);
      const filled = g.counts.filter((n) => n > 0);
      const mean = filled.reduce((a, b) => a + b, 0) / filled.length;
      expect(mean).toBeGreaterThan(4);
      expect(c.maxPointsInOneCell).toBeGreaterThan(4);
    },
  );

  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    '%s separates min from max in every cell that holds more than one return',
    (_id, c) => {
      const g = grassFor(c.id);
      let multi = 0;
      let separated = 0;
      for (let i = 0; i < g.mean.length; i++) {
        if (g.counts[i] < 2) continue;
        multi++;
        if ((g.max[i] as number) > (g.min[i] as number)) separated++;
      }
      // The count of multi-return cells is the study's reason for existing. In
      // the PDAL leg it is zero by construction, so min, mean and max are one
      // number and only the indexing is under test.
      expect(multi).toBeGreaterThan(1000);
      expect(separated).toBe(multi);
    },
  );
});

describe('against GRASS r.in.xyz, over cells holding many returns', () => {
  const METHODS = ['mean', 'min', 'max'] as const;

  for (const c of fixtures.cases) {
    for (const method of METHODS) {
      it(`${c.id} / ${method} agrees within the registered tolerance`, () => {
        const g = grassFor(c.id);
        const { z } = candidateGrid(pointsFor(c), method);
        const r = residuals(z, g[method]);

        expect(r.emptyMismatches, 'cells filled on one side and empty on the other').toBe(0);
        expect(r.comparableCells).toBeGreaterThanOrEqual(1400);
        expect(
          r.withinToleranceFraction,
          `${c.id}/${method}: max ${r.maxAbsDiff.toExponential(3)} m, rmse ${r.rmse.toExponential(3)} m, bias ${r.signedBias.toExponential(3)} m`,
        ).toBe(1);
      });
    }
  }

  it('the whole study clears the registered comparable-cell floor', () => {
    let total = 0;
    for (const c of fixtures.cases) {
      const g = grassFor(c.id);
      for (const method of METHODS) {
        const { z } = candidateGrid(pointsFor(c), method);
        total += residuals(z, g[method]).comparableCells;
      }
    }
    expect(total).toBeGreaterThanOrEqual(protocol.metrics.minimumComparableCells);
  });
});

describe('binning rule, which is exact on both sides', () => {
  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    '%s puts the same returns in the same cells as GRASS',
    (_id, c) => {
      const g = grassFor(c.id);
      const { counts } = candidateGrid(pointsFor(c), 'mean');
      expect(counts).not.toBeNull();
      const mismatches: string[] = [];
      let placed = 0;
      for (let i = 0; i < g.counts.length; i++) {
        placed += (counts as Uint32Array)[i];
        if ((counts as Uint32Array)[i] !== g.counts[i]) mismatches.push(`cell ${i}`);
      }
      expect(mismatches.slice(0, 5).join(', ')).toBe('');
      // Every return the generator wrote is binned by both sides.
      expect(placed).toBe(c.pointCount);
      expect(g.counts.reduce((a, b) => a + b, 0)).toBe(c.pointCount);
    },
  );

  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    '%s agrees with the generator on which cells are empty',
    (_id, c) => {
      const g = grassFor(c.id);
      expect(g.filledCells).toBe(c.filledCells);
      expect(g.counts.filter((n) => n === 0).length).toBe(c.emptyCells);
    },
  );
});
