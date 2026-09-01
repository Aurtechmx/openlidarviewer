/**
 * oracleConsensusGround.test.ts — the METHOD_SENSITIVITY leg of the oracle
 * triangulation framework.
 *
 * Slope, aspect and CRS each have a truth (analytic or a replication reference)
 * that lets OLV's residual be attributed. Ground classification does not: SMRF,
 * CSF and PMF are all established, published filters and they disagree with each
 * other, sometimes by more than a third of an F1 point. This test does NOT claim
 * an OLV accuracy grade. It validates the verdict logic — where the established
 * references disagree by more than the contract threshold, the conclusion is
 * METHOD_SENSITIVITY (no consensus truth) — and checks the record's internal
 * consistency.
 *
 * The OpenGF clouds are licensed but too large to commit, so CI cannot recompute
 * the F1 legs; the numbers in the record are exploratory evidence measured
 * offline. What is tested here is the reasoning applied to them, which is exactly
 * what the framework exists to make machine-checkable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Scene = {
  id: string;
  olvF1: number;
  referenceF1: { smrf: number; csf: number; pmf: number };
};
const record = JSON.parse(
  readFileSync(
    resolve(ROOT, 'validation/oracle-consensus/ground-classification-sensitivity.consensus.json'),
    'utf8',
  ),
) as {
  contract: { sensitivityThresholdF1: number };
  evidenceRole: string;
  scenes: Scene[];
};

const refs = (s: Scene) => [s.referenceF1.smrf, s.referenceF1.csf, s.referenceF1.pmf];
const span = (s: Scene) => Math.max(...refs(s)) - Math.min(...refs(s));

/** The framework verdict for one scene, from the reference disagreement. */
function verdict(s: Scene, threshold: number): 'METHOD_SENSITIVITY' | 'CONSENSUS' {
  return span(s) > threshold ? 'METHOD_SENSITIVITY' : 'CONSENSUS';
}

describe('oracle-consensus: ground classification (METHOD_SENSITIVITY)', () => {
  const threshold = record.contract.sensitivityThresholdF1;

  it('is declared exploratory evidence, not a CI accuracy gate', () => {
    expect(record.evidenceRole).toBe('exploratory');
  });

  it('every F1 in the record is a valid score in [0,1]', () => {
    for (const s of record.scenes) {
      expect(s.olvF1, s.id).toBeGreaterThanOrEqual(0);
      expect(s.olvF1, s.id).toBeLessThanOrEqual(1);
      for (const r of refs(s)) {
        expect(r, s.id).toBeGreaterThanOrEqual(0);
        expect(r, s.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the mountain scenes trigger METHOD_SENSITIVITY (references disagree beyond threshold)', () => {
    for (const id of ['OpenGF-S6', 'OpenGF-S7', 'OpenGF-S9']) {
      const s = record.scenes.find((x) => x.id === id)!;
      expect(verdict(s, threshold), `${id} span ${span(s).toFixed(3)}`).toBe('METHOD_SENSITIVITY');
    }
  });

  it('the flat city scenes reach CONSENSUS (references agree within threshold)', () => {
    for (const id of ['OpenGF-S2', 'OpenGF-S3', 'OpenGF-S4']) {
      const s = record.scenes.find((x) => x.id === id)!;
      expect(verdict(s, threshold), `${id} span ${span(s).toFixed(3)}`).toBe('CONSENSUS');
    }
  });

  it('where the references agree, OLV agrees with them too (no OLV_DISAGREEMENT under consensus)', () => {
    for (const s of record.scenes.filter((x) => verdict(x, threshold) === 'CONSENSUS')) {
      const lo = Math.min(...refs(s));
      // OLV is within one threshold of the consensus band's floor.
      expect(s.olvF1, s.id).toBeGreaterThanOrEqual(lo - threshold);
    }
  });

  it('NEGATIVE CONTROL: picking any single filter as "truth" would fabricate a winner that another scene refutes', () => {
    // No filter is best on every sensitive scene: CSF wins S1, PMF wins S7, SMRF wins S9.
    const best = (s: Scene) => {
      const e = Object.entries(s.referenceF1) as [string, number][];
      return e.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    };
    const winners = new Set(
      record.scenes.filter((s) => verdict(s, threshold) === 'METHOD_SENSITIVITY').map(best),
    );
    expect(winners.size).toBeGreaterThan(1);
  });
});
