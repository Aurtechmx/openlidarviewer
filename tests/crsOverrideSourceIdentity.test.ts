/**
 * A remembered CRS override is applied silently only to the source it was made
 * for.
 *
 * The stored identity used to be the point count and the bounds SPANS, keyed by
 * file name. Two different `points.las` files of the same size and shape, one
 * translated 100 km east of the other, matched on every recorded fact, so the
 * override made for the first was applied to the second as user-confirmed —
 * even over the second file's own declared CRS.
 *
 * The record now carries the absolute bounds minimum (the source position). A
 * match on every strong fact applies the override. A match on name, count and
 * spans with the position unknown or different — and any legacy record, which
 * holds no position — is offered as a suggestion and is not applied.
 */
import { describe, expect, it, vi } from 'vitest';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { CrsInfo } from '../src/io/crs';
import { createCrsCoordinator } from '../src/app/crsCoordinator';
import type { Viewer } from '../src/render/Viewer';

function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: Date.now() }); },
    clear: (key) => { entries.delete(key); },
  };
}

const UTM13N: CrsInfo = {
  source: 'epsg', name: 'WGS 84 / UTM zone 13N', epsg: 32613,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
};

/** A static cloud: positions held relative to `sourceOrigin`, as PointCloud does. */
function staticCloud(easting: number, pointCount = 1_000_000) {
  const origin: [number, number, number] = [easting, 4_000_000, 50];
  return {
    pointCount,
    sourceOrigin: origin,
    origin,
    bounds: () => ({ min: [0, 0, 0], max: [500, 500, 50] }),
  };
}

/** A streaming cloud: local data bounds against a render origin. */
function streamCloud(easting: number, pointCount = 1_000_000) {
  return {
    sourcePointCount: pointCount,
    renderOrigin: [easting, 4_000_000, 0] as [number, number, number],
    dataBounds: () => [-250, -250, 50, 250, 250, 100] as readonly number[],
    localBounds: () => [-250, -250, -200, 250, 250, 300] as readonly number[],
  };
}

describe('ported audit repro: translated same-shaped source does not inherit the override', () => {
  for (const declaresCrs of [false, true]) {
    it(`declared CRS: ${declaresCrs}`, () => {
      // The audit's own shapes: absolute bounds, origin at the minimum corner.
      const cloud = (easting: number) => ({
        pointCount: 1_000_000,
        origin: [easting, 4_000_000, 50],
        bounds: () => ({ min: [easting, 4_000_000, 50], max: [easting + 500, 4_000_500, 100] }),
      });
      const a = cloud(500_000);
      const b = cloud(600_000);
      expect(datasetIdentity(a)).not.toEqual(datasetIdentity(b));
      const detected = declaresCrs ? UTM13N : undefined;
      const port = memoryPort();
      const firstPage = new CrsService(port);
      firstPage.resolveForScan({ name: 'points.las', detected, source: 'las-vlr', identity: datasetIdentity(a) });
      firstPage.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected, source: 'las-vlr' });

      const secondPage = new CrsService(port);
      const result = secondPage.resolveForScan({ name: 'points.las', detected, source: 'las-vlr', identity: datasetIdentity(b) });
      expect(result.epsg).not.toBe(32612);
      expect(result.userConfirmed).not.toBe(true);
      if (declaresCrs) {
        // B's own declaration stands.
        expect(result.epsg).toBe(32613);
        expect(result.source).not.toBe('user-override');
      }
      // The remembered choice is offered, not applied.
      expect(secondPage.overrideSuggestion()).toMatchObject({ epsg: 32612, kind: 'projected', datasetKey: 'points.las' });
    });
  }
});

