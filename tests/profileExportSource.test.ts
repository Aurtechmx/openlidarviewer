/**
 * profileExportSource.test.ts
 *
 * Two scans open, a profile measured on a UTM LAS, the other scan (a PLY with
 * no CRS) selected: the profile's PDF and CSV were named after the PLY and the
 * sheet printed "Not georeferenced", while its stations were the LAS's.
 * Selecting the LAS again named them correctly. The export now names the scan
 * the profile records it was picked on, in that scan's own CRS, and is
 * withheld when that cannot be settled.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { profileExportContext, profileWorkbenchSource, type ProfileSourceDeps } from '../src/app/profileExportSource';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { PointCloud } from '../src/model/PointCloud';

const utm = { kind: 'projected', epsg: 32613, name: 'WGS 84 / UTM zone 13N', verticalDatum: 'NAVD88' } as unknown as ResolvedCrs;
const local = { kind: 'local', name: 'Local' } as unknown as ResolvedCrs;
const estonia = { kind: 'projected', epsg: 3301, name: 'Estonian Coordinate System of 1997' } as unknown as ResolvedCrs;

/** Two open scans: v1 = the LAS (stable id las), v2 = the PLY (stable id ply). */
function scene(active: 'v1' | 'v2', extra: Partial<ProfileSourceDeps> = {}): ProfileSourceDeps {
  const clouds: Record<string, { name: string; crs: ResolvedCrs }> = {
    v1: { name: 'terrain-access-utm.las', crs: utm },
    v2: { name: 'tiny.ply', crs: local },
  };
  return {
    activeId: () => active,
    clouds: () => ['v1', 'v2'],
    cloud: (id) => (clouds[id] ? ({ name: clouds[id]!.name } as PointCloud) : undefined),
    stableIdFor: (id) => (id === 'v1' ? 'las' : id === 'v2' ? 'ply' : null),
    activeCrs: () => clouds[active]!.crs,
    crsOf: (c) => Object.values(clouds).find((x) => x.name === c.name)!.crs,
    activeName: () => (active === 'v1' ? 'terrain-access-utm' : 'tiny'),
    ...extra,
  };
}

const onLas = { owner: { layerId: 'las' }, pickLayers: ['las'] } as Parameters<typeof profileExportContext>[0];

