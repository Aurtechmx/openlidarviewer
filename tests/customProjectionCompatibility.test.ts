/**
 * A CRS with no EPSG code is identified by its definition, not by its name.
 * Two custom projections that share a generic name ("Site Grid") but differ in
 * a defining parameter are different frames; the same definition may match;
 * a name with no definition to compare proves nothing. The generic "Local
 * coordinates" choice declares no frame, so two scans marked Local stay
 * unknown to each other.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { compatibilityFrameOf } from '../src/model/compatibilityFrame';
import { classifyLayerCompatibility, type CompatibilityInput } from '../src/model/layerCompatibility';
import { resolveStreamingCompatibilityFromCrs } from '../src/render/streamingCompatibility';
import { resolvedExportCrs } from '../src/app/exportCrsResolver';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import { detectCrsMismatch, horizontalKey as panelKey, type LayerInfo } from '../src/model/layerModel';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

type Tm = { fe?: number; fn?: number; cm?: number; lat0?: number; k?: number; unit?: [string, number]; a?: number; method?: string; datum?: string };
const projcs = (o: Tm = {}) =>
  `PROJCS["Site Grid",GEOGCS["GRS 1980(IUGG, 1980)",DATUM["${o.datum ?? 'unknown'}",SPHEROID["GRS80",${o.a ?? 6378137},298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["${o.method ?? 'Transverse_Mercator'}"],PARAMETER["latitude_of_origin",${o.lat0 ?? 0}],PARAMETER["central_meridian",${o.cm ?? -117}],PARAMETER["scale_factor",${o.k ?? 1}],PARAMETER["false_easting",${o.fe ?? 500000}],PARAMETER["false_northing",${o.fn ?? 0}],UNIT["${(o.unit ?? ['metre', 1])[0]}",${(o.unit ?? ['metre', 1])[1]}]]`;
const compd = (o: Tm = {}) =>
  `COMPD_CS["Site Grid + NAVD88",${projcs(o)},VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["metre",1],AXIS["Up",UP]]]`;

const resolved = (wkt: string): ResolvedCrs => resolvedFromCrsInfo(crsFromWkt(wkt), 'las-vlr')!;
const input = (id: string, wkt: string): CompatibilityInput => ({ id, ...compatibilityFrameOf(resolved(wkt)) });
const pair = (a: string, b: string) => classifyLayerCompatibility([input('a', a), input('b', b)]);

describe('same-name custom projections compare their definitions', () => {
  // Which one of a tied pair is held out is arbitrary but stable (see
  // layerCompatibility.test.ts). What must hold is that the two do not share
  // a frame: exactly one of them is incompatible, so the pair is never
  // verified (or aligned) together.
  const notSharingAFrame = (v: Map<string, string>) => {
    const states = [v.get('a'), v.get('b')];
    expect(states.filter((s) => s === 'incompatible')).toHaveLength(1);
  };

  it('a different false easting is not verified (compound with NAVD88)', () => {
    notSharingAFrame(pair(compd({ fe: 500000 }), compd({ fe: 596000 })));
  });

  it('a different central meridian does not align the pair', () => {
    notSharingAFrame(pair(projcs({ cm: -117 }), projcs({ cm: -118 })));
  });

  it.each<[string, Tm]>([
    ['false northing', { fn: 100000 }],
    ['latitude of origin', { lat0: 30 }],
    ['scale factor', { k: 0.9996 }],
    ['unit', { unit: ['US survey foot', 0.304800609601219] }],
    ['ellipsoid', { a: 6378206.4 }],
    ['datum', { datum: 'North_American_Datum_1983' }],
    ['projection method', { method: 'Lambert_Conformal_Conic_1SP' }],
  ])('a different %s does not match', (_label, diff) => {
    notSharingAFrame(pair(compd(), compd(diff)));
  });

  // A pair that cannot be compared: one of them may stay in the frame as the
  // reference (as one layer would), the other is unknown, never incompatible.
  const unprovenPair = (v: Map<string, string>) => {
    expect([v.get('a'), v.get('b')]).toContain('unknown');
    expect([v.get('a'), v.get('b')]).not.toContain('incompatible');
  };

  it('comparable definitions that differ are incompatible', () => {
    const v = pair(projcs({ fe: 500000 }), projcs({ fe: 596000 }));
    expect([v.get('a'), v.get('b')].sort()).toEqual(['horizontal-only', 'incompatible']);
  });

  it('a WKT1 and a WKT2 spelling of the same CRS cannot be compared, so the pair is unknown', () => {
    const wkt2 = 'PROJCRS["Site Grid",BASEGEOGCRS["GRS 1980(IUGG, 1980)",DATUM["unknown",ELLIPSOID["GRS80",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["unnamed",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",-117,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",1,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["easting",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing",north,ORDER[2],LENGTHUNIT["metre",1]]]';
    expect(resolved(wkt2).name).toBe(resolved(projcs()).name);
    unprovenPair(pair(projcs(), wkt2));
  });

  it('a definition missing a parameter cannot be compared, so the pair is unknown', () => {
    const missing = projcs().replace(',PARAMETER["false_northing",0]', '');
    unprovenPair(pair(projcs(), missing));
  });

  it('a name with a definition beside the same name without one is unknown', () => {
    unprovenPair(classifyLayerCompatibility([input('a', projcs()), { id: 'b', crsName: resolved(projcs()).name }]));
  });

  it('the same definition still matches', () => {
    expect([...pair(compd(), compd()).values()]).toEqual(['verified', 'verified']);
    expect([...pair(projcs(), projcs()).values()]).toEqual(['horizontal-only', 'horizontal-only']);
  });

  it('the same definition written with different spacing and number spelling still matches', () => {
    const spaced = compd().replace(/,/g, ', ').replace('6378137', '6378137.0').replace('500000', '5.0e5');
    expect([...pair(compd(), spaced).values()]).toEqual(['verified', 'verified']);
  });

  it('a name with no definition to compare is no stronger than unknown', () => {
    const named = (id: string): CompatibilityInput => ({ id, crsName: 'Site Grid', verticalEpsg: 5703 });
    const v = classifyLayerCompatibility([named('a'), named('b')]);
    expect([...v.values()]).toEqual(['unknown', 'unknown']);
  });

  it('the streaming path applies the same rule', () => {
    const statics = [resolved(compd({ fe: 500000 })), resolved(compd({ fe: 500000 }))];
    expect(resolveStreamingCompatibilityFromCrs(statics, resolved(compd({ fe: 596000 })))).toBe('incompatible');
    expect(resolveStreamingCompatibilityFromCrs([resolved(compd())], resolved(compd()))).toBe('verified');
  });

  it('EPSG-coded CRSs still match on the code', () => {
    const utm = (fe: number) => `PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["false_easting",${fe}],UNIT["metre",1],AUTHORITY["EPSG","32611"]]`;
    expect([...pair(utm(500000), utm(500000.0)).values()]).toEqual(['horizontal-only', 'horizontal-only']);
  });

  it('the export conflict key separates same-name definitions', () => {
    const a = resolvedExportCrs(resolved(projcs({ fe: 500000 })));
    const b = resolvedExportCrs(resolved(projcs({ fe: 596000 })));
    const c = resolvedExportCrs(resolved(projcs({ fe: 500000 })));
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(c.key);
  });
});

function makePort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return { get: (k) => store.get(k), set: (k, o) => void store.set(k, { ...o, updatedAt: 1 }), clear: (k) => void store.delete(k) };
}

describe('the generic Local coordinates choice declares no shared frame', () => {
  it('two unrelated scans marked Local stay unknown', () => {
    const svc = new CrsService(makePort());
    const inputs = ['siteA.laz', 'siteB.laz'].map((name) => {
      svc.resolveForScan({ name, detected: undefined, source: 'las-vlr' });
      const r = svc.setOverride({ override: { epsg: null, kind: 'local' }, detected: undefined, source: 'las-vlr' })!;
      expect(r.kind).toBe('local');
      return { id: name, ...compatibilityFrameOf(r) };
    });
    const v = classifyLayerCompatibility(inputs);
    expect([...v.values()]).toEqual(['unknown', 'unknown']);
  });

  it('a Local scan beside a georeferenced one stays unknown and does not take the frame', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({ name: 'phone.ply', detected: undefined, source: 'las-vlr' });
    const local = svc.setOverride({ override: { epsg: null, kind: 'local' }, detected: undefined, source: 'las-vlr' })!;
    const v = classifyLayerCompatibility([
      { id: 'l1', ...compatibilityFrameOf(local) },
      { id: 'l2', ...compatibilityFrameOf(local) },
      input('geo', compd()),
    ]);
    expect(v.get('l1')).toBe('unknown');
    expect(v.get('l2')).toBe('unknown');
    expect(v.get('geo')).toBe('verified');
  });

  it('two declared local frames with the same name stay unknown', () => {
    const lc = 'LOCAL_CS["Plant grid",LOCAL_DATUM["x",0],UNIT["metre",1],AXIS["X",EAST],AXIS["Y",NORTH]]';
    expect([...pair(lc, lc).values()]).toEqual(['unknown', 'unknown']);
  });
});

describe('the layer panel summary follows the same rule', () => {
  const info = (id: string, wkt: string): LayerInfo => ({
    id, name: id, pointCount: 1, visible: true, locked: false, ...compatibilityFrameOf(resolved(wkt)),
  });

  it('keys a CRS with no EPSG code on its name and definition', () => {
    expect(panelKey(info('a', projcs({ fe: 500000 })))).not.toBe(panelKey(info('b', projcs({ fe: 596000 }))));
    expect(panelKey(info('a', projcs()))).toBe(panelKey(info('b', projcs())));
  });

  it('reports comparable definitions that differ as a mismatch', () => {
    const m = detectCrsMismatch([info('a', compd({ fe: 500000 })), info('b', compd({ fe: 596000 }))]);
    expect(m.hasMismatch).toBe(true);
    expect(m.mismatched).toHaveLength(1);
  });

  it('reports the same definition as no mismatch', () => {
    const m = detectCrsMismatch([info('a', compd()), info('b', compd())]);
    expect(m.hasMismatch).toBe(false);
    expect(m.summary).toBe('');
  });

  it('reports definitions that cannot be compared as unverified, not as a mismatch', () => {
    const missing = compd().replace(',PARAMETER["false_northing",0]', '');
    const m = detectCrsMismatch([info('a', compd()), info('b', missing)]);
    expect(m.hasMismatch).toBe(false);
    expect(m.summary).toMatch(/alignment is unverified/);
  });
});
