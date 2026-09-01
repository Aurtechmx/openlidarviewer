/**
 * oracleConsensusVolume.test.ts — oracle-triangulation for cut/fill volume.
 *
 * On ONE canonical quantity contract (point-sample cut/fill against a horizontal
 * reference plane, over a unit-area square footprint, cubic-metre output) this
 * triangulates OLV's `volumeCutFill` against:
 *   - ANALYTIC TRUTH (closed-form V of a plane over the square footprint),
 *   - a MATCHED independent implementation (a fine-lattice composite-trapezoid
 *     Riemann integral of the same height field, computed here in-test).
 *
 * volumeCutFill is a sample-mean x area estimator: fill = A*mean(max(0,dz)),
 * cut = A*mean(max(0,-dz)). It is EXACT for a plane on a symmetric cell-centre
 * lattice, so both cases are honest PASS_TRUTH rather than convergence
 * approximations — the tolerance only absorbs Float32 position storage and the
 * quadrature leg's residual. Two cases run: a large fill-only flat cap and a
 * tilted plane straddling the reference (equal cut and fill, net zero), so a
 * scale error in the magnitude or a broken cut/fill split cannot pass both.
 *
 * OLV's legs are recomputed live below; the analytic and quadrature values are
 * read from validation/oracle-consensus/volume-cutfill.consensus.json (no
 * third-party tool at CI time). Agreement across the three is what the verdict
 * asserts, with negative controls proving the verdict can fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { volumeCutFill } from '../src/render/measure/volume';
import type { Vec3 } from '../src/render/navMath';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const A_HALF = 0.5; // half-width of the unit-area square footprint (A = 1 m^2)

type Oracle = {
  id: string;
  referenceClass: string;
  fillM3: number;
  cutM3: number;
  netM3: number;
};
type Fixture = { id: string; latticeN: number; referenceZ: number; model: string };
type Case = { fixture: Fixture; oracles: Oracle[] };

const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/volume-cutfill.consensus.json'), 'utf8'),
) as { contract: { absoluteToleranceM3: number }; cases: Case[] };

type Field = (x: number, y: number) => number;

/** The height field for a case, reconstructed from its fixture id. */
function fieldFor(fixtureId: string): Field {
  if (fixtureId.startsWith('flat-cap-h3.0')) return () => 3.0;
  if (fixtureId.startsWith('tilted-plane-eastgrad-2.0')) return (x) => 2.0 * x;
  throw new Error(`unknown fixture ${fixtureId}`);
}

/** Cell centres of an n x n lattice over S, heights from the field. */
function latticeCloud(z: Field, n: number): Float32Array {
  const h = (2 * A_HALF) / n;
  const out = new Float32Array(n * n * 3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = -A_HALF + (i + 0.5) * h;
    for (let j = 0; j < n; j++) {
      const y = -A_HALF + (j + 0.5) * h;
      out[k++] = x;
      out[k++] = y;
      out[k++] = z(x, y);
    }
  }
  return out;
}

/** The unit-square footprint polygon, strictly enclosing every cell centre. */
const FOOTPRINT: ReadonlyArray<Vec3> = [
  [-A_HALF, -A_HALF, 0],
  [A_HALF, -A_HALF, 0],
  [A_HALF, A_HALF, 0],
  [-A_HALF, A_HALF, 0],
];

/** OLV's live cut/fill over a case's fixture. */
function olvVolume(c: Case): { fill: number; cut: number; net: number; pointsInPolygon: number } {
  const z = fieldFor(c.fixture.id);
  const positions = latticeCloud(z, c.fixture.latticeN);
  const r = volumeCutFill({ polygon: FOOTPRINT, referenceZ: c.fixture.referenceZ, positions });
  return { fill: r.fill, cut: r.cut, net: r.net, pointsInPolygon: r.pointsInPolygon };
}

/**
 * Independent numerical quadrature: composite trapezoid on a fine (N+1)^2 grid
 * over S. A genuinely different rule from the estimator's cell-centre midpoint
 * sample — different node positions, different weights — so agreement is
 * evidence, not tautology.
 */
function trapezoid(z: Field, N: number, refZ: number): { fill: number; cut: number } {
  const h = (2 * A_HALF) / N;
  let fill = 0;
  let cut = 0;
  for (let i = 0; i <= N; i++) {
    const x = -A_HALF + i * h;
    const wx = i === 0 || i === N ? 0.5 : 1;
    for (let j = 0; j <= N; j++) {
      const y = -A_HALF + j * h;
      const wy = j === 0 || j === N ? 0.5 : 1;
      const d = z(x, y) - refZ;
      const w = wx * wy;
      if (d >= 0) fill += w * d;
      else cut += w * -d;
    }
  }
  return { fill: fill * h * h, cut: cut * h * h };
}

