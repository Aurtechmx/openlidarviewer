/**
 * exportManifest.test.ts
 *
 * The evidence-gated export manifest (spec §19): every scientific exporter is
 * registered against a real claim, unregistered exporters can't export, and the
 * decision only ever downgrades (never promotes) from the registry evidence.
 */

import { describe, it, expect } from 'vitest';
import {
  SCIENTIFIC_EXPORTERS,
  resolveExportDecision,
  type ExportDecisionContext,
} from '../src/export/exportManifest';
import { exportGate, EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';
import { governingClaim } from '../src/validation/evidenceComposition';
import { evidenceStatus } from '../src/validation/exportEvidenceNote';

const ctx = (over: Partial<ExportDecisionContext> = {}): ExportDecisionContext => ({
  launchStatus: 'available',
  unitClaim: 'metric-supported',
  // No scan frame in these fixtures, so nothing was measured. Spelled out
  // rather than defaulted: `null` is "not measured", never "within budget".
  precision: null,
  ...over,
});

describe('SCIENTIFIC_EXPORTERS registry', () => {
  it('every exporter requires an evidence decision and names real claim ids', () => {
    for (const e of SCIENTIFIC_EXPORTERS) {
      expect(e.requiresEvidenceDecision).toBe(true);
      expect(e.claimIds.length, `${e.exporterId} declares no constituents`).toBeGreaterThan(0);
      for (const id of e.claimIds) {
        // Each must be a REGISTERED claim. exportGate tolerates an unknown id by
        // refusing it, so assert registration directly rather than relying on
        // "it didn't throw" — a typo would otherwise pass as a refusal.
        expect(EVIDENCE_REGISTRY[id], `${e.exporterId} names unregistered claim ${id}`).toBeDefined();
        expect(() => exportGate(id)).not.toThrow();
      }
    }
  });

  it('every contour exporter carries the DTM it was cut from', () => {
    // The register's CONTOURS assumption is "depends on DTM validity". An
    // exporter that omits it can be authorised above the surface underneath it.
    for (const e of SCIENTIFIC_EXPORTERS) {
      if (!e.exporterId.startsWith('contour.') || e.exporterId === 'contour.report') continue;
      expect(e.claimIds, `${e.exporterId}`).toContain('DTM');
    }
  });

  it('no exporter is authorised above its weakest constituent', () => {
    for (const e of SCIENTIFIC_EXPORTERS) {
      const governing = governingClaim(e.claimIds);
      const rank = { validated: 2, exploratory: 1, refused: 0 };
      for (const id of e.claimIds) {
        expect(
          rank[evidenceStatus(governing)],
          `${e.exporterId} governed by ${governing} outranks ${id}`,
        ).toBeLessThanOrEqual(rank[evidenceStatus(id)]);
      }
    }
  });

  it('a generalized product is never authorised on the analytical cross-check', () => {
    const cartographic = SCIENTIFIC_EXPORTERS.filter((e) => e.exporterId.includes('cartographic')
      || e.exporterId === 'contour.pdf');
    expect(cartographic.length).toBeGreaterThan(0);
    for (const e of cartographic) {
      expect(e.claimIds, `${e.exporterId}`).toContain('CONTOURS-CARTOGRAPHIC');
      expect(e.claimIds, `${e.exporterId}`).not.toContain('CONTOURS');
    }
  });
});

describe('resolveExportDecision', () => {
  it('throws for an unregistered exporter (no bypass)', () => {
    expect(() => resolveExportDecision('not.a.real.exporter', ctx())).toThrow(/registered/i);
  });

  it('blocks when the launch is unavailable, carrying the reasons', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ launchStatus: 'unavailable', blockedReasons: ['no surface'] }));
    expect(d.status).toBe('blocked');
    if (d.status === 'blocked') expect(d.reasons).toContain('no surface');
  });

  it('blocks when the registry refuses the claim', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ evidenceStatusOf: () => 'refused' }));
    expect(d.status).toBe('blocked');
  });

  it('validated only when registry validated AND launch available AND metric-supported', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ evidenceStatusOf: () => 'validated' }));
    expect(d.status).toBe('validated');
    if (d.status === 'validated') expect(d.caveats.some((c) => /not survey-grade/i.test(c))).toBe(true);
  });

  it('caps a registry-validated product to exploratory on a cartographic-only unit claim', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ evidenceStatusOf: () => 'validated', unitClaim: 'cartographic-only' }));
    expect(d.status).toBe('exploratory');
    if (d.status === 'exploratory') {
      expect(d.watermark).toBe('EXPLORATORY');
      expect(d.caveats.some((c) => /metric contour support/i.test(c))).toBe(true);
    }
  });

  it('caps to exploratory when the launch itself is exploratory', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ launchStatus: 'exploratory', evidenceStatusOf: () => 'validated' }));
    expect(d.status).toBe('exploratory');
  });

  it('exploratory registry status is exploratory (never promoted to validated)', () => {
    const d = resolveExportDecision('contour.pdf', ctx({ evidenceStatusOf: () => 'exploratory' }));
    expect(d.status).toBe('exploratory');
    if (d.status === 'exploratory') expect(d.watermark).toBe('EXPLORATORY');
  });
});
