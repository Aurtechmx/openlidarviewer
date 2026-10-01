/**
 * A swissSURFACE3D COPC tile carries no CRS record: LAS 1.4, global encoding
 * 17 (WKT bit set), PDRF 6, the COPC info and LAZ VLRs only, and a single EVLR
 * that is the COPC hierarchy. Streamed from the curated swisstopo record, it
 * must resolve to the product's stated frame (LV95, metres, LN02) as a
 * labelled catalogue assertion that a file CRS and a user CRS both outrank.
 */
import { describe, it, expect } from 'vitest';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { CopcSource } from '../src/io/copc/CopcSource';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { CURATED_LOCATIONS } from '../src/io/catalog/curatedLocations';
import { CATALOGUE_CRS_ASSERTIONS, catalogueCrsFor } from '../src/io/catalog/catalogueCrs';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import { crsOriginOf } from '../src/science/crsOrigin';
import { footprintCrsRefusal } from '../src/export/scanFootprint';
import { makeLocalToLonLat } from '../src/export/lonLatMapper';
import { horizontalCrsProvider, verticalReferenceProvider } from '../src/process/stateProviders';

function memoryPort(): CrsOverridePort {
  const m = new Map<string, unknown>();
  return {
    get: (k) => m.get(k) as ReturnType<CrsOverridePort['get']>,
    set: (k, v) => void m.set(k, v),
    clear: (k) => void m.delete(k),
  };
}

const SWISS = CURATED_LOCATIONS.find((l) => l.id === 'flai-ch-swisssurface3d-2022')!;

/** The real tile's header structure, without a CRS record. */
function swissLikeCopc(): ArrayBuffer {
  const synth = buildSyntheticCopc({
    scale: [0.01, 0.01, 0.01],
    offset: [2485000, 1109000, 0],
    center: [2485500, 1109500, 830],
    halfsize: 500,
    headerMin: [2485000, 1109000, 329.97],
    headerMax: [2485999.99, 1109999.99, 467.86],
    spacing: 6.80265306122601,
  });
  new DataView(synth.buffer).setUint16(6, 17, true);
  return synth.buffer;
}

function httpRange(buffer: ArrayBuffer, url: string): RangeSource {
  const inner = new ArrayBufferRangeSource(buffer, url);
  return Object.assign(Object.create(inner) as RangeSource, { kind: () => 'http-range' as const });
}

describe('swissSURFACE3D header structure', () => {
  it('carries no CRS record, so the file alone resolves none', async () => {
    const source = await CopcSource.open(new ArrayBufferRangeSource(swissLikeCopc()));
    const v = new DataView(swissLikeCopc());
    expect(v.getUint16(6, true) & 16).toBe(16);
    expect(v.getUint32(243, true)).toBe(1);
    expect(source.metadata.header.crs).toBeNull();
  });
});

