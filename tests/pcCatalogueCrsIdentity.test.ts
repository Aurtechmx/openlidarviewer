/**
 * A Planetary Computer pick records the item's catalogue EPSG for that item
 * only.
 *
 * The pick used to write a record keyed by the STAC item id with no identity
 * at all. The stream it opens is named after the asset file, so the record was
 * keyed under a name no open used, and had it matched it would have been a
 * legacy record that only ever suggests.
 *
 * The record is now keyed by the asset file name the stream opens under, and
 * carries the catalogue item (id and WGS84 bbox) as its identity. A stream
 * opened from that pick is tagged with the same item and verifies; a stream of
 * the same name not opened from the catalogue is offered the EPSG as a
 * suggestion; a stream tagged with another item is neither.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, datasetIdentity, OVERRIDE_IDENTITY_VERSION, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { PcStacItem } from '../src/io/catalog/planetaryComputer';
import { catalogueItemFor, catalogueOverrideFor, recordCatalogueCrs } from '../src/app/pcCatalogueCrs';

function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: Date.now() }); },
    clear: (key) => { entries.delete(key); },
  };
}

const ITEM: PcStacItem = {
  id: 'USGS_LPC_CO_Tile_A',
  source: 'copc',
  assetUrl: 'https://example.blob.core.windows.net/usgs-lidar-public/CO/USGS_LPC_CO_Tile_A.copc.laz',
  bbox: [-105.1, 39.9, -105.0, 40.0],
  epsg: 26913,
};

/** A COPC stream as the open builds it, optionally tagged with its catalogue item. */
function stream(catalogItem?: { id: string; bbox: readonly [number, number, number, number] }) {
  return {
    sourcePointCount: 2_000_000,
    renderOrigin: [480_000, 4_420_000, 1_600] as [number, number, number],
    dataBounds: () => [-500, -500, 0, 500, 500, 80] as readonly number[],
    ...(catalogItem ? { catalogItem } : {}),
  };
}

describe('catalogueOverrideFor', () => {
  it('keys the record by the asset file name and records the item as its identity', () => {
    const rec = catalogueOverrideFor(ITEM);
    expect(rec?.datasetKey).toBe('usgs_lpc_co_tile_a.copc.laz');
    expect(rec?.override).toMatchObject({
      epsg: 26913,
      kind: 'projected',
      identityVersion: OVERRIDE_IDENTITY_VERSION,
      identity: { catalogItem: { id: 'USGS_LPC_CO_Tile_A', bbox: [-105.1, 39.9, -105.0, 40.0] } },
    });
  });

  it('writes nothing for an item without a catalogue EPSG', () => {
    expect(catalogueOverrideFor({ ...ITEM, epsg: undefined })).toBeNull();
  });
});

describe('catalogueItemFor', () => {
  it('finds a picked item by its asset URL, ignoring the signing query', () => {
    recordCatalogueCrs(ITEM, memoryPort());
    expect(catalogueItemFor(`${ITEM.assetUrl}?sv=2021&sig=abc`)).toEqual({ id: ITEM.id, bbox: ITEM.bbox });
    expect(catalogueItemFor('https://example.blob.core.windows.net/other/Tile_B.copc.laz')).toBeUndefined();
    expect(catalogueItemFor('not a url')).toBeUndefined();
  });
});

describe('the catalogue EPSG applies to the picked item only', () => {
  it('a stream opened from the pick verifies and applies', () => {
    const port = memoryPort();
    recordCatalogueCrs(ITEM, port);
    const svc = new CrsService(port);
    const r = svc.resolveForScan({
      name: 'USGS_LPC_CO_Tile_A.copc.laz', detected: undefined, source: 'copc-meta',
      identity: datasetIdentity(stream({ id: ITEM.id, bbox: ITEM.bbox })),
    });
    expect(r.epsg).toBe(26913);
    expect(r.userConfirmed).toBe(true);
    expect(svc.overrideSuggestion()).toBeNull();
  });

  it('a same-named stream not opened from the catalogue gets a suggestion, not the EPSG', () => {
    const port = memoryPort();
    recordCatalogueCrs(ITEM, port);
    const svc = new CrsService(port);
    const r = svc.resolveForScan({
      name: 'USGS_LPC_CO_Tile_A.copc.laz', detected: undefined, source: 'copc-meta',
      identity: datasetIdentity(stream()),
    });
    expect(r.epsg).toBeUndefined();
    expect(svc.overrideSuggestion()).toMatchObject({ epsg: 26913, reason: 'identity-missing' });
  });

  it('a stream tagged with a different item is neither applied nor offered', () => {
    const port = memoryPort();
    recordCatalogueCrs(ITEM, port);
    const svc = new CrsService(port);
    const r = svc.resolveForScan({
      name: 'USGS_LPC_CO_Tile_A.copc.laz', detected: undefined, source: 'copc-meta',
      identity: datasetIdentity(stream({ id: 'USGS_LPC_CO_Tile_Z', bbox: ITEM.bbox })),
    });
    expect(r.epsg).toBeUndefined();
    expect(svc.overrideSuggestion()).toBeNull();
  });

  it('a stream declaring its own CRS keeps it', () => {
    const port = memoryPort();
    recordCatalogueCrs(ITEM, port);
    const svc = new CrsService(port);
    const r = svc.resolveForScan({
      name: 'USGS_LPC_CO_Tile_A.copc.laz',
      detected: { source: 'epsg', name: 'NAD83 / UTM zone 13N', epsg: 26913, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false },
      source: 'copc-meta',
      identity: datasetIdentity(stream({ id: ITEM.id, bbox: ITEM.bbox })),
    });
    expect(r.epsg).toBe(26913);
  });
});