describe('the source a profile export names', () => {
  it('keeps the scan the profile was measured on, whichever scan is selected', () => {
    for (const active of ['v1', 'v2', 'v1'] as const) {
      expect(profileExportContext(onLas, scene(active))).toEqual({
        crs: 'EPSG:32613 — WGS 84 / UTM zone 13N',
        verticalDatum: 'NAVD88',
        scanName: 'terrain-access-utm',
      });
    }
  });

  it('reads the active scan when it is the only one open', () => {
    const one = scene('v2', { clouds: () => ['v2'] });
    expect(profileExportContext({}, one)).toEqual({ crs: null, verticalDatum: null, scanName: 'tiny' });
  });

  it('withholds a deleted profile even when a single scan is open', () => {
    const out = profileExportContext(undefined, scene('v2', { clouds: () => ['v2'] }));
    expect(out.refused).toMatch(/no longer available/);
    expect(out.scanName).toBeNull();
  });

  it('withholds a profile with no recorded scan while several are open', () => {
    const r = profileExportContext({}, scene('v1'));
    expect(r.refused).toMatch(/no record of the scan it was measured on/);
    expect(r.scanName).toBeNull();
  });

  it('withholds a profile whose scan has been closed', () => {
    const r = profileExportContext({ pickLayers: ['gone'] }, scene('v1'));
    expect(r.refused).toMatch(/is not open/);
  });

  it('withholds a recorded owner even when an unrelated scan is the sole survivor', () => {
    const out = profileExportContext(onLas, scene('v2', { clouds: () => ['v2'] }));
    expect(out.refused).toMatch(/is not open/);
    expect(out.scanName).toBeNull();
  });

  it('requires every recorded contributor to resolve exactly once', () => {
    const missing = profileExportContext({ pickLayers: ['las', 'gone'] }, scene('v1'));
    const duplicate = profileExportContext(onLas, scene('v1', { stableIdFor: () => 'las' }));
    expect(missing.refused).toMatch(/is not open/);
    expect(duplicate.refused).toMatch(/more than one open scan/);
    expect(missing.scanName).toBeNull();
    expect(duplicate.scanName).toBeNull();
  });

  it('withholds profiles across distinct vertical references even when the horizontal CRS agrees', () => {
    const view = scene('v1', { crsOf: () => ({ ...utm, verticalDatum: 'EGM96' }) });
    const out = profileExportContext({ pickLayers: ['las', 'ply'] }, view);
    expect(out.refused).toMatch(/vertical reference/);
    expect(out.verticalDatum).toBeNull();
  });

  it('withholds a profile picked across scans in different coordinate systems', () => {
    const r = profileExportContext({ pickLayers: ['las', 'ply'] }, scene('v1'));
    expect(r.refused).toMatch(/terrain-access-utm \(EPSG:32613 — WGS 84 \/ UTM zone 13N\) and tiny \(no CRS\)/);
  });

  it('names both scans when they share a coordinate system', () => {
    const shared = scene('v1', { crsOf: () => utm });
    expect(profileExportContext({ pickLayers: ['las', 'ply'] }, shared).scanName).toBe('terrain-access-utm-tiny');
  });

  it('requires a positive frame identity for every contributor, including name-only and custom WKT inputs', () => {
    const a = { ...utm, epsg: undefined, name: 'Survey grid', wkt: 'PROJCS["Survey grid",PARAMETER["false_easting",100]]' };
    const b = { ...a, wkt: 'PROJCS["Survey grid",PARAMETER["false_easting",200]]' };
    for (const [left, right] of [[a, b], [{ ...a, wkt: undefined }, { ...a, wkt: undefined }], [local, local]]) {
      const scope = scene('v1', { activeCrs: () => left as ResolvedCrs, crsOf: () => right as ResolvedCrs });
      expect(profileExportContext({ pickLayers: ['las', 'ply'] }, scope).refused).toBeTruthy();
    }
  });

  it('distinguishes an empty viewer, a lone stream and a mixed static/streamed scene for legacy work', () => {
    const none = scene('v1', { clouds: () => [], activeId: () => null });
    expect(profileExportContext({}, none).refused).toMatch(/no source scan is open/);
    expect(profileExportContext({}, { ...none, hasStreamingCloud: () => true }).scanName).toBe('terrain-access-utm');
    expect(profileExportContext(onLas, { ...none, hasStreamingCloud: () => true }).refused).toMatch(/is not open/);
    expect(profileExportContext({}, scene('v1', { clouds: () => ['v1'], hasStreamingCloud: () => true })).refused).toBeTruthy();
  });

  it('opens the raw workbench only in a contributing scan’s frame and preserves the saved profile otherwise', () => {
    expect(profileWorkbenchSource(onLas, scene('v1')).refused).toBeUndefined();
    expect(profileWorkbenchSource(onLas, scene('v2')).refused).toMatch(/Select.*terrain-access-utm.*in Data/);
    expect(profileExportContext(onLas, scene('v2')).refused).toBeUndefined();
  });

  it('resolves a non-active scan in its own CRS, not the active one', () => {
    const r = profileExportContext({ pickLayers: ['las'] }, scene('v2', { crsOf: () => estonia }));
    expect(r.crs).toBe('EPSG:3301 — Estonian Coordinate System of 1997');
  });
});

describe('every profile export path asks for the profile it writes', () => {
  it('passes the profile id to the source for the sheet, the CSV and the workbench image', () => {
    const panel = readFileSync(join(import.meta.dirname, '..', 'src', 'ui', 'MeasurePanel.ts'), 'utf8');
    expect(panel).not.toMatch(/getProfileExportContext\(\)/);
    expect(panel).not.toMatch(/getProfileExportContext\?\.\(\)/);
    const workbench = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'profileWorkbenchRuntime.ts'), 'utf8');
    expect(workbench).toContain('deps.scanBaseName?.(request.id)');
  });
});

describe('the layer name button on a phone', () => {
  it('is a 44px touch target, and the CRS badge gives way before it', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', '65-mobile-touch.css'), 'utf8');
    expect(css).toContain('.olv-layer-name { min-height: 44px; min-width: 3rem; }');
    expect(css).toContain('.olv-layer-crs { max-width: 3.5rem; }');
  });
});
