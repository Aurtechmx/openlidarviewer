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
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no type declarations
import { oraclesFor, undeclaredVersions, pinnedVersionsOf, containerPinningProblems } from '../scripts/verify-oracle-versions.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import { serialOrder } from '../scripts/lib/gates.mjs';

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

describe('undeclaredVersions — a declared set passes, an undeclared version fails', () => {
  const accepted = new Set(['3.13.1', '3.13.3']);

  it('accepts every version in the declared set (the documented GDAL split)', () => {
    expect(undeclaredVersions(['3.13.1', '3.13.3', '3.13.1'], accepted)).toEqual([]);
  });

  it('flags a version the set does not declare, deduplicated', () => {
    expect(undeclaredVersions(['3.13.1', '3.13.5', '3.13.5'], accepted)).toEqual(['3.13.5']);
  });
});

describe('pinnedVersionsOf — image pins and declared host versions are both accepted sets', () => {
  it('reads a single version, a set, and the host table, each with its origin', () => {
    const entries = pinnedVersionsOf({
      oracleVersions: { GDAL: ['3.13.1', '3.13.3'], PDAL: '2.10.2' },
      acceptedHostVersions: { R: ['4.4.1', '4.6.1'] },
    });
    expect(entries).toEqual([
      { oracleId: 'GDAL', version: '3.13.1', origin: 'image' },
      { oracleId: 'GDAL', version: '3.13.3', origin: 'image' },
      { oracleId: 'PDAL', version: '2.10.2', origin: 'image' },
      { oracleId: 'R', version: '4.4.1', origin: 'host' },
      { oracleId: 'R', version: '4.6.1', origin: 'host' },
    ]);
  });

  it('reads nothing from a manifest with neither table', () => {
    expect(pinnedVersionsOf({})).toEqual([]);
  });
});

describe('oraclesFor — the R banner spelling', () => {
  it('extracts the version from "R version 4.6.1" as well as "R 4.4.1"', () => {
    const r = oraclesFor('R').find((o: { id: string }) => o.id === 'R') as { extract: (t: string) => string | null };
    expect(r.extract('R version 4.6.1 (2026-06-24)')).toBe('4.6.1');
    expect(r.extract('GDAL 3.13.1 with SpatiaLite 5.1.0, R 4.4.1')).toBe('4.4.1');
  });
});

describe('wiring', () => {
  it('the release chain runs it', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:oracle-versions']).toBe('node scripts/verify-oracle-versions.mjs');
    expect(serialOrder(), 'a check outside the release chain guards nothing at release time')
      .toContain('verify:oracle-versions');
  });
});

describe('containerPinningProblems — not-executed, or a recorded digest with its run', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const run = (over: Record<string, unknown> = {}) => ({ imageDigest: digest, environment: { containerPinning: 'executed' }, ...over });
  const recorded = (over: Record<string, unknown> = {}) => ({
    containerPinning: { status: 'recorded', imageDigest: digest, recordedOn: '2026-10-25', runReference: 'validation/oracles/runs/x.json', ...over },
  });

  it('accepts a whole not-executed block and makes no claim for a manifest without one', () => {
    expect(containerPinningProblems({ containerPinning: { status: 'not-executed', imageDigest: null, runReference: null, recordedOn: null } })).toEqual([]);
    expect(containerPinningProblems({})).toEqual([]);
  });

  it('refuses a not-executed block that carries a digest', () => {
    const p = containerPinningProblems({ containerPinning: { status: 'not-executed', imageDigest: digest } });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/not-executed but carries imageDigest/);
  });

  it('accepts a recorded digest whose run exists and ran inside the image', () => {
    expect(containerPinningProblems(recorded(), () => run())).toEqual([]);
  });

  it('refuses a recorded digest with no run, a run outside the image, or a different image', () => {
    expect(containerPinningProblems(recorded(), () => null)[0]).toMatch(/does not exist/);
    expect(containerPinningProblems(recorded(), () => run({ environment: { containerPinning: 'not-executed' } }))[0]).toMatch(/was not inside the image/);
    expect(containerPinningProblems(recorded(), () => run({ imageDigest: `sha256:${'b'.repeat(64)}` }))[0]).toMatch(/different images/);
  });

  it('fails when the nested reference-run environment disagrees with the outer one', () => {
    const env = { containerPinning: 'executed', containerPinningReason: 'inside the image' };
    const nested = (over: Record<string, unknown>) => ({ environment: env, referenceRuns: { environment: { ...env, ...over } } });
    expect(containerPinningProblems(recorded(), () => run(nested({})))).toEqual([]);
    expect(containerPinningProblems(recorded(), () => run(nested({ containerPinning: 'not-executed' })))[0]).toMatch(/nested referenceRuns\.environment\.containerPinning/);
    expect(containerPinningProblems(recorded(), () => run(nested({ containerPinningReason: 'host PATH' })))[0]).toMatch(/containerPinningReason/);
  });

  it('refuses a malformed digest, a missing date, and an unknown status', () => {
    expect(containerPinningProblems(recorded({ imageDigest: 'abc' }), () => run())[0]).toMatch(/not a sha256/);
    expect(containerPinningProblems(recorded({ recordedOn: null }), () => run())[0]).toMatch(/not a date/);
    expect(containerPinningProblems({ containerPinning: { status: 'done' } })[0]).toMatch(/status must be/);
  });
});
