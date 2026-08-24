/**
 * geodesyOracleAgreement.test.ts — OLV's UTM projection against two independent
 * geodesy stacks.
 *
 * The candidate is `latLonToUtm`, the production function the point inspector
 * reads. Nothing here reimplements the projection: a harness that recomputed
 * the formula would compare the formula to itself and pass whatever the
 * candidate did.
 *
 * The references are committed, so this runs on a machine with neither PROJ nor
 * GeographicLib installed. Regenerating them is a separate job:
 *
 *   node validation/external-oracles/geodesy/run-oracles.mjs
 *
 * Two oracles rather than one, and from different lineages. PROJ and
 * GeographicLib share no transverse-Mercator code, and the reference record
 * carries how far apart THEY are, so a residual can be attributed. Over this
 * matrix they agree to about 2e-9 m, which is four orders below the gate, so
 * anything the candidate shows above that is the candidate's.
 *
 * The two legs answer different questions. GeoConvert chooses the zone itself,
 * applying the Norway 32V and Svalbard 31X/33X/35X/37X exceptions from the UTM
 * definition, so it checks `utmZoneFor` as well as the arithmetic. cs2cs is
 * told which zone to use, so it checks arithmetic alone. Neither leg alone
 * covers both.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { latLonToUtm } from '../src/geo/UtmConverter';

const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'validation/external-oracles/geodesy');

interface OracleLeg { oracleId: string; role: string; executablePath: string; versionOutput: string; zoneSource: string }
interface Fixture {
  id: string; lat: number; lon: number;
  geographiclib: { zone: number; hemisphere: 'N' | 'S'; easting: number; northing: number };
  proj: { easting: number; northing: number; epsg: number };
  oracleSpread: { eastingM: number; northingM: number };
}
interface Reference {
  protocolId: string; fixturesSha256: string; fixtureCount: number;
  oracles: OracleLeg[];
  oracleAgreement: { maxAbsEastingM: number; maxAbsNorthingM: number };
  results: Fixture[];
}

const protocol = JSON.parse(readFileSync(resolve(DIR, 'protocol.json'), 'utf8'));
const fixturesRaw = readFileSync(resolve(DIR, 'fixtures.json'), 'utf8');
const reference: Reference = JSON.parse(readFileSync(resolve(DIR, 'references/oracle-utm.json'), 'utf8'));

const TOLERANCE_M: number = protocol.metrics.toleranceAbs;

describe('geodesy oracles — the record is bound to what produced it', () => {
  it('the reference was generated from the committed fixture matrix', () => {
    // A reference whose inputs have since been edited is measuring something
    // the repository no longer contains.
    const digest = `sha256:${createHash('sha256').update(fixturesRaw).digest('hex')}`;
    expect(reference.fixturesSha256).toBe(digest);
  });

  it('carries the same protocol the tolerance comes from', () => {
    expect(reference.protocolId).toBe(protocol.protocolId);
  });

  it('names both oracles, with the executable and version each result came from', () => {
    const ids = reference.oracles.map((o) => o.oracleId).sort();
    expect(ids).toEqual(['geographiclib-2.7', 'proj-9.8.1']);
    for (const o of reference.oracles) {
      expect(o.executablePath, `${o.oracleId} executable`).toMatch(/\S/);
      expect(o.versionOutput, `${o.oracleId} version`).toMatch(/\d/);
    }
  });

  it('meets the protocol minimum fixture count', () => {
    expect(reference.results).toHaveLength(reference.fixtureCount);
    expect(reference.fixtureCount).toBeGreaterThanOrEqual(protocol.metrics.minimumFixtures);
  });

  it('the two oracles agree far inside the gate, so a residual is attributable', () => {
    // If the oracles disagreed near the tolerance, a candidate result inside it
    // would prove nothing about the candidate.
    expect(reference.oracleAgreement.maxAbsEastingM).toBeLessThan(TOLERANCE_M / 1000);
    expect(reference.oracleAgreement.maxAbsNorthingM).toBeLessThan(TOLERANCE_M / 1000);
  });
});

describe('UTM zone selection against GeographicLib', () => {
  // The exceptions are in the UTM definition, not local convention. Getting one
  // wrong puts a survey in a zone every other tool disagrees with, by a whole
  // six degrees of grid.
  it.each(reference.results.map((f) => [f.id, f] as const))(
    'picks the same zone and hemisphere as GeographicLib for %s',
    (_id, f) => {
      const olv = latLonToUtm(f.lat, f.lon);
      expect(olv.zone).toBe(f.geographiclib.zone);
      expect(olv.hemisphere).toBe(f.geographiclib.hemisphere);
    },
  );
});

describe('UTM easting and northing against both stacks', () => {
  it.each(reference.results.map((f) => [f.id, f] as const))(
    'agrees with PROJ and GeographicLib within tolerance for %s',
    (_id, f) => {
      const olv = latLonToUtm(f.lat, f.lon);
      expect(Math.abs(olv.easting - f.geographiclib.easting)).toBeLessThanOrEqual(TOLERANCE_M);
      expect(Math.abs(olv.northing - f.geographiclib.northing)).toBeLessThanOrEqual(TOLERANCE_M);
      expect(Math.abs(olv.easting - f.proj.easting)).toBeLessThanOrEqual(TOLERANCE_M);
      expect(Math.abs(olv.northing - f.proj.northing)).toBeLessThanOrEqual(TOLERANCE_M);
    },
  );

  it('every fixture passes, which is what the decision rule requires', () => {
    const failures = reference.results.filter((f) => {
      const olv = latLonToUtm(f.lat, f.lon);
      return (
        olv.zone !== f.geographiclib.zone ||
        olv.hemisphere !== f.geographiclib.hemisphere ||
        Math.abs(olv.easting - f.geographiclib.easting) > TOLERANCE_M ||
        Math.abs(olv.northing - f.geographiclib.northing) > TOLERANCE_M ||
        Math.abs(olv.easting - f.proj.easting) > TOLERANCE_M ||
        Math.abs(olv.northing - f.proj.northing) > TOLERANCE_M
      );
    });
    expect(failures.map((f) => f.id)).toEqual([]);
    expect(protocol.metrics.requiredWithinToleranceFraction).toBe(1);
  });
});

describe('the measured residual, pinned to what it actually is', () => {
  // The gate above is the scientific statement and is set from survey practice.
  // These numbers are the measurement, pinned so that a change of series, a
  // units slip, or a different ellipsoid moves this test while every fixture
  // still sits inside the gate. They are not a second, tighter gate: they are
  // what the current implementation does, recorded.
  const MEASURED_MAX_EASTING_M = 4.531e-4;
  const MEASURED_MAX_NORTHING_M = 9.521e-4;

  const residuals = () => {
    let maxE = 0;
    let maxN = 0;
    let minSignedN = Infinity;
    let maxSignedN = -Infinity;
    for (const f of reference.results) {
      const olv = latLonToUtm(f.lat, f.lon);
      maxE = Math.max(maxE, Math.abs(olv.easting - f.geographiclib.easting));
      const dN = olv.northing - f.geographiclib.northing;
      maxN = Math.max(maxN, Math.abs(dN));
      minSignedN = Math.min(minSignedN, dN);
      maxSignedN = Math.max(maxSignedN, dN);
    }
    return { maxE, maxN, minSignedN, maxSignedN };
  };

  it('is sub-millimetre on both axes across the whole matrix', () => {
    const { maxE, maxN } = residuals();
    expect(maxE).toBeLessThanOrEqual(MEASURED_MAX_EASTING_M);
    expect(maxN).toBeLessThanOrEqual(MEASURED_MAX_NORTHING_M);
    // Worth stating: both maxima land on Svalbard fixtures, at the far edge of
    // the projection's useful latitude, which is where a truncated series is
    // expected to be worst.
  });

  it('has not silently improved either, which would mean the harness stopped measuring', () => {
    // A residual that collapses to zero is far more likely to be a comparison
    // that no longer compares than a projection that became exact.
    const { maxE, maxN } = residuals();
    expect(maxE).toBeGreaterThan(MEASURED_MAX_EASTING_M / 10);
    expect(maxN).toBeGreaterThan(MEASURED_MAX_NORTHING_M / 10);
  });

  it('takes both signs, so there is no systematic bias to report', () => {
    // Measured before it was described. An earlier reading of this as a
    // one-signed Krüger offset was wrong: the northing residual runs from
    // about -8.4e-4 m to +9.5e-4 m, which is truncation, not bias.
    const { minSignedN, maxSignedN } = residuals();
    expect(minSignedN).toBeLessThan(0);
    expect(maxSignedN).toBeGreaterThan(0);
  });
});
