/**
 * verifyOracleMatch.test.ts — the oracle name matcher, with the negative control
 * that its own bug taught us to write.
 *
 * `verify-oracle-versions.mjs` maps a study's free-text `reference.tool` field to
 * the oracle tools it names. It once matched by bare substring, so "GeographicLib"
 * — which contains the letters `ogr` — was read as GDAL, and the PROJ version
 * beside it was reported as a phantom GDAL release. These pin the whole-word
 * matcher: real tool tokens match, the letters buried in another word do not.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { oraclesFor } from '../scripts/verify-oracle-versions.mjs';

const ids = (tool: string): string[] => oraclesFor(tool).map((o: { id: string }) => o.id);

describe('oraclesFor — whole-word tool matching', () => {
  it('matches real tool tokens, including inside a slash-joined name', () => {
    expect(ids('GDAL 3.13.1')).toEqual(['GDAL']);
    expect(ids('GDAL/OGR SpatiaLite and R')).toEqual(expect.arrayContaining(['GDAL', 'R']));
    expect(ids('PDAL 2.10.2')).toEqual(['PDAL']);
  });

  it('does NOT mistake GeographicLib for GDAL via the "ogr" buried in it', () => {
    // The exact false positive: a PROJ/GeographicLib study must not resolve to GDAL.
    expect(ids('PROJ and GeographicLib')).not.toContain('GDAL');
    expect(ids('PROJ and GeographicLib')).toEqual([]);
  });

  it('does not match a tool named nowhere in the field', () => {
    expect(ids('CloudCompare 2.13.2')).toEqual([]);
  });
});
