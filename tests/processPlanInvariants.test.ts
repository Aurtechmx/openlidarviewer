/**
 * processPlanInvariants.test.ts — the numerical → ProcessPlan → evidence triple.
 *
 * processCapabilities.test.ts pins each product's ready / review / blocked path
 * on its own. This file pins the CROSS-CUTTING invariants that tie the capability
 * evaluator to the evidence-monotonicity guard, so the two subsystems can never
 * disagree:
 *
 *  1. Degrading an input can only weaken a verdict (§20). As coverage falls
 *     full → sampled → resident-only, and as the linear unit goes from known to
 *     unknown, no product's readiness may climb. Checked by running the plan's
 *     readiness through the SAME READINESS_LADDER the evidence guard uses.
 *  2. A blocked verdict is terminal within a run and the evaluator is
 *     idempotent (§19): the same inputs always produce the same plan, so a
 *     verdict can't be re-evaluated upward without the facts changing.
 *  3. The two ladders agree (§11): each coverage step is a valid, non-promoting
 *     evidence transition — the ProcessPlan output, mapped into the evidence
 *     ladder, satisfies the monotonicity invariant by construction.
 *
 * The bridge is the readiness map ready → Ready, review → Preview, blocked →
 * Blocked: the capability ladder and the evidence readiness ladder are the same
 * order, so a legal capability weakening is a legal evidence transition.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, ProductId, Readiness, Coverage } from '../src/process/ProcessPlan';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import { READINESS_LADDER, isNonPromoting, isValidEvidenceTransition } from '../src/validation/evidenceMonotonicity';

function crs(overrides: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...overrides } as CrsInfo;
}

/** A healthy full-coverage scan: known unit, trusted ground, building class. */
function scan(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static',
    coverage: 'full',
    crs: crs(),
    pointCount: 1_000_000,
    hasRgb: true,
    hasIntensity: true,
    hasGpsTime: true,
    hasReturnNumber: true,
    hasPointSourceId: false,
    classification: 'full',
    groundClassified: true,
    hasBuildingClass: true,
    medianSpacing: 0.2,
    ...overrides,
  };
}

/** ready → Ready, review → Preview, blocked → Blocked — the two ladders' shared order. */
const READINESS_TO_LADDER: Record<Readiness, string> = { ready: 'Ready', review: 'Preview', blocked: 'Blocked' };

const ALL_PRODUCTS: ProductId[] = [
  'classify-gaps', 'dtm', 'dsm', 'contours', 'building-footprints', 'cross-epoch-change', 'volume-cut-fill',
];

/** Every product's readiness for one scan, as a product → readiness map. */
function readinessByProduct(s: ScanFacts): Record<ProductId, Readiness> {
  const plan = evaluateCapabilities({ scans: [s] });
  const out = {} as Record<ProductId, Readiness>;
  for (const p of ALL_PRODUCTS) out[p] = capabilityFor(plan, p)!.readiness;
  return out;
}

describe('degrading an input can only weaken a verdict (coverage axis, §20)', () => {
  // A streaming scan whose coverage is the only thing we vary. (Static scans are
  // always full-coverage; coverage honesty is a streaming concern.)
  const streaming = (coverage: Coverage): ScanFacts => scan({ kind: 'streaming', coverage });
  const steps: Coverage[] = ['full', 'sampled', 'resident-only'];

  it('no product climbs as coverage falls full → sampled → resident-only', () => {
    const byStep = steps.map((c) => readinessByProduct(streaming(c)));
    for (const product of ALL_PRODUCTS) {
      for (let i = 1; i < steps.length; i++) {
        const from = READINESS_TO_LADDER[byStep[i - 1][product]];
        const to = READINESS_TO_LADDER[byStep[i][product]];
        // The weaker-coverage verdict must not out-rank the stronger-coverage one.
        expect(isNonPromoting(READINESS_LADDER, from, to)).toBe(true);
      }
    }
  });

  it('each coverage step is also a valid evidence transition — the two ladders agree (§11)', () => {
    const byStep = steps.map((c) => readinessByProduct(streaming(c)));
    for (const product of ALL_PRODUCTS) {
      for (let i = 1; i < steps.length; i++) {
        const from = READINESS_TO_LADDER[byStep[i - 1][product]];
        const to = READINESS_TO_LADDER[byStep[i][product]];
        expect(isValidEvidenceTransition(READINESS_LADDER, from, to)).toBe(true);
      }
    }
  });
});

describe('losing unit trust can only weaken a verdict (fail-closed axis, §12)', () => {
  it('no product climbs when the linear unit goes from known to unknown', () => {
    const known = readinessByProduct(scan());
    const unknown = readinessByProduct(scan({ crs: crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }) }));
    for (const product of ALL_PRODUCTS) {
      const from = READINESS_TO_LADDER[known[product]];
      const to = READINESS_TO_LADDER[unknown[product]];
      expect(isNonPromoting(READINESS_LADDER, from, to)).toBe(true);
    }
  });

  it('a metric product actually drops when the unit is lost (the axis has teeth)', () => {
    // If nothing moved, the monotonicity check above would be vacuous.
    // building-footprints is a metric AREA product with no inspection path, so an
    // unknown unit must pull it strictly below ready (hard block, not review).
    expect(readinessByProduct(scan({ hasBuildingClass: true }))['building-footprints']).toBe('ready');
    expect(readinessByProduct(scan({ hasBuildingClass: true, crs: crs({ linearUnit: 'unknown' }) }))['building-footprints']).toBe('blocked');
  });
});

describe('idempotence and terminal blocks (§19)', () => {
  it('the same inputs always produce the same plan — no verdict drifts upward on re-evaluation', () => {
    const inputs = { scans: [scan({ kind: 'streaming', coverage: 'resident-only' })] };
    const a = evaluateCapabilities(inputs);
    const b = evaluateCapabilities(inputs);
    expect(b).toEqual(a);
  });

  it('a blocked product stays blocked when an UNRELATED fact improves', () => {
    // resident-only blocks building-footprints (missing returns would drop
    // buildings). Adding RGB (irrelevant to coverage) must not lift the block —
    // only fixing the blocking fact (coverage) may.
    const blocked = scan({ kind: 'streaming', coverage: 'resident-only', hasBuildingClass: true, hasRgb: false });
    const stillBlocked = { ...blocked, hasRgb: true };
    expect(capabilityFor(evaluateCapabilities({ scans: [blocked] }), 'building-footprints')!.readiness).toBe('blocked');
    expect(capabilityFor(evaluateCapabilities({ scans: [stillBlocked] }), 'building-footprints')!.readiness).toBe('blocked');
  });
});

describe('the readiness bridge is total', () => {
  it('every readiness the evaluator can emit maps into the evidence ladder', () => {
    for (const r of ['ready', 'review', 'blocked'] as Readiness[]) {
      expect(READINESS_LADDER).toContain(READINESS_TO_LADDER[r]);
    }
  });
});
