/**
 * contourExportPermit.test.ts
 *
 * Pins the single authoritative contour export permit (§19 enforcement):
 *  - every gated product maps to a REGISTERED exporter (no file type bypasses
 *    the registry);
 *  - a blocked / unavailable launch state refuses the permit (writes nothing);
 *  - the decision is downgrade-only through the permit — validated requires the
 *    registry validated AND launch 'available' AND metric-supported units, and
 *    any shortfall caps to exploratory with a watermark.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveContourExportPermit,
  exporterIdForContourProduct,
  type ContourPermitProduct,
  type ContourPermitContext,
} from '../src/export/contourExportPermit';
import { exporterRegistration } from '../src/export/exportManifest';

const ALL_PRODUCTS: ContourPermitProduct[] = [
  'pdf',
  'geojson',
  'dxf',
  'svg',
  'dem',
  'complete-package',
  'report',
];

/** A fully-supported context with an injectable registry status. */
function ctx(over: Partial<ContourPermitContext> = {}): ContourPermitContext {
  return {
    launchStatus: 'available',
    verticalUnitsKnown: true,
    crsProjected: true,
    analyticalGeometry: false,
    evidenceStatusOf: () => 'validated',
    ...over,
  };
}

describe('contour export permit — registration (no bypass)', () => {
  it('maps every gated product + geometry variant to a REGISTERED exporter', () => {
    for (const product of ALL_PRODUCTS) {
      for (const analyticalGeometry of [true, false]) {
        const id = exporterIdForContourProduct(product, analyticalGeometry);
        expect(exporterRegistration(id), `${product}/${analyticalGeometry} → ${id}`).toBeDefined();
      }
    }
  });

  it('splits GeoJSON on geometry so a generalized line is never minted analytical', () => {
    expect(exporterIdForContourProduct('geojson', true)).toBe('contour.geojson.analytical');
    expect(exporterIdForContourProduct('geojson', false)).toBe('contour.geojson.cartographic');
    // SVG is always cartographic — the analytical flag can't promote it.
    expect(exporterIdForContourProduct('svg', true)).toBe('contour.svg.cartographic');
  });
});

describe('contour export permit — refusal (writes nothing)', () => {
  it('refuses when the launch state is unavailable, carrying its reasons', () => {
    const p = resolveContourExportPermit('geojson', ctx({
      launchStatus: 'unavailable',
      blockedReasons: ['No usable ground points.'],
    }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons).toContain('No usable ground points.');
  });

  it('refuses when the scan is not analyzed', () => {
    const p = resolveContourExportPermit('pdf', ctx({ launchStatus: 'not-analyzed' }));
    expect(p.ok).toBe(false);
  });

  it('refuses when the registry has refused the claim', () => {
    const p = resolveContourExportPermit('dxf', ctx({ evidenceStatusOf: () => 'refused' }));
    expect(p.ok).toBe(false);
  });

  it('refuses the terrain report when the launch state is unavailable', () => {
    const p = resolveContourExportPermit('report', ctx({
      launchStatus: 'unavailable',
      blockedReasons: ['No terrain surface has been computed.'],
    }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons).toContain('No terrain surface has been computed.');
  });
});

describe('contour export permit — downgrade-only', () => {
  it('grants validated only when registry-validated AND available AND metric-supported', () => {
    const p = resolveContourExportPermit('geojson', ctx({ analyticalGeometry: true }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.decision.status).toBe('validated');
  });

  it('caps to exploratory when the vertical unit is unknown (cartographic-only)', () => {
    const p = resolveContourExportPermit('geojson', ctx({ verticalUnitsKnown: false }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.decision.status).toBe('exploratory');
      if (p.decision.status === 'exploratory') expect(p.decision.watermark).toBeTruthy();
    }
  });

  it('caps to exploratory when the CRS is geographic (not projected)', () => {
    const p = resolveContourExportPermit('geojson', ctx({ crsProjected: false }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.decision.status).toBe('exploratory');
  });

  it('caps to exploratory when the launch state is only exploratory', () => {
    const p = resolveContourExportPermit('svg', ctx({ launchStatus: 'exploratory' }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.decision.status).toBe('exploratory');
  });

  it('caps to exploratory when the registry has not validated the claim', () => {
    const p = resolveContourExportPermit('pdf', ctx({ evidenceStatusOf: () => 'exploratory' }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.decision.status).toBe('exploratory');
  });

  it('grants the terrain report validated only when fully supported, downgrade-only otherwise', () => {
    // Fully supported + registry-validated ⇒ validated (never promoted past it).
    const validated = resolveContourExportPermit('report', ctx());
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.decision.status).toBe('validated');
    // An exploratory launch caps the SAME product to exploratory + watermark.
    const capped = resolveContourExportPermit('report', ctx({ launchStatus: 'exploratory' }));
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.decision.status).toBe('exploratory');
      if (capped.decision.status === 'exploratory') expect(capped.decision.watermark).toBeTruthy();
    }
  });
});