describe('source position is part of the stored identity', () => {
  it('records the absolute bounds minimum and a record version', () => {
    const port = memoryPort();
    const svc = new CrsService(port);
    svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const rec = port.entries.get('points.las');
    expect(rec?.identityVersion).toBe(2);
    expect(rec?.identity?.min).toEqual([500_000, 4_000_000, 50]);
  });

  it('translated coordinates, same name/count/spans, no CRS: not applied, suggested', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const b = new CrsService(port);
    const r = b.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(600_000)) });
    expect(r.kind).toBe('unknown');
    expect(b.overrideSuggestion()?.reason).toBe('position-differs');
  });

  it('translated coordinates, same declared EPSG: the file keeps its own declaration', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: UTM13N, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: UTM13N, source: 'las-vlr' });
    const b = new CrsService(port);
    const r = b.resolveForScan({ name: 'points.las', detected: UTM13N, source: 'las-vlr', identity: datasetIdentity(staticCloud(600_000)) });
    expect(r.epsg).toBe(32613);
    expect(r.source).toBe('las-vlr');
    expect(b.overrideSuggestion()?.epsg).toBe(32612);
  });

  it('reopened identical source (fresh service on the same store): applied as confirmed', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const again = new CrsService(port);
    const r = again.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBe(32612);
    expect(r.userConfirmed).toBe(true);
    expect(again.overrideSuggestion()).toBeNull();
  });

  it('reopened identical source that declares a CRS: the correction still applies', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: UTM13N, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: UTM13N, source: 'las-vlr' });
    const r = new CrsService(port).resolveForScan({ name: 'points.las', detected: UTM13N, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBe(32612);
    expect(r.userConfirmed).toBe(true);
  });

  it('different content with identical metadata is told apart by a source digest when one is supplied', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    const id = datasetIdentity(staticCloud(500_000));
    a.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: { ...id, digest: 'aaaa' } });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const b = new CrsService(port);
    const other = b.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: { ...id, digest: 'bbbb' } });
    expect(other.epsg).not.toBe(32612);
    const same = new CrsService(port).resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: { ...id, digest: 'aaaa' } });
    expect(same.epsg).toBe(32612);
  });

  it('duplicate local names open together: only the matching layer resolves to the override', () => {
    const port = memoryPort();
    const svc = new CrsService(port);
    const here = datasetIdentity(staticCloud(500_000));
    const there = datasetIdentity(staticCloud(700_000));
    svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: here });
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    expect(svc.resolveFor({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: here }).epsg).toBe(32612);
    expect(svc.resolveFor({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: there }).epsg).toBeUndefined();
    // A caller with no identity in hand cannot be told apart, so it is not given the override.
    expect(svc.resolveFor({ name: 'points.las', detected: undefined, source: 'las-vlr' }).epsg).toBeUndefined();
  });

  it('remote basenames: two streams named points.copc.laz from different hosts', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.copc.laz', detected: undefined, source: 'copc-meta', identity: datasetIdentity(streamCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta' });
    const b = new CrsService(port);
    const r = b.resolveForScan({ name: 'points.copc.laz', detected: undefined, source: 'copc-meta', identity: datasetIdentity(streamCloud(600_000)) });
    expect(r.epsg).toBeUndefined();
    expect(b.overrideSuggestion()?.reason).toBe('position-differs');
    const same = new CrsService(port).resolveForScan({ name: 'points.copc.laz', detected: undefined, source: 'copc-meta', identity: datasetIdentity(streamCloud(500_000)) });
    expect(same.epsg).toBe(32612);
  });
});

