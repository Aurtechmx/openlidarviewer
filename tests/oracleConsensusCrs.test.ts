/**
 * oracleConsensusCrs.test.ts — the CRS/UTM row of the oracle-consensus matrix.
 *
 * The live OLV-vs-oracle check for this family is geodesyOracleAgreement.test.ts
 * (OLV latLonToUtm vs committed PROJ + GeographicLib). This test does the two
 * things that make CRS a coherent member of the consensus matrix, without
 * re-deriving that geodesy math:
 *   1. Drift guard — the matrix record's oracleSpread must equal the committed
 *      geodesy reference's oracleAgreement, so the record cannot silently
 *      diverge from the data the live test actually runs against.
 *   2. The triangulation inequality — the oracle-to-oracle spread must be far
 *      below both the acceptance tolerance AND OLV's own residual, which is what
 *      makes OLV's residual attributable to OLV rather than to the references.
 *      That is the whole point of triangulation: PROJ is not treated as truth.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/crs-utm.consensus.json'), 'utf8'),
);
const geodesyRef = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/external-oracles/geodesy/references/oracle-utm.json'), 'utf8'),
);
const protocol = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/external-oracles/geodesy/protocol.json'), 'utf8'),
);

describe('oracle-consensus: CRS / UTM projection', () => {
  const tol = record.contract.absoluteToleranceM as number;

  it('the record tolerance matches the geodesy protocol (single source)', () => {
    expect(tol).toBe(protocol.metrics.toleranceAbs);
  });

  it('DRIFT GUARD: the record oracleSpread equals the committed geodesy oracleAgreement', () => {
    expect(record.oracleSpread.maxAbsEastingM).toBe(geodesyRef.oracleAgreement.maxAbsEastingM);
    expect(record.oracleSpread.maxAbsNorthingM).toBe(geodesyRef.oracleAgreement.maxAbsNorthingM);
  });

  it('the two independent implementations agree far below the acceptance tolerance', () => {
    // PROJ vs GeographicLib, separate lineages. If this were near the tolerance,
    // a candidate result inside tolerance could be oracle noise, not a real pass.
    const spread = Math.max(record.oracleSpread.maxAbsEastingM, record.oracleSpread.maxAbsNorthingM);
    expect(spread).toBeLessThan(tol / 1000);
  });

  it('OLV passes tolerance, but its residual exceeds the oracle spread — so it is attributable to OLV (PASS_REPLICATION)', () => {
    const olv = Math.max(record.olvResidual.maxAbsEastingM, record.olvResidual.maxAbsNorthingM);
    const spread = Math.max(record.oracleSpread.maxAbsEastingM, record.oracleSpread.maxAbsNorthingM);
    expect(olv).toBeLessThanOrEqual(tol); // within acceptance
    expect(olv).toBeGreaterThan(spread); // but not machine-tight: residual is the candidate's
    expect(record.verdict).toBe('PASS_REPLICATION');
  });

  it('names its live cross-implementation test', () => {
    expect(record.liveTest).toBe('tests/geodesyOracleAgreement.test.ts');
    expect(record.oracles.map((o: { referenceClass: string }) => o.referenceClass)).toEqual([
      'matched-implementation',
      'matched-implementation',
    ]);
  });
});
