/**
 * sessionUnitFactorConflict.test.ts — a session's unit claim is compared by
 * metres per unit, not by token.
 *
 * A unit known only by its factor (a centimetre grid) carries the token
 * 'unknown', which the session check used to read as "no claim": a session
 * saved on a centimetre grid reopened against a metre scan was not flagged, and
 * its 100-unit distances would have read 100 m. Claims are now compared as
 * factors (horizontal, and vertical where both sides recorded one), a mismatch
 * beyond 1e-9 relative raises the same 'unit' conflict a metre/foot mismatch
 * does, and a genuinely absent unit on either side is still no claim.
 */

import { describe, it, expect } from 'vitest';
import { detectSessionSpatialConflict, type DeclaredSpatialFacts } from '../src/io/session';
import { declaredSpatialFromStatic, sessionSpatialClaimsOf, type StaticScanCloud } from '../src/app/sessionScanFacts';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import { wktForEpsg } from '../src/io/epsgWkt';

const GEOGCS = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const grid = (unit: string): CrsInfo => crsFromWkt(`PROJCS["Local grid",${GEOGCS},PROJECTION["Transverse_Mercator"],${unit}]`);
const CM = grid('UNIT["centimetre",0.01]');
const METRE = grid('UNIT["metre",1]');
const FOOT_NAMED = grid('UNIT["foot",0.3048]');
const UNKNOWN: CrsInfo = { source: 'wkt', name: 'Local grid', linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: false };
const withVertical = (unit: string): CrsInfo =>
  crsFromWkt(`COMPD_CS["x",${wktForEpsg(32613)},VERT_CS["h",VERT_DATUM["d",2005],${unit},AXIS["Up",UP]]]`);

/** The session's claims as a saved and reopened session carries them. */
function savedClaims(crs: CrsInfo) {
  const resolved = parseResolvedCrs(JSON.parse(JSON.stringify(resolvedFromCrsInfo(crs, 'las-vlr'))))! as ResolvedCrs;
  return sessionSpatialClaimsOf({ upAxis: 'z', crs: resolved });
}
/** What the opened scan declares. */
function declared(crs: CrsInfo | null): DeclaredSpatialFacts {
  return declaredSpatialFromStatic({ name: 's.las', pointCount: 1, sourceFormat: 'las', metadata: { crs }, bounds: () => [0, 0, 0, 1, 1, 1] } as unknown as StaticScanCloud);
}
const unitConflicts = (a: CrsInfo, b: CrsInfo | null) => detectSessionSpatialConflict(savedClaims(a), declared(b)).conflicts.filter((c) => c.field === 'unit');

describe('horizontal unit claims compared by factor', () => {
  it('a centimetre session against a metre scan is flagged, both ways round', () => {
    const c = unitConflicts(CM, METRE);
    expect(c).toHaveLength(1);
    expect(c[0]!.reason).toBe("the session's linear unit (unit of 0.01 m) disagrees with the scan's metre");
    expect(unitConflicts(METRE, CM)).toHaveLength(1);
  });

  it('a centimetre session against a centimetre scan is accepted', () => {
    expect(unitConflicts(CM, CM)).toEqual([]);
  });

  it('a named foot and a by-factor 0.3048 agree', () => {
    const byFactor: CrsInfo = { ...UNKNOWN, linearUnitToMetres: 0.3048, linearUnitByFactor: true };
    expect(FOOT_NAMED.linearUnit).toBe('foot');
    expect(unitConflicts(FOOT_NAMED, byFactor)).toEqual([]);
    expect(unitConflicts(byFactor, FOOT_NAMED)).toEqual([]);
  });

  it('a named mismatch still reads as before', () => {
    expect(unitConflicts(METRE, FOOT_NAMED).map((c) => c.reason)).toEqual(["the session's linear unit (metre) disagrees with the scan's foot"]);
  });

  it('an absent unit on either side is no claim', () => {
    expect(unitConflicts(UNKNOWN, CM)).toEqual([]);
    expect(unitConflicts(CM, UNKNOWN)).toEqual([]);
    expect(unitConflicts(UNKNOWN, METRE)).toEqual([]);
    expect(detectSessionSpatialConflict(savedClaims(CM), declared(null)).hasConflict).toBe(false);
    expect(detectSessionSpatialConflict({ upAxis: 'z' }, declared(CM)).hasConflict).toBe(false);
  });
});

describe('vertical unit claims compared where both sides recorded one', () => {
  it('a vertical factor mismatch is flagged', () => {
    const c = unitConflicts(withVertical('UNIT["centimetre",0.01]'), withVertical('UNIT["metre",1]'));
    expect(c).toHaveLength(1);
    expect(c[0]!.reason).toBe("the session's vertical unit (0.01 m per unit) disagrees with the scan's (1 m per unit)");
  });

  it('an unreadable vertical unit against a readable one is flagged; two unreadable ones agree', () => {
    const invalid = withVertical('UNIT["degree",0.0174532925199433]');
    expect(unitConflicts(invalid, withVertical('UNIT["metre",1]'))[0]!.reason).toMatch(/vertical unit \(unreadable\)/);
    expect(unitConflicts(invalid, invalid)).toEqual([]);
  });

  it('matching vertical factors agree, and a vertical unit absent on either side is no claim', () => {
    expect(unitConflicts(withVertical('UNIT["yard",0.9144]'), withVertical('UNIT["yard",0.9144]'))).toEqual([]);
    const noVertical = crsFromWkt(wktForEpsg(32613)!);
    expect(unitConflicts(withVertical('UNIT["yard",0.9144]'), noVertical)).toEqual([]);
    expect(unitConflicts(noVertical, withVertical('UNIT["yard",0.9144]'))).toEqual([]);
  });
});
