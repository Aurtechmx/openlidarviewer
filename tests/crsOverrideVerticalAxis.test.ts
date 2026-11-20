/**
 * A horizontal CRS override keeps the file's depth axis.
 *
 * A vertical CRS declared with a DOWN axis is a depth reference. When its
 * datum is not one of the known depth codes, the axis flag is the only thing
 * that tells the elevation workflows to refuse it. An override (the Inspector,
 * a session restore, or a remembered override on reopen) rebuilt the CRS
 * without that flag, so depths ran through terrain, contours and DEM export as
 * heights with every rise inverted.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { crsFromWkt } from '../src/io/crs';
import { DEPTH_AXIS_REFUSAL, elevationWorkflowRefusal } from '../src/geo/SpatialContext';

/** UTM 12N over a harbour chart datum whose axis is declared DOWN. */
const HARBOUR_DEPTH_WKT = 'COMPD_CS["x",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["Harbour chart datum",VERT_DATUM["Harbour",2005],UNIT["metre",1],AXIS["Depth",DOWN]]]';

const IDENTITY = { pointCount: 5000, extent: [100, 100, 12] as const, min: [500_000, 4_000_000, -12] as const };

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

describe('an override keeps a depth-down vertical axis', () => {
  const detected = crsFromWkt(HARBOUR_DEPTH_WKT);

  it('the file itself is refused by the elevation gate', () => {
    expect(detected.verticalAxisDown).toBe(true);
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'harbour.laz', detected, source: 'las-vlr' });
    expect(elevationWorkflowRefusal(svc.context())).toBe(DEPTH_AXIS_REFUSAL);
  });

  it('A: a session restore confirming the same EPSG', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'harbour.laz', detected, source: 'las-vlr' });
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected, source: 'user-override', persist: false });
    expect(svc.current()?.verticalAxisDown).toBe(true);
    expect(elevationWorkflowRefusal(svc.context())).toBe(DEPTH_AXIS_REFUSAL);
  });

  it('B: an Inspector override to a different EPSG', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'harbour.laz', detected, source: 'las-vlr' });
    svc.setOverride({ override: { epsg: 32613, kind: 'projected' }, detected, source: 'user-override' });
    expect(svc.current()?.epsg).toBe(32613);
    expect(elevationWorkflowRefusal(svc.context())).toBe(DEPTH_AXIS_REFUSAL);
  });

  it('C: a remembered override applied on reopen of the same scan', () => {
    const port = memoryPort();
    const first = new CrsService(port);
    first.resolveForScan({ name: 'harbour.laz', detected, source: 'las-vlr', identity: IDENTITY });
    first.setOverride({ override: { epsg: 32613, kind: 'projected' }, detected, source: 'user-override' });

    const reopened = new CrsService(port);
    const crs = reopened.resolveForScan({ name: 'harbour.laz', detected, source: 'las-vlr', identity: IDENTITY });
    expect(crs.source).toBe('user-override');
    expect(crs.epsg).toBe(32613);
    expect(elevationWorkflowRefusal(reopened.context())).toBe(DEPTH_AXIS_REFUSAL);
  });
});