describe('legacy and partial records are suggestions, never silent', () => {
  const legacy = (extra: Partial<CrsOverride> = {}): CrsOverride => ({
    epsg: 32612, kind: 'projected', updatedAt: 1, ...extra,
  });

  it('a legacy record with no identity at all', () => {
    const port = memoryPort();
    port.entries.set('points.las', legacy());
    const svc = new CrsService(port);
    const r = svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBeUndefined();
    expect(svc.overrideSuggestion()).toMatchObject({ epsg: 32612, reason: 'legacy' });
  });

  it('a record holding count and spans but no position', () => {
    const port = memoryPort();
    port.entries.set('points.las', legacy({
      detectedEpsgObserved: true,
      identity: { pointCount: 1_000_000, extent: [500, 500, 50] },
    }));
    const svc = new CrsService(port);
    const r = svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBeUndefined();
    expect(svc.overrideSuggestion()?.reason).toBe('legacy');
  });

  it('a legacy record never replaces the file\'s own declaration', () => {
    const port = memoryPort();
    port.entries.set('points.las', legacy());
    const svc = new CrsService(port);
    const r = svc.resolveForScan({ name: 'points.las', detected: UTM13N, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBe(32613);
    expect(r.userConfirmed).not.toBe(true);
  });

  it('a loaded scan with no identity gets a suggestion, not the override', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const b = new CrsService(port);
    expect(b.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr' }).epsg).toBeUndefined();
    expect(b.overrideSuggestion()?.reason).toBe('identity-missing');
  });

  it('accepting a suggestion applies it and records this source, so the next reopen applies silently', () => {
    const port = memoryPort();
    port.entries.set('points.las', legacy());
    const svc = new CrsService(port);
    svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    const accepted = svc.acceptOverrideSuggestion();
    expect(accepted?.epsg).toBe(32612);
    expect(accepted?.userConfirmed).toBe(true);
    expect(svc.overrideSuggestion()).toBeNull();
    expect(port.entries.get('points.las')?.identityVersion).toBe(2);
    const r = new CrsService(port).resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    expect(r.epsg).toBe(32612);
  });

  it('a clearly different dataset (count and spans differ) is neither applied nor suggested', () => {
    const port = memoryPort();
    const a = new CrsService(port);
    a.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(500_000)) });
    a.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const b = new CrsService(port);
    b.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: { pointCount: 42_000_000, extent: [12_000, 12_000, 1_200], min: [0, 0, 0] } });
    expect(b.overrideSuggestion()).toBeNull();
  });
});

describe('streaming source identity', () => {
  it('datasetIdentity places a stream by render origin plus data-bounds minimum', () => {
    const id = datasetIdentity(streamCloud(500_000));
    expect(id).toEqual({ pointCount: 1_000_000, extent: [500, 500, 50], min: [499_750, 3_999_750, 50] });
  });

  it('datasetIdentity places a static cloud by source origin plus bounds minimum', () => {
    expect(datasetIdentity(staticCloud(500_000))?.min).toEqual([500_000, 4_000_000, 50]);
  });
});

describe('crsCoordinator offers the suggestion through notify', () => {
  it('notifies once with an Apply action that applies the remembered CRS', () => {
    const port = memoryPort();
    port.entries.set('points.las', { epsg: 32612, kind: 'projected', updatedAt: 1 });
    const service = new CrsService(port);
    const notify = vi.fn();
    const onOverrideApplied = vi.fn();
    const cloud = { name: 'points.las', ...staticCloud(500_000) };
    const viewer = { streamingCloud: undefined, getCloud: vi.fn(() => cloud), setInspectCoordinateContext: vi.fn() };
    const coordinator = createCrsCoordinator({
      crsService: service,
      getViewer: () => viewer as unknown as Viewer,
      isViewerReady: () => true,
      getActiveId: () => 'a',
      debug: false,
      onOverrideApplied,
      notify,
    });
    coordinator.refreshCrsForStaticCloud(cloud);
    expect(service.current()?.epsg).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, action] = notify.mock.calls[0];
    expect(message).toMatch(/remembered for a file with this name/i);
    expect(message).toContain('EPSG:32612');
    coordinator.refreshCrsForStaticCloud(cloud);
    expect(notify).toHaveBeenCalledTimes(1);
    action.onClick();
    expect(service.current()?.epsg).toBe(32612);
    expect(service.current()?.userConfirmed).toBe(true);
    expect(onOverrideApplied).toHaveBeenCalled();
  });
});
