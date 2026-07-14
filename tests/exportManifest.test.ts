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
import { exportGate } from '../src/validation/evidenceRegistry';

const ctx = (over: Partial<ExportDecisionContext> = {}): ExportDecisionContext => ({
  launchStatus: 'available',
  unitClaim: 'metric-supported',
  ...over,
});

describe('SCIENTIFIC_EXPORTERS registry', () => {
  it('every exporter requires an evidence decision and names a real claim id', () => {
    for (const e of SCIENTIFIC_EXPORTERS) {
      expect(e.requiresEvidenceDecision).toBe(true);
      // The claim id must resolve through the registry gate (throws if unknown).
      expect(() => exportGate(e.claimId)).not.toThrow();
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
