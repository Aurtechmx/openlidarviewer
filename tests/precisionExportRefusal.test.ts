/**
 * tests/precisionExportRefusal.test.ts
 *
 * The refusal itself, at the one seam every registered scientific deliverable
 * already passes through. If a product could reach a file without consulting
 * `resolveExportDecision`, this policy would not cover it — so the first test
 * here is that the registry and the resolver still agree on the set.
 */

import { describe, it, expect } from 'vitest';
import {
  SCIENTIFIC_EXPORTERS,
  resolveExportDecision,
  type ExportDecisionContext,
} from '../src/export/exportManifest';
import { resolveContourExportPermit } from '../src/export/contourExportPermit';
import { scanPrecisionPermit } from '../src/app/scanPrecision';
import type { PrecisionPermit } from '../src/geo/inMemoryPrecision';

const METRE = { linearUnit: 'metre', linearUnitToMetres: 1 } as const;

/** A permit minted from a real extent, so the fixtures are measured, not typed. */
function permitForSpan(span: number): PrecisionPermit {
  const permit = scanPrecisionPermit({
    cloud: {
      sourceOrigin: [500_000, 4_500_000, 0],
      bounds: () => ({ min: [0, 0, 0], max: [span, span, span / 20] }),
    },
    crs: METRE,
  });
  if (!permit) throw new Error('fixture produced no permit');
  return permit;
}

const ctx = (over: Partial<ExportDecisionContext> = {}): ExportDecisionContext => ({
  launchStatus: 'available',
  unitClaim: 'metric-supported',
  precision: null,
  evidenceStatusOf: () => 'validated',
  ...over,
});

describe('precision refusal — coverage of the deliverable set', () => {
  it('blocks every registered scientific exporter when the permit is refused', () => {
    const refused = permitForSpan(400_000);
    expect(refused.ok).toBe(false);
    for (const reg of SCIENTIFIC_EXPORTERS) {
      const decision = resolveExportDecision(reg.exporterId, ctx({ precision: refused }));
      expect(decision.status, reg.exporterId).toBe('blocked');
    }
  });

  it('carries the measured figure and the remedy into the decision reasons', () => {
    const decision = resolveExportDecision(
      'contour.pdf',
      ctx({ precision: permitForSpan(400_000) }),
    );
    expect(decision.status).toBe('blocked');
    if (decision.status !== 'blocked') return;
    const text = decision.reasons.join(' ');
    expect(text).toMatch(/mm/);
    expect(text.toLowerCase()).toContain('tile');
    expect(text.toLowerCase()).toContain('copc');
  });

  it('leaves a within-budget scan validated, so the gate is not a blanket refusal', () => {
    const decision = resolveExportDecision('contour.pdf', ctx({ precision: permitForSpan(2_000) }));
    expect(decision.status).toBe('validated');
  });

  it('does not refuse when no scan frame was measured', () => {
    expect(resolveExportDecision('contour.pdf', ctx({ precision: null })).status).toBe('validated');
  });

  it('blocks every deliverable when the scan declares no measurable extent', () => {
    // A streaming source whose declared data box collapses to a point and that
    // offers no octree cube to fall back on. Before the frame check this minted
    // a granted permit (reach 0, a 1.4e-45 m step, grade `fine`), so a terrain
    // report could be stamped from a frame that was never established.
    const permit = scanPrecisionPermit({
      streaming: {
        renderOrigin: [0, 0, 0],
        dataBounds: () => [0, 0, 0, 0, 0, 0],
      },
      crs: METRE,
    });
    expect(permit).not.toBeNull();
    expect(permit!.ok).toBe(false);
    for (const reg of SCIENTIFIC_EXPORTERS) {
      const decision = resolveExportDecision(reg.exporterId, ctx({ precision: permit }));
      expect(decision.status, reg.exporterId).toBe('blocked');
    }
  });

  it('reports the launch failure first when both a launch and precision block', () => {
    // "There is no usable surface" answers the question more fundamentally than
    // "the surface would be too coarse", so it must not be masked.
    const decision = resolveExportDecision(
      'contour.pdf',
      ctx({
        launchStatus: 'unavailable',
        blockedReasons: ['no surface'],
        precision: permitForSpan(400_000),
      }),
    );
    expect(decision.status).toBe('blocked');
    if (decision.status !== 'blocked') return;
    expect(decision.reasons).toContain('no surface');
  });
});

describe('precision refusal — through the contour export permit', () => {
  const products = [
    'pdf',
    'geojson',
    'geojson-native',
    'dxf',
    'svg',
    'dem',
    'complete-package',
    'report',
  ] as const;

  it('refuses every Studio product on an over-budget scan', () => {
    for (const product of products) {
      const permit = resolveContourExportPermit(product, {
        launchStatus: 'available',
        verticalUnitsKnown: true,
        crsProjected: true,
        analyticalGeometry: false,
        precision: permitForSpan(400_000),
        evidenceStatusOf: () => 'validated',
      });
      expect(permit.ok, product).toBe(false);
    }
  });

  it('grants every Studio product on a within-budget scan', () => {
    for (const product of products) {
      const permit = resolveContourExportPermit(product, {
        launchStatus: 'available',
        verticalUnitsKnown: true,
        crsProjected: true,
        analyticalGeometry: false,
        precision: permitForSpan(2_000),
        evidenceStatusOf: () => 'validated',
      });
      expect(permit.ok, product).toBe(true);
    }
  });
});