describe('catalogue CRS assertion', () => {
  it('each entry matches its curated record: URL, id and native EPSG', () => {
    for (const [url, a] of Object.entries(CATALOGUE_CRS_ASSERTIONS)) {
      const loc = CURATED_LOCATIONS.find((l) => l.streamUrl === url);
      expect(loc?.id, url).toBe(a.id);
      expect(loc?.nativeEpsg).toBe(a.horizontalEpsg);
    }
  });

  it('asserts the native EPSG, metres and LN02 for the swisstopo tile only', () => {
    const crs = catalogueCrsFor(SWISS.streamUrl)!;
    expect(crs.epsg).toBe(SWISS.nativeEpsg);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.verticalEpsg).toBe(5728);
    expect(crs.verticalDatum).toBe('LN02 height');
    expect(crs.catalogue).toBe('swisstopo LV95');
    for (const other of CURATED_LOCATIONS.filter((l) => l !== SWISS)) {
      expect(catalogueCrsFor(other.streamUrl)).toBeNull();
    }
    expect(catalogueCrsFor('https://example.com/2485_1109.copc.laz')).toBeNull();
  });

  it('a streamed swisstopo tile with no CRS record gets the catalogue CRS', async () => {
    const cloud = await StreamingPointCloud.open(httpRange(swissLikeCopc(), SWISS.streamUrl), '2485_1109.copc.laz');
    expect(cloud.crs()?.epsg).toBe(SWISS.nativeEpsg);
    expect(cloud.crs()?.catalogue).toBe('swisstopo LV95');
  });

  it('a local file with the same bytes gets no CRS', async () => {
    const cloud = await StreamingPointCloud.open(new ArrayBufferRangeSource(swissLikeCopc(), SWISS.streamUrl), 'x.copc.laz');
    expect(cloud.crs()).toBeNull();
  });

  it('resolves to the labelled catalog-tile source with medium confidence', () => {
    const r = resolvedFromCrsInfo(catalogueCrsFor(SWISS.streamUrl)!, 'copc-meta')!;
    expect(r.source).toBe('catalog-tile');
    expect(r.assertedBy).toBe('swisstopo LV95');
    expect(r.kind).toBe('projected');
    expect(r.confidence).toBe('medium');
    expect(crsOriginOf(r)).toMatchObject({
      source: 'catalog-tile (swisstopo LV95)',
      epsg: `EPSG:${SWISS.nativeEpsg}`,
      verticalDatum: 'EPSG:5728',
    });
  });

  it('enables the footprint and places the tile centre in Switzerland', () => {
    const r = resolvedFromCrsInfo(catalogueCrsFor(SWISS.streamUrl)!, 'copc-meta')!;
    expect(footprintCrsRefusal(r)).toBeNull();
    const toLonLat = makeLocalToLonLat(r, [2485500, 1109500, 0])!;
    expect(toLonLat).not.toBeNull();
    const [lon, lat] = toLonLat([0, 0, 0]);
    // swisstopo's published approximate LV95 -> WGS84 formulas.
    const y = (2485500 - 2600000) / 1e6;
    const x = (1109500 - 1200000) / 1e6;
    const lonS = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
    const latS = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
    const lonRef = (lonS * 100) / 36;
    const latRef = (latS * 100) / 36;
    const dE = (lon - lonRef) * 111320 * Math.cos((latRef * Math.PI) / 180);
    const dN = (lat - latRef) * 110540;
    // Both sides are approximations: swisstopo's polynomial degrades with
    // distance from Bern (this tile is ~115 km west), and the proj4 path uses
    // the 3-parameter CH1903+ -> WGS 84 shift. They agree to about 3 m here.
    expect(Math.hypot(dE, dN)).toBeLessThan(5);
    expect(lon).toBeCloseTo(5.9572, 3);
    expect(lat).toBeCloseTo(46.1272, 3);
  });

  it('shows the CRS and its catalogue source in the state strip', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: '2485_1109.copc.laz', detected: catalogueCrsFor(SWISS.streamUrl)!, source: 'copc-meta' });
    const fact = horizontalCrsProvider(svc.context(), svc.current());
    expect(fact.source).toBe('catalog-tile');
    expect(fact.value.epsg).toBe(SWISS.nativeEpsg);
    expect(fact.value.linearUnit).toBe('metre');
    expect(fact.value.assertedBy).toBe('swisstopo LV95');
    // The gate behind metric lengths, areal density and a numeric map scale.
    expect(svc.context().metricClaimsPermitted).toBe(true);
    expect(svc.context().linearUnitKnown).toBe(true);
    expect(svc.context().verticalDatum).toBe('LN02 height');
    const vertical = verticalReferenceProvider(svc.context());
    expect(vertical.value.label).toBe('Vertical: LN02 height');
    expect(vertical.validity).toBe('measured');
  });

  it('a user-set CRS still overrides the catalogue assertion', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: '2485_1109.copc.laz', detected: catalogueCrsFor(SWISS.streamUrl)!, source: 'copc-meta' });
    const detected = catalogueCrsFor(SWISS.streamUrl)!;
    svc.setOverride({ override: { epsg: 21781, kind: 'projected' }, detected, source: 'copc-meta' });
    expect(svc.current()?.source).toBe('user-override');
    expect(svc.current()?.epsg).toBe(21781);
    svc.setOverride({ override: { epsg: null, kind: 'detected' }, detected, source: 'copc-meta' });
    expect(svc.current()?.source).toBe('catalog-tile');
  });
});
