/**
 * coverageMonotonicityChain.test.ts — quick-win 5. An explicit
 * FULL → SAMPLED → RESIDENT_ONLY chain that may lose authority downstream but
 * can never regain it.
 *
 * The derived chain is coverage → DTM readiness → contour readiness, evaluated
 * through the real ProcessPlan capability model and checked against the evidence
 * monotonicity ladders. It asserts, in the project's own vocabulary, that no
 * later transformation produces resident-only → full, sampled → full,
 * BLOCKED → READY, or a REVIEW that strengthens without new evidence.
 */

import { describe, it, expect } from 'vitest';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import {
  COVERAGE_LADDER, READINESS_LADDER, isValidCoverageTransition, isNonPromoting, rankIn,
} from '../src/validation/evidenceMonotonicity';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, Coverage, Readiness } from '../src/process/ProcessPlan';

const READINESS_TO_LADDER: Record<Readiness, string> = { ready: 'Ready', review: 'Preview', blocked: 'Blocked' };

const scan = (coverage: Coverage): ScanFacts => ({
  kind: 'streaming', coverage,
  crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as CrsInfo,
  pointCount: 5_000_000, hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true,
  hasPointSourceId: false, classification: 'full', groundClassified: true, hasBuildingClass: false, medianSpacing: 0.2,
});

const STEPS: Coverage[] = ['full', 'sampled', 'resident-only'];

describe('coverage → DTM readiness → contour readiness cannot regain authority', () => {
  it('coverage weakens monotonically and never promotes back to full', () => {
    for (let i = 1; i < STEPS.length; i++) {
      expect(isValidCoverageTransition(STEPS[i - 1], STEPS[i])).toBe(true); // full→sampled→resident-only OK
      expect(isValidCoverageTransition(STEPS[i], STEPS[i - 1])).toBe(false); // the reverse is forbidden
    }
    expect(COVERAGE_LADDER[0]).toBe('full');
  });

  it('DTM readiness and contour readiness only weaken as coverage falls', () => {
    const chain = STEPS.map((cov) => {
      const plan = evaluateCapabilities({ scans: [scan(cov)] });
      return {
        cov,
        dtm: capabilityFor(plan, 'dtm')!.readiness,
        contours: capabilityFor(plan, 'contours')!.readiness,
      };
    });
    // eslint-disable-next-line no-console
    console.log('[terrain-field] coverage chain:', chain.map((c) => `${c.cov}:dtm=${c.dtm},contours=${c.contours}`).join('  '));

    for (let i = 1; i < chain.length; i++) {
      for (const product of ['dtm', 'contours'] as const) {
        const from = READINESS_TO_LADDER[chain[i - 1][product]];
        const to = READINESS_TO_LADDER[chain[i][product]];
        // No product's readiness climbs as coverage weakens (no BLOCKED→READY,
        // no REVIEW→READY without new evidence).
        expect(isNonPromoting(READINESS_LADDER, from, to)).toBe(true);
      }
    }
    // The derived contour readiness never out-ranks the DTM it is built on, at
    // every coverage step (a contour cannot be more ready than its surface).
    for (const c of chain) {
      const dtmRank = rankIn(READINESS_LADDER, READINESS_TO_LADDER[c.dtm]);
      const contourRank = rankIn(READINESS_LADDER, READINESS_TO_LADDER[c.contours]);
      expect(contourRank).toBeGreaterThanOrEqual(dtmRank); // higher index = weaker
    }
  });

  it('the terminal state is genuinely degraded — resident-only reviews (not ready) the full-dataset DTM', () => {
    // Proves the chain has teeth: the weakest coverage really does block, so the
    // monotonicity above is not vacuously satisfied by everything staying READY.
    expect(capabilityFor(evaluateCapabilities({ scans: [scan('resident-only')] }), 'dtm')!.readiness).toBe('review');
    expect(capabilityFor(evaluateCapabilities({ scans: [scan('full')] }), 'dtm')!.readiness).toBe('ready');
  });
});
