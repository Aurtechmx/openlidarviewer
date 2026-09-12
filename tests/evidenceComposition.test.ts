/**
 * An artifact's evidence is its WEAKEST constituent's evidence.
 *
 * The register already said so in prose — CONTOURS carries
 * `assumptions: ["depends on DTM validity"]` — but nothing in code could read
 * it. Every export resolved one claim id, and no call site passed one, so all of
 * them silently resolved 'DTM'. A contour bundle could therefore be stamped with
 * a verdict computed for a product it does not contain.
 */
import { describe, it, expect } from 'vitest';
import { governingClaim, limitingConstituents } from '../src/validation/evidenceComposition';
import { EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';
import { evidenceStatus } from '../src/validation/exportEvidenceNote';

describe('governingClaim', () => {
  it('returns a single claim unchanged, so a one-product path is untouched', () => {
    expect(governingClaim(['DTM'])).toBe('DTM');
    expect(governingClaim(['CONTOURS'])).toBe('CONTOURS');
  });

  it('picks the constituent that falls furthest short of its own requirement', () => {
    // CONTOURS is E4 needing E4 — it meets its bar. DTM is E4 needing E5 — it
    // does not. A bundle holding both may claim only what the DTM permits.
    expect(evidenceStatus('CONTOURS')).toBe('validated');
    expect(evidenceStatus('DTM')).toBe('exploratory');
    expect(governingClaim(['CONTOURS', 'DTM'])).toBe('DTM');
    expect(governingClaim(['DTM', 'CONTOURS'])).toBe('DTM');
  });

  it('prefers the WIDER shortfall, not merely the lower level', () => {
    // CONTOURS-CARTOGRAPHIC is E2 needing E4: a two-rank gap.
    // DTM is E4 needing E5: a one-rank gap. The cartographic line governs even
    // though both are exploratory, because it is the weaker statement.
    const gap = (id: string): number => {
      const e = EVIDENCE_REGISTRY[id]!;
      return ['E0_IMPLEMENTED', 'E1_UNIT_VERIFIED', 'E2_ANALYTICALLY_VERIFIED',
        'E3_SYNTHETICALLY_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED',
        'E5_EXTERNALLY_VALIDATED', 'E6_INDEPENDENTLY_REPRODUCED']
        .indexOf(e.required) - ['E0_IMPLEMENTED', 'E1_UNIT_VERIFIED', 'E2_ANALYTICALLY_VERIFIED',
          'E3_SYNTHETICALLY_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED',
          'E5_EXTERNALLY_VALIDATED', 'E6_INDEPENDENTLY_REPRODUCED'].indexOf(e.current);
    };
    expect(gap('CONTOURS-CARTOGRAPHIC')).toBeGreaterThan(gap('DTM'));
    expect(governingClaim(['CONTOURS-CARTOGRAPHIC', 'DTM'])).toBe('CONTOURS-CARTOGRAPHIC');
  });

  it('never promotes: adding a constituent can only weaken the verdict', () => {
    const ranks: Record<string, number> = { validated: 2, exploratory: 1, refused: 0 };
    for (const extra of Object.keys(EVIDENCE_REGISTRY)) {
      const alone = ranks[evidenceStatus('CONTOURS')]!;
      const withExtra = ranks[evidenceStatus(governingClaim(['CONTOURS', extra]))]!;
      expect(withExtra, `adding ${extra} promoted the artifact`).toBeLessThanOrEqual(alone);
    }
  });

  it('an unregistered constituent governs everything', () => {
    expect(governingClaim(['CONTOURS', 'NOT-A-REGISTERED-CLAIM'])).toBe('NOT-A-REGISTERED-CLAIM');
    expect(evidenceStatus(governingClaim(['CONTOURS', 'NOT-A-REGISTERED-CLAIM']))).not.toBe('validated');
  });

  it('is deterministic regardless of the order constituents are listed', () => {
    const set = ['HOLDOUT-RMSE', 'DTM', 'CONTOURS'];
    const first = governingClaim(set);
    expect(governingClaim([...set].reverse())).toBe(first);
    expect(governingClaim([...set, ...set])).toBe(first);
  });

  it('refuses an empty set rather than inventing the old silent default', () => {
    expect(() => governingClaim([])).toThrow(/must declare what it contains/);
  });

  it('names every constituent that is below its bar', () => {
    expect(limitingConstituents(['CONTOURS', 'DTM', 'HOLDOUT-RMSE'])).toEqual(['DTM', 'HOLDOUT-RMSE']);
    expect(limitingConstituents(['CONTOURS'])).toEqual([]);
  });
});

describe('the generalized contour cannot inherit the analytical cross-check', () => {
  it('is registered separately and below the independence floor', () => {
    const analytical = EVIDENCE_REGISTRY['CONTOURS']!;
    const cartographic = EVIDENCE_REGISTRY['CONTOURS-CARTOGRAPHIC']!;
    // The GDAL study that earned CONTOURS its E4 ran on the analytical geometry
    // at a 0.05 m position tolerance. Generalization moves vertices off that
    // line on purpose, so the agreement does not transfer.
    expect(analytical.current).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(cartographic.current).not.toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(evidenceStatus('CONTOURS-CARTOGRAPHIC')).toBe('exploratory');
  });
});
