/**
 * A Planetary Computer catalogue EPSG is catalogue metadata, not a user choice,
 * and never replaces a CRS the file declares itself.
 *
 * The pick writes its record before the file is opened, so the record holds no
 * declaration. A stream opened from the pick that declares its own CRS keeps
 * it (the file wins, whether or not the EPSGs agree). A stream that declares
 * nothing takes the catalogue EPSG, labelled as the catalogue's and not
 * confirmed by the user.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { CrsInfo } from '../src/io/crs';
import type { PcStacItem } from '../src/io/catalog/planetaryComputer';
import { PC_CATALOGUE_LABEL, recordCatalogueCrs } from '../src/app/pcCatalogueCrs';
import { renderCrs } from '../src/ui/inspector/renderCrs';
import { FakeEl, findContaining } from './support/measurePanelDom';
import { installInspectorFakeDom } from './helpers/inspectorLazyHarness';

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
const NAME = 'USGS_LPC_CO_Tile_A.copc.laz';

const tagged = () => datasetIdentity({
  sourcePointCount: 2_000_000,
  renderOrigin: [480_000, 4_420_000, 1_600],
  dataBounds: () => [-500, -500, 0, 500, 500, 80],
  catalogItem: { id: ITEM.id, bbox: ITEM.bbox },
});

const FILE_6342: CrsInfo = {
  source: 'wkt',
  name: 'NAD83(2011) / UTM zone 13N',
  epsg: 6342,
  wkt: 'PROJCS["NAD83(2011) / UTM zone 13N",AUTHORITY["EPSG","6342"]]',
  horizontalDatum: 'NAD83(2011)',
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

function picked(): CrsService {
  const port = memoryPort();
  recordCatalogueCrs(ITEM, port);
  return new CrsService(port);
}

describe('a catalogue EPSG never overrides the file\'s own CRS', () => {
  it('file EPSG:6342, catalogue 26913: the file\'s CRS is kept, no override', () => {
    const svc = picked();
    const r = svc.resolveForScan({ name: NAME, detected: FILE_6342, source: 'copc-meta', identity: tagged() });
    expect(r.epsg).toBe(6342);
    expect(r.source).toBe('copc-meta');
    expect(r.userConfirmed).toBe(false);
    expect(r.wkt).toBe(FILE_6342.wkt);
    expect(r.horizontalDatum).toBe('NAD83(2011)');
    expect(svc.overrideSuggestion()).toBeNull();
  });

  it('equal EPSGs: the file\'s CRS and provenance are kept', () => {
    const svc = picked();
    const detected: CrsInfo = { ...FILE_6342, epsg: 26913, name: 'NAD83 / UTM zone 13N', wkt: 'PROJCS["NAD83 / UTM zone 13N"]', horizontalDatum: 'NAD83' };
    const r = svc.resolveForScan({ name: NAME, detected, source: 'copc-meta', identity: tagged() });
    expect(r.epsg).toBe(26913);
    expect(r.source).toBe('copc-meta');
    expect(r.userConfirmed).toBe(false);
    expect(r.wkt).toBe(detected.wkt);
  });
});

describe('a file declaring no CRS takes the catalogue EPSG as catalogue metadata', () => {
  it('resolves from the catalogue with catalogue provenance, not user-confirmed', () => {
    const svc = picked();
    const r = svc.resolveForScan({ name: NAME, detected: undefined, source: 'copc-meta', identity: tagged() });
    expect(r.epsg).toBe(26913);
    expect(r.source).toBe('catalog-tile');
    expect(r.assertedBy).toBe(PC_CATALOGUE_LABEL);
    expect(r.userConfirmed).toBe(false);
    expect(r.confidence).not.toBe('high');
  });

  it('a user override set afterwards on the same stream is still the user\'s', () => {
    const svc = picked();
    svc.resolveForScan({ name: NAME, detected: undefined, source: 'copc-meta', identity: tagged() });
    svc.setOverride({ override: { epsg: 6342, kind: 'projected' }, detected: undefined, source: 'copc-meta' });
    const again = new CrsService((svc as unknown as { _port: CrsOverridePort })._port)
      .resolveForScan({ name: NAME, detected: undefined, source: 'copc-meta', identity: tagged() });
    expect(again.epsg).toBe(6342);
    expect(again.source).toBe('user-override');
    expect(again.userConfirmed).toBe(true);
  });
});

describe('Inspector wording for a catalogue CRS', () => {
  beforeAll(() => installInspectorFakeDom());

  it('says the CRS came from the catalogue entry, not an override', () => {
    const r = picked().resolveForScan({ name: NAME, detected: undefined, source: 'copc-meta', identity: tagged() });
    const body = new FakeEl('div');
    renderCrs(body as unknown as HTMLElement, r, () => {});
    expect(findContaining(body, 'CRS override active')).toBeUndefined();
    expect(findContaining(body, `catalogue (${PC_CATALOGUE_LABEL})`)).toBeDefined();
    expect(findContaining(body, 'from the catalogue entry')).toBeDefined();
  });
});
