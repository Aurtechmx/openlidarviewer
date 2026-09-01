/**
 * oracleConsensusSlope.test.ts — oracle-triangulation for terrain slope.
 *
 * The point of this test is a stronger scientific statement than "OLV agrees
 * with GDAL". On ONE canonical quantity contract (Horn slope, metre grid, degree
 * output, one-cell border excluded) it triangulates OLV against:
 *   - ANALYTIC TRUTH (a tilted plane whose slope is atan(gradient) everywhere),
 *   - two MATCHED independent implementations (GDAL gdaldem, GRASS r.slope.aspect).
 *
 * It reports both E(OLV, oracle) AND the oracle-to-oracle disagreement
 * E(GDAL, GRASS), and assigns a verdict:
 *   PASS_TRUTH        OLV matches analytic truth within tolerance,
 *   PASS_REPLICATION  every implementation agrees within tolerance,
 *   OLV_DISAGREEMENT  OLV alone is outside the spread of the references,
 *   REFERENCE_DISAGREEMENT  the references disagree with each other beyond tol
 *                     (then an OLV difference is NOT an OLV fault).
 *
 * CI runs it without GDAL/GRASS: OLV's leg is recomputed live from the same
 * fixture, and the external legs are read from the committed consensus record,
 * regenerated offline by scripts/gen-oracle-consensus-slope.mjs. Agreement with
 * two independent implementations is not accuracy against a surveyed surface;
 * the analytic leg is the truth anchor here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/slope-horn.consensus.json'), 'utf8'),
) as {
  contract: { absoluteToleranceDeg: number };
  fixture: { cols: number; rows: number; cellMetres: number };
  oracles: { id: string; referenceClass: string; meanSlopeDeg: number }[];
};

/** OLV's own Horn slope over the fixture, mean of the interior (border excluded). */
function olvMeanSlopeDeg(): number {
  const { cols, rows, cellMetres } = record.fixture;
  const g = 0.3; // matches the fixture model z = 0.30 * c
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = g * c;
  const { slope } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  let sum = 0;
  let n = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      sum += (Math.atan(slope[r * cols + c]) * 180) / Math.PI;
      n += 1;
    }
  }
  return sum / n;
}

type Verdict =
  | 'PASS_TRUTH'
  | 'PASS_REPLICATION'
  | 'OLV_DISAGREEMENT'
  | 'REFERENCE_DISAGREEMENT';

/** The triangulation verdict from a value set and a tolerance. Pure + reusable. */
export function triangulate(
  olv: number,
  values: { id: string; referenceClass: string; meanSlopeDeg: number }[],
  tol: number,
): Verdict {
  const truth = values.find((v) => v.referenceClass === 'analytic-truth');
  const refs = values.filter((v) => v.referenceClass === 'matched-implementation');
  // Do the independent references agree with each other? If not, an OLV gap is
  // not attributable to OLV.
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
  const olv = olvMeanSlopeDeg();

  it('the committed external references agree with each other (no REFERENCE_DISAGREEMENT)', () => {
    const refs = record.oracles.filter((o) => o.referenceClass === 'matched-implementation');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        expect(
          Math.abs(refs[i].meanSlopeDeg - refs[j].meanSlopeDeg),
          `${refs[i].id} vs ${refs[j].id}`,
        ).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('OLV matches analytic truth and both matched implementations within the contract tolerance', () => {
    for (const o of record.oracles) {
      expect(Math.abs(olv - o.meanSlopeDeg), `OLV vs ${o.id}`).toBeLessThanOrEqual(tol);
    }
  });

  it('the triangulation verdict is PASS_TRUTH', () => {
    expect(triangulate(olv, record.oracles, tol)).toBe('PASS_TRUTH');
  });

  it('NEGATIVE CONTROL: a reference that diverged would surface as REFERENCE_DISAGREEMENT, not an OLV fault', () => {
    const poisoned = record.oracles.map((o) =>
      o.id === 'grass-horn-slope' ? { ...o, meanSlopeDeg: o.meanSlopeDeg + 5 } : o,
    );
    expect(triangulate(olv, poisoned, tol)).toBe('REFERENCE_DISAGREEMENT');
  });

  it('NEGATIVE CONTROL: an OLV regression would surface as OLV_DISAGREEMENT', () => {
    expect(triangulate(olv + 5, record.oracles, tol)).toBe('OLV_DISAGREEMENT');
  });
});
