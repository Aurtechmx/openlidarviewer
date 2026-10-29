/**
 * Engineering (local) horizontal CRSs nested inside a compound CRS, and the
 * one descriptor adapter shared by the static layer list and the streaming
 * cloud. A compound's outer display name says nothing about which horizontal
 * frame it carries, a frame name is not proof of a shared origin, and
 * metadata that cannot be read must stay unresolved rather than become a
 * projected frame.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { classifyLayerCompatibility, compatibilityNote } from '../src/model/layerCompatibility';
import { compatibilityFrameOf } from '../src/model/compatibilityFrame';
import { resolveStreamingCompatibility, resolveStreamingCompatibilityFromCrs, resolvedOrDeclared } from '../src/render/streamingCompatibility';
import { CrsService } from '../src/geo/CrsService';
import type { CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

const VERT = 'VERTCRS["Local height",VDATUM["Local height"],CS[vertical,1],AXIS["up",up],LENGTHUNIT["metre",1]]';
const engCompound = (eng: string, datum: string): string =>
  `COMPOUNDCRS["Site compound",ENGCRS["${eng}",EDATUM["${datum}"],CS[Cartesian,2],AXIS["x",east],AXIS["y",north],LENGTHUNIT["foot",0.3048]],${VERT}]`;
const LOCAL_COMPD = (name: string) =>
  `COMPD_CS["Site compound",LOCAL_CS["${name}",LOCAL_DATUM["${name} datum",0],UNIT["metre",1]],VERT_CS["Local height",VERT_DATUM["Local height",2005],UNIT["metre",1]]]`;
const UTM_NAVD = 'COMPD_CS["UTM 12N + NAVD88",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["metre",1],AUTHORITY["EPSG","5703"]]]';
const UTM_EGM = 'COMPD_CS["UTM 12N + EGM2008",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["EGM2008 height",VERT_DATUM["EGM2008 geoid",2005],UNIT["metre",1],AUTHORITY["EPSG","3855"]]]';
const UTM_ONLY = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';
const ROOT_LOCAL = 'LOCAL_CS["Site A grid",LOCAL_DATUM["A",0],UNIT["metre",1]]';
const ROOT_ENG = 'ENGCRS["Plant A",EDATUM["A"],CS[Cartesian,2],AXIS["x",east],AXIS["y",north],LENGTHUNIT["metre",1]]';

const resolved = (wkt: string): ResolvedCrs => resolvedFromCrsInfo(crsFromWkt(wkt), 'las-vlr')!;
const frame = (wkt: string) => compatibilityFrameOf(resolved(wkt));
const classify = (...wkts: string[]) =>
  classifyLayerCompatibility(wkts.map((w, i) => ({ id: String(i), ...frame(w) })));

function makePort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return {
    get: (k) => store.get(k),
    set: (k, o) => void store.set(k, { ...o, updatedAt: 1 }),
    clear: (k) => void store.delete(k),
  };
}

describe('engineering CRS inside a compound CRS', () => {
  it('reads the nested engineering component as a named local frame', () => {
    const c = crsFromWkt(engCompound('Job A grid', 'Job A origin'));
    expect(c.localFrame).toBe(true);
    expect(c.name).toBe('Job A grid');
    expect(c.linearUnit).toBe('foot');
    expect(c.verticalDatum).toBe('Local height');
    expect(c.verticalLinearUnit).toBe('metre');
    const r = resolvedFromCrsInfo(c, 'las-vlr')!;
    expect(r.kind).toBe('local');
    expect(r.localFrameName).toBe('Job A grid');
  });

  it('reads a WKT1 LOCAL_CS inside COMPD_CS the same way', () => {
    const c = crsFromWkt(LOCAL_COMPD('Job B grid'));
    expect(c.localFrame).toBe(true);
    expect(c.name).toBe('Job B grid');
  });

  it('never verifies two compounds with the same outer name and different engineering frames', () => {
    const c = classify(engCompound('Job A grid', 'Job A origin'), engCompound('Job B grid', 'Job B origin'));
    expect([...c.values()]).not.toContain('verified');
    expect([...c.values()]).toContain('incompatible');
  });

  it('keeps equal engineering names with different datums unresolved', () => {
    const c = classify(engCompound('Grid', 'Origin 1'), engCompound('Grid', 'Origin 2'));
    expect(c.get('0')).toBe('unknown');
    expect(c.get('1')).toBe('unknown');
  });

  it('keeps generic equal local names from unrelated jobs unresolved', () => {
    const c = classify(LOCAL_COMPD('Local'), LOCAL_COMPD('Local'));
    expect([...c.values()]).toEqual(['unknown', 'unknown']);
  });

  it('keeps root LOCAL_CS and ENGCRS behaviour', () => {
    expect(resolved(ROOT_LOCAL).kind).toBe('local');
    expect(resolved(ROOT_ENG).localFrameName).toBe('Plant A');
    expect([...classify(ROOT_LOCAL, ROOT_LOCAL).values()]).toEqual(['unknown', 'unknown']);
  });

  it('separates a local frame from a projected one', () => {
    const c = classify(UTM_NAVD, engCompound('Job A grid', 'Job A origin'));
    expect(c.get('1')).toBe('incompatible');
  });
});

describe('missing, empty and malformed WKT', () => {
  for (const [label, wkt] of [
    ['empty', ''],
    ['junk', 'not a crs'],
    ['truncated', 'COMPOUNDCRS["Site compound",ENGCRS["Job'],
    ['compound with no horizontal component', `COMPOUNDCRS["Site compound",${VERT}]`],
    ['vertical only', VERT],
  ] as const) {
    it(`leaves ${label} WKT unresolved, never projected`, () => {
      const r = resolved(wkt);
      expect(r.kind).not.toBe('projected');
      expect(r.kind).not.toBe('geographic');
      const f = compatibilityFrameOf(r);
      expect(f.epsg).toBeUndefined();
      // A truncated engineering clause may still be read as a local frame
      // by its partial name; it is never read as a projected one.
      if (label !== 'truncated') {
        expect(f.crsName).toBeUndefined();
        expect(f.localFrameName).toBeUndefined();
      }
    });
  }

  it('does not verify two layers on the same compound label without a horizontal component', () => {
    const w = `COMPOUNDCRS["Site compound",${VERT}]`;
    expect([...classify(w, w).values()]).toEqual(['unknown', 'unknown']);
  });

  it('treats a null CRS as nothing declared', () => {
    expect(compatibilityFrameOf(null)).toEqual({});
  });
});

describe('projected frames and vertical references', () => {
  it('verifies genuinely matching projected compound frames', () => {
    expect([...classify(UTM_NAVD, UTM_NAVD).values()]).toEqual(['verified', 'verified']);
  });

  it('is horizontal-only when the vertical references differ', () => {
    expect([...classify(UTM_NAVD, UTM_EGM).values()]).toEqual(['horizontal-only', 'horizontal-only']);
  });

  it('is horizontal-only when one vertical reference is undeclared', () => {
    expect([...classify(UTM_NAVD, UTM_ONLY).values()]).not.toContain('verified');
  });
});

describe('static and streaming paths share one descriptor', () => {
  it('a streamed engineering compound is not verified beside a static one with the same outer name', () => {
    const s = resolveStreamingCompatibility([frame(engCompound('Job A grid', 'A'))], frame(engCompound('Job B grid', 'B')));
    expect(s).toBe('incompatible');
  });

  it('a streamed local frame with the same name as a static one stays unresolved', () => {
    expect(resolveStreamingCompatibility([frame(ROOT_LOCAL)], frame(ROOT_LOCAL))).toBe('unknown');
  });

  it('a streamed local frame beside a static projected cloud is incompatible', () => {
    expect(resolveStreamingCompatibility([frame(UTM_NAVD)], frame(ROOT_ENG))).toBe('incompatible');
  });

  it('streamed and static matching projected frames verify', () => {
    expect(resolveStreamingCompatibility([frame(UTM_NAVD)], frame(UTM_NAVD))).toBe('verified');
  });
});

describe('explicit user assertions and session reopen', () => {
  it('a user override placing both layers in one projected CRS is honoured by the adapter', () => {
    const svc = new CrsService(makePort());
    const detectedA = crsFromWkt(engCompound('Job A grid', 'A'));
    const detectedB = crsFromWkt(engCompound('Job B grid', 'B'));
    const assert = (name: string, detected: typeof detectedA) => {
      svc.resolveForScan({ name, detected, source: 'las-vlr' });
      return svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected, source: 'las-vlr' })!;
    };
    const a = assert('a.las', detectedA);
    const b = assert('b.las', detectedB);
    expect(a.epsg).toBe(32612);
    const c = classifyLayerCompatibility([{ id: 'a', ...compatibilityFrameOf(a) }, { id: 'b', ...compatibilityFrameOf(b) }]);
    expect(c.get('a')).not.toBe('incompatible');
    expect(c.get('b')).not.toBe('incompatible');
  });

  it('a saved and reopened CRS yields the same classification inputs', () => {
    for (const w of [engCompound('Job A grid', 'A'), ROOT_LOCAL, UTM_NAVD, `COMPOUNDCRS["Site compound",${VERT}]`]) {
      const before = crsFromWkt(w);
      const reopened = JSON.parse(JSON.stringify(before));
      expect(compatibilityFrameOf(resolvedFromCrsInfo(reopened, 'las-vlr'))).toEqual(
        compatibilityFrameOf(resolvedFromCrsInfo(before, 'las-vlr')),
      );
      // Re-reading the stored WKT reaches the same descriptor too.
      expect(compatibilityFrameOf(resolved(before.wkt ?? ''))).toEqual(compatibilityFrameOf(resolvedFromCrsInfo(before, 'las-vlr')));
    }
  });
});

describe('Viewer streaming inputs', () => {
  it('reads declared metadata when no resolver is wired, keeping the local frame', () => {
    const r = resolvedOrDeclared(undefined, crsFromWkt(engCompound('Job A grid', 'A')), 'copc-meta');
    expect(r?.localFrameName).toBe('Job A grid');
    const stat = resolvedOrDeclared(undefined, crsFromWkt(engCompound('Job B grid', 'B')));
    expect(resolveStreamingCompatibilityFromCrs([stat], r)).not.toBe('verified');
  });

  it('uses the resolved CRS, override included, when a resolver is wired', () => {
    const override = { ...resolved(UTM_NAVD), source: 'user-override' as const, userConfirmed: true };
    const stream = resolvedOrDeclared(override, crsFromWkt(ROOT_LOCAL), 'copc-meta');
    expect(stream?.epsg).toBe(32612);
    expect(resolveStreamingCompatibilityFromCrs([resolved(UTM_NAVD)], stream)).toBe('verified');
  });

  it('tells the user what an unresolved layer means and how to fix it', () => {
    expect(compatibilityNote('unknown')).toMatch(/local frame/);
    expect(compatibilityNote('unknown')).toMatch(/set the same CRS/);
  });
});
