/**
 * contourExportAdapter.test.ts
 *
 * Integration test for the export ORCHESTRATION (audit follow-up): drive the
 * ContourExportAdapter with a fake host + button and assert that a click routes
 * through the §19 permit to the RIGHT exporter — a granted contour product mints
 * a permit and calls the vector/PDF exporter, a blocked launch state writes
 * nothing and flashes the button, and the DEM package / report take their own
 * path. This is the seam the panel wiring depends on, proven end-to-end without
 * a DOM.
 */

import { describe, it, expect } from 'vitest';
import { ContourExportAdapter, type ContourExportHost } from '../src/ui/contourExportAdapter';
import type { ContourExportIntent } from '../src/terrain/contourStudio/contourExportIntent';
import type { ContourExportFrameFacts, ContourExportPermit } from '../src/export/contourExportPermit';

/** A recording host — every call is captured for assertion. */
function fakeHost() {
  const calls = {
    vector: [] as Array<{ fmt: string; permit: ContourExportPermit; contourMethod?: string; deliverablePurpose?: string }>,
    mapPdf: [] as ContourExportPermit[],
    dem: 0,
    report: 0,
    styles: [] as string[],
  };
  const host: ContourExportHost = {
    setContourStyle: (s) => { calls.styles.push(s); },
    exportVector: async (fmt, opts) => {
      calls.vector.push({ fmt, permit: opts.permit, contourMethod: opts.contourMethod, deliverablePurpose: opts.deliverablePurpose });
    },
    openMapPdf: (permit) => { calls.mapPdf.push(permit); },
    exportDemPackage: async () => { calls.dem++; },
    exportTerrainReport: async () => { calls.report++; },
  };
  return { host, calls };
}

const btn = (): HTMLButtonElement =>
  ({ textContent: 'Export', disabled: false } as unknown as HTMLButtonElement);

const intent = (over: Partial<ContourExportIntent> = {}): ContourExportIntent => ({
  purpose: 'Survey Review',
  shapeStyle: 'crisp',
  labelsIndexOnly: false,
  methodId: 'olv.contour.analytical',
  methodVersion: 1,
  methodTag: 'olv.contour.analytical@1',
  ...over,
});

/** A fully-supported frame (available + known unit + projected). */
const okFrame: ContourExportFrameFacts = {
  launchStatus: 'available',
  verticalUnitsKnown: true,
  crsProjected: true,
};

describe('ContourExportAdapter — gated dispatch', () => {
  it('routes a granted analytical GeoJSON through the permit to the vector exporter', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('geojson', btn(), intent(), okFrame);
    expect(calls.vector).toHaveLength(1);
    expect(calls.vector[0].fmt).toBe('geojson');
    expect(calls.vector[0].permit.ok).toBe(true);
    expect(calls.vector[0].permit.exporterId).toBe('contour.geojson.analytical');
    // The purpose provenance is threaded into the export.
    expect(calls.vector[0].contourMethod).toBe('olv.contour.analytical@1');
    expect(calls.vector[0].deliverablePurpose).toBe('Survey Review');
    // Nothing else fired.
    expect(calls.mapPdf).toHaveLength(0);
    expect(calls.dem).toBe(0);
    expect(calls.report).toBe(0);
    // The geometry style was adopted from the intent.
    expect(calls.styles).toEqual(['crisp']);
  });

  it('mints the cartographic exporter for a generalized SVG (never analytical)', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle(
      'svg', btn(),
      intent({ shapeStyle: 'generalized', methodId: 'olv.contour.generalize.terrain-adaptive', methodTag: 'olv.contour.generalize.terrain-adaptive@1', purpose: 'Presentation Map' }),
      okFrame,
    );
    expect(calls.vector[0].fmt).toBe('svg');
    expect(calls.vector[0].permit.exporterId).toBe('contour.svg.cartographic');
  });

  it('sends the map PDF to openMapPdf with a granted permit (no vector export)', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('pdf', btn(), intent(), okFrame);
    expect(calls.mapPdf).toHaveLength(1);
    expect(calls.mapPdf[0].ok).toBe(true);
    expect(calls.vector).toHaveLength(0);
  });

  it('writes NOTHING and flashes the button when the launch state is blocked', () => {
    const { host, calls } = fakeHost();
    const b = btn();
    new ContourExportAdapter(host).handle('geojson', b, intent(), {
      launchStatus: 'unavailable',
      verticalUnitsKnown: true,
      crsProjected: true,
      blockedReasons: ['No usable ground points.'],
    });
    expect(calls.vector).toHaveLength(0);
    expect(calls.mapPdf).toHaveLength(0);
    expect(b.textContent).toBe('Blocked');
  });

  it('routes the DEM package and report to their own exporters (own gate, no permit)', () => {
    const { host, calls } = fakeHost();
    const a = new ContourExportAdapter(host);
    a.handle('package', btn(), intent(), okFrame);
    a.handle('report', btn(), intent(), okFrame);
    expect(calls.dem).toBe(1);
    expect(calls.report).toBe(1);
    expect(calls.vector).toHaveLength(0);
    expect(calls.mapPdf).toHaveLength(0);
  });

  it('caps to an exploratory (still granted) permit when the vertical unit is unknown', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('dxf', btn(), intent(), {
      launchStatus: 'available',
      verticalUnitsKnown: false, // cartographic-only ⇒ exploratory
      crsProjected: true,
    });
    expect(calls.vector).toHaveLength(1);
    expect(calls.vector[0].permit.ok).toBe(true);
    if (calls.vector[0].permit.ok) {
      expect(calls.vector[0].permit.decision.status).toBe('exploratory');
    }
  });
});