type Verdict = 'PASS_TRUTH' | 'PASS_REPLICATION' | 'OLV_DISAGREEMENT' | 'REFERENCE_DISAGREEMENT';

/** The triangulation verdict on the fill figure, from a value set and a tolerance. */
export function triangulate(olvFill: number, values: Oracle[], tol: number): Verdict {
  const truth = values.find((v) => v.referenceClass === 'analytic-truth');
  const refs = values.filter((v) => v.referenceClass === 'matched-implementation');
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      if (Math.abs(refs[i].fillM3 - refs[j].fillM3) > tol) return 'REFERENCE_DISAGREEMENT';
    }
  }
  if (truth) {
    for (const r of refs) {
      if (Math.abs(truth.fillM3 - r.fillM3) > tol) return 'REFERENCE_DISAGREEMENT';
    }
  }
  const spread = [...refs, ...(truth ? [truth] : [])].map((v) => v.fillM3);
  const outside = spread.some((v) => Math.abs(olvFill - v) > tol);
  if (outside) return 'OLV_DISAGREEMENT';
  if (truth && Math.abs(olvFill - truth.fillM3) <= tol) return 'PASS_TRUTH';
  return 'PASS_REPLICATION';
}

describe('oracle-consensus: cut/fill volume (point-sample estimator)', () => {
  const tol = record.contract.absoluteToleranceM3;

  for (const c of record.cases) {
    const label = c.fixture.id;
    const olv = olvVolume(c);

    it(`the analytic and quadrature legs agree with each other [${label}]`, () => {
      const z = fieldFor(c.fixture.id);
      const q = trapezoid(z, 2000, c.fixture.referenceZ);
      const truth = c.oracles.find((o) => o.referenceClass === 'analytic-truth')!;
      expect(Math.abs(q.fill - truth.fillM3), 'quadrature fill vs analytic').toBeLessThanOrEqual(tol);
      expect(Math.abs(q.cut - truth.cutM3), 'quadrature cut vs analytic').toBeLessThanOrEqual(tol);
      // The committed quadrature leg reproduces this in-test computation.
      const committed = c.oracles.find((o) => o.referenceClass === 'matched-implementation')!;
      expect(Math.abs(q.fill - committed.fillM3), 'committed quadrature fill').toBeLessThanOrEqual(tol);
    });

    it(`OLV matches every oracle's fill and cut within tolerance [${label}]`, () => {
      for (const o of c.oracles) {
        expect(Math.abs(olv.fill - o.fillM3), `OLV fill vs ${o.id}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(olv.cut - o.cutM3), `OLV cut vs ${o.id}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(olv.net - o.netM3), `OLV net vs ${o.id}`).toBeLessThanOrEqual(tol);
      }
    });

    it(`every cell centre landed inside the footprint [${label}]`, () => {
      expect(olv.pointsInPolygon).toBe(c.fixture.latticeN * c.fixture.latticeN);
    });

    it(`the triangulation verdict is PASS_TRUTH [${label}]`, () => {
      expect(triangulate(olv.fill, c.oracles, tol)).toBe('PASS_TRUTH');
    });
  }

  it('the two cases are genuinely different magnitudes (a scale error could not pass both)', () => {
    const [a, b] = record.cases.map((c) => olvVolume(c).fill);
    expect(Math.abs(a - b)).toBeGreaterThan(1);
  });

  it('the tilted case exercises the cut/fill split (equal cut and fill, net ~0)', () => {
    const tilt = record.cases.find((c) => c.fixture.id.startsWith('tilted-plane'))!;
    const olv = olvVolume(tilt);
    expect(olv.fill).toBeGreaterThan(0.2);
    expect(olv.cut).toBeGreaterThan(0.2);
    expect(Math.abs(olv.net)).toBeLessThanOrEqual(tol);
  });

  it('NEGATIVE CONTROL: a poisoned reference surfaces as REFERENCE_DISAGREEMENT', () => {
    const cap = record.cases[0];
    const olv = olvVolume(cap);
    const poisoned = cap.oracles.map((o) =>
      o.referenceClass === 'matched-implementation' ? { ...o, fillM3: o.fillM3 + 1 } : o,
    );
    expect(triangulate(olv.fill, poisoned, tol)).toBe('REFERENCE_DISAGREEMENT');
  });

  it('NEGATIVE CONTROL: an OLV regression surfaces as OLV_DISAGREEMENT', () => {
    const cap = record.cases[0];
    const olv = olvVolume(cap);
    expect(triangulate(olv.fill + 1, cap.oracles, tol)).toBe('OLV_DISAGREEMENT');
  });
});
