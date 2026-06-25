/**
 * horizontalDatum.test.ts
 *
 * Pins the single-source-of-truth horizontal-datum resolution (Upgrade #3):
 *   • crsFromWkt extracts the datum from the GEOGCS/GEOGCRS base name, preserving
 *     the realization (NAD83(2011) stays distinct from NAD83);
 *   • resolveHorizontalDatum NEVER downgrades — a WKT datum beats the registry's
 *     generic name, and the registry only fills a true gap;
 *   • registryDatumFor returns the curated generic for known EPSGs.
 */

import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import { resolveHorizontalDatum, registryDatumFor } from '../src/geo/CrsRegistry';

describe('crsFromWkt — horizontalDatum extraction', () => {
  it('reads the nested GEOGCS name as the datum of a projected CRS', () => {
    const wkt = 'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983"]],UNIT["metre",1]]';
    expect(crsFromWkt(wkt).horizontalDatum).toBe('NAD83');
  });

  it('preserves the datum realization (NAD83(2011) is not collapsed to NAD83)', () => {
    const wkt = 'PROJCS["NAD83(2011) / UTM zone 12N",GEOGCS["NAD83(2011)",DATUM["NAD83_2011"]],UNIT["metre",1]]';
    expect(crsFromWkt(wkt).horizontalDatum).toBe('NAD83(2011)');
  });

  it('uses the CRS own name for a geographic CRS', () => {
    expect(crsFromWkt('GEOGCS["WGS 84",DATUM["WGS_1984"]]').horizontalDatum).toBe('WGS 84');
  });

  it('reads a WKT2 BASEGEOGCRS base', () => {
    const wkt = 'PROJCRS["ETRS89 / UTM zone 32N",BASEGEOGCRS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989"]]]';
    expect(crsFromWkt(wkt).horizontalDatum).toBe('ETRS89');
  });

  it('is undefined when the WKT carries no geographic base', () => {
    // A degenerate WKT with no GEOGCS — datum simply unknown, never guessed.
    expect(crsFromWkt('LOCAL_CS["assumed"]').horizontalDatum).toBeUndefined();
  });
});

describe('resolveHorizontalDatum — never downgrade', () => {
  it('a WKT datum always wins over the registry generic', () => {
    // EPSG 26912 is NAD83 in the registry, but the file declared NAD83(2011).
    expect(resolveHorizontalDatum('NAD83(2011)', 26912)).toBe('NAD83(2011)');
  });

  it('the registry fills the gap when the file declared no WKT datum', () => {
    expect(resolveHorizontalDatum(undefined, 26910)).toBe('NAD83');
    expect(resolveHorizontalDatum('   ', 32612)).toBe('WGS 84'); // blank WKT ⇒ treated as absent
  });

  it('is undefined when neither source knows — honest, not guessed', () => {
    expect(resolveHorizontalDatum(undefined, 99999)).toBeUndefined();
    expect(resolveHorizontalDatum(undefined, undefined)).toBeUndefined();
  });
});

describe('registryDatumFor', () => {
  it('returns the curated datum for known clusters', () => {
    expect(registryDatumFor(26915)).toBe('NAD83');
    expect(registryDatumFor(32615)).toBe('WGS 84');
    expect(registryDatumFor(4326)).toBe('WGS 84');
    expect(registryDatumFor(25832)).toBe('ETRS89');
  });

  it('returns undefined for an unregistered or undefined EPSG', () => {
    expect(registryDatumFor(99999)).toBeUndefined();
    expect(registryDatumFor(undefined)).toBeUndefined();
  });
});
