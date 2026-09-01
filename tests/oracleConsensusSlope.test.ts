/**
 * oracleConsensusSlope.test.ts — oracle-triangulation for terrain slope.
 *
 * The point of this test is a stronger scientific statement than "OLV agrees
 * with GDAL". On ONE canonical quantity contract (Horn slope, metre grid, degree
 * output, one-cell border excluded) it triangulates OLV against:
 *   - ANALYTIC TRUTH (a tilted plane whose slope is atan(gradient) everywhere),
 *   - MATCHED independent implementations (GDAL gdaldem, GRASS r.slope.aspect).
 *
 * It reports both E(OLV, oracle) AND the oracle-to-oracle disagreement, and
 * assigns a verdict:
 *   PASS_TRUTH        OLV matches analytic truth within tolerance,
 *   PASS_REPLICATION  every implementation agrees within tolerance,
 *   OLV_DISAGREEMENT  OLV alone is outside the spread of the references,
 *   REFERENCE_DISAGREEMENT  the references disagree with each other beyond tol
 *                     (then an OLV difference is NOT an OLV fault).
 *
 * Two cases run at different gradients — a shallow 16.7 deg plane and a steep
 * 45 deg plane — so a scale error in the slope magnitude cannot pass both. CI
 * runs without GDAL/GRASS: OLV's legs are recomputed live from the same
 * fixtures, and the external legs are read from the committed consensus record,
 * regenerated offline by scripts/gen-oracle-consensus-slope.mjs. Agreement with
 * independent implementations is not accuracy against a surveyed surface; the
 * analytic leg is the truth anchor here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Oracle = { id: string; referenceClass: string; meanSlopeDeg: number };
type Case = {
  fixture: { cols: number; rows: number; cellMetres: number; gradient: number };
  oracles: Oracle[];
};
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/slope-horn.consensus.json'), 'utf8'),
) as { contract: { absoluteToleranceDeg: number }; cases: Case[] };

/** OLV's own Horn slope over a case's fixture, mean of the interior (border excluded). */
function olvMeanSlopeDeg(c: Case): number {
  const { cols, rows, cellMetres, gradient } = c.fixture;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) z[r * cols + col] = gradient * col;
  const { slope } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  let sum = 0;
  let n = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let col = 1; col < cols - 1; col++) {
      sum += (Math.atan(slope[r * cols + col]) * 180) / Math.PI;
      n += 1;
    }
  }
  return sum / n;
}

type Verdict = 'PASS_TRUTH' | 'PASS_REPLICATION' | 'OLV_DISAGREEMENT' | 'REFERENCE_DISAGREEMENT';

/** The triangulation verdict from a value set and a tolerance. Pure + reusable. */
export function triangulate(olv: number, values: Oracle[], tol: number): Verdict {
  const truth = values.find((v) => v.referenceClass === 'analytic-truth');
  const refs = values.filter((v) => v.referenceClass === 'matched-implementation');
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      if (Math.abs(refs[i].meanSlopeDeg - refs[j].meanSlopeDeg) > tol) return 'REFERENCE_DISAGREEMENT';
    }
  }
  const spread = [...refs, ...(truth ? [truth] : [])].map((v) => v.meanSlopeDeg);
  const outside = spread.some((v) => Math.abs(olv - v) > tol);
  if (outside) return 'OLV_DISAGREEMENT';
  if (truth && Math.abs(olv - truth.meanSlopeDeg) <= tol) return 'PASS_TRUTH';
  return 'PASS_REPLICATION';
}

describe('oracle-consensus: terrain slope (Horn)', () => {
  const tol = record.contract.absoluteToleranceDeg;

  for (const c of record.cases) {
    const label = `${c.fixture.gradient} gradient`;
    const olv = olvMeanSlopeDeg(c);
    const refs = c.oracles.filter((o) => o.referenceClass === 'matched-implementation');

    if (refs.length >= 2) {
      it(`the committed external references agree with each other [${label}]`, () => {
        for (let i = 0; i < refs.length; i++) {
          for (let j = i + 1; j < refs.length; j++) {
            expect(
              Math.abs(refs[i].meanSlopeDeg - refs[j].meanSlopeDeg),
              `${refs[i].id} vs ${refs[j].id}`,
            ).toBeLessThanOrEqual(tol);
          }
        }
      });
    }

    it(`OLV matches every oracle within the contract tolerance [${label}]`, () => {
      for (const o of c.oracles) {
        expect(Math.abs(olv - o.meanSlopeDeg), `OLV vs ${o.id}`).toBeLessThanOrEqual(tol);
      }
    });

    it(`the triangulation verdict is PASS_TRUTH [${label}]`, () => {
      expect(triangulate(olv, c.oracles, tol)).toBe('PASS_TRUTH');
    });
  }

  it('the two cases are genuinely different magnitudes (a scale error could not pass both)', () => {
    const [a, b] = record.cases.map(olvMeanSlopeDeg);
    expect(Math.abs(a - b)).toBeGreaterThan(20);
  });

  it('NEGATIVE CONTROL: a reference that diverged would surface as REFERENCE_DISAGREEMENT', () => {
    const shallow = record.cases[0];
    const olv = olvMeanSlopeDeg(shallow);
    const poisoned = shallow.oracles.map((o) =>
      o.id === 'grass-horn-slope' ? { ...o, meanSlopeDeg: o.meanSlopeDeg + 5 } : o,
    );
    expect(triangulate(olv, poisoned, tol)).toBe('REFERENCE_DISAGREEMENT');
  });

  it('NEGATIVE CONTROL: an OLV regression would surface as OLV_DISAGREEMENT', () => {
    const shallow = record.cases[0];
    expect(triangulate(olvMeanSlopeDeg(shallow) + 5, shallow.oracles, tol)).toBe('OLV_DISAGREEMENT');
  });
});
