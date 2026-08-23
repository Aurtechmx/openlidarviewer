/**
 * profileEndcapMembership.test.ts: the corridor's SHAPE at the ends, one probe
 * per decisive case, against an independent implementation.
 *
 * WHAT THIS ADDS OVER profileCapsCrossCheck. That file compares reduced series:
 * a p25 per station, which reports a membership rule only through a value that
 * moves when a point leaks in. It cannot say anything about a point sitting
 * exactly ON the threshold, because every one of its probes is held 0.125 m
 * clear of the cap boundary, and MEAS-PROFILE-OGR-R-CORRIDOR lists that
 * tie-break in its own scope.unsupported. This file asks membership directly and
 * puts two probes exactly on the threshold.
 *
 * THREE VERDICTS PER PROBE, AND THEY MUST ALL AGREE.
 *   hand-derived  ENDCAP_PROBES.admitted, checked against `endcapDistance`,
 *                 an expression written from the definition of distance to a
 *                 finite segment and not from the sampler.
 *   candidate     whether sampleProfile's corridor counts the probe.
 *   reference     SpatiaLite's ST_Distance <= band, from
 *                 profile-endcap__membership.csv.
 *
 * WHY CASE 3 IS THE DISCRIMINATING ONE. Every probe here lies inside a corridor
 * with square ends, so the rectangle rule admits all eight and cannot be the
 * source of any agreement. The square corner is the probe the two shapes
 * disagree about while sitting nowhere near either threshold: 3.5355 m from the
 * segment against a 2.5 m band, and exactly on the rectangle's corner. A
 * verdict on it reports which shape the implementation has, not how it rounds.
 *
 * Skips the reference legs rather than failing when the OGR output is absent;
 * GDAL is not a project dependency.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sampleProfile } from '../src/render/measure/profileSampler';
import type { Vec3 } from '../src/render/navMath';
import {
  ENDCAP_A, ENDCAP_B, ENDCAP_BAND, ENDCAP_SAMPLES, ENDCAP_Z,
  ENDCAP_PROBES, endcapDistance, endcapRectangle, UP,
} from '../scripts/profile-fixture-params.mjs';

const DIR = resolve(__dirname, '../validation/cross-implementation/profile');
const CLOUD = resolve(DIR, 'profile-endcap.csv');
const REF = resolve(DIR, 'profile-endcap__membership.csv');
const RUNS = resolve(DIR, 'reference-runs-profile-endcap.json');

const PROBES = ENDCAP_PROBES;

const vec3 = (v: number[]): Vec3 => [v[0], v[1], v[2]];

/**
 * The candidate's verdict, read behaviourally: a cloud holding this one point,
 * sampled with the fixture's parameters. The corridor counts it or it does not,
 * and nothing here reimplements the test that decides which.
 */
function sampled(x: number, y: number): boolean {
  const out = sampleProfile({
    a: vec3(ENDCAP_A),
    b: vec3(ENDCAP_B),
    up: vec3(UP),
    positions: new Float32Array([x, y, ENDCAP_Z]),
    samples: ENDCAP_SAMPLES,
    bandWidth: ENDCAP_BAND,
  });
  const total = out.reduce((n, s) => n + (s.count ?? 0), 0);
  expect(total, `a single probe cannot be counted ${total} times`).toBeLessThanOrEqual(1);
  return total === 1;
}

/** The neighbouring Float32, outward or inward. One ulp, in the type the sampler reads. */
function nextFloat32(v: number, dir: 1 | -1): number {
  const buf = new ArrayBuffer(4);
  const f = new Float32Array(buf);
  const i = new Int32Array(buf);
  f[0] = Math.fround(v);
  i[0] += v >= 0 ? dir : -dir;
  return f[0];
}

interface ReferenceRow {
  dist: number;
  capsule: boolean;
  rect: boolean;
  onBoundary: boolean;
}

function readReference(path: string): Map<string, ReferenceRow> {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  expect(lines[0], `${path}: unexpected header`).toBe('id,dist,capsule,rect,onBoundary');
  const rows = new Map<string, ReferenceRow>();
  for (const raw of lines.slice(1)) {
    const [id, dist, capsule, rect, onBoundary] = raw.split(',');
    rows.set(id, {
      dist: Number(dist),
      capsule: capsule === '1',
      rect: rect === '1',
      onBoundary: onBoundary === '1',
    });
  }
  return rows;
}

const withReference = existsSync(REF) ? it : it.skip;
/** The two probes placed exactly on a threshold, by construction. */
const BOUNDARY_IDS = ['c2-start-cap-boundary', 'c7-body-boundary'];

describe('section profile corridor: end-cap membership', () => {
  it('covers all seven cases with probes whose fixture rows are exact', () => {
    expect(new Set(PROBES.map((p) => p.caseNo))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    const rows = readFileSync(CLOUD, 'utf8').trim().split('\n');
    expect(rows[0]).toBe('id,x,y,z');
    expect(rows).toHaveLength(PROBES.length + 1);
    for (const [i, probe] of PROBES.entries()) {
      // The committed bytes are the probe, not a rounded copy of it.
      expect(rows[i + 1]).toBe(`${probe.id},${probe.x},${probe.y},${ENDCAP_Z}`);
      expect(Math.fround(probe.x)).toBe(probe.x);
      expect(Math.fround(probe.y)).toBe(probe.y);
    }
  });

  it('derives each verdict from the definition, not from the sampler', () => {
    for (const probe of PROBES) {
      const d = endcapDistance(probe);
      expect(probe.admitted, `${probe.id} is ${d} m from the segment`).toBe(d <= ENDCAP_BAND);
    }
    // Exactly two probes sit on the threshold; the rest are decided by a margin
    // twelve orders of magnitude above double-precision projection differences.
    const onBoundary = PROBES.filter((p) => endcapDistance(p) === ENDCAP_BAND);
    expect(onBoundary.map((p) => p.id)).toEqual(BOUNDARY_IDS);
    for (const probe of PROBES) {
      if (BOUNDARY_IDS.includes(probe.id)) continue;
      expect(Math.abs(endcapDistance(probe) - ENDCAP_BAND), `${probe.id} margin`).toBeGreaterThan(0.02);
    }
  });

  it('case 3 is the probe that discriminates a capsule from a rectangle', () => {
    // Every probe is inside the square-ended corridor, so agreement anywhere
    // else in this file cannot be coming from the rectangle rule.
    for (const probe of PROBES) expect(endcapRectangle(probe), `${probe.id} rectangle`).toBe(true);
    const corner = PROBES.find((p) => p.caseNo === 3)!;
    expect(corner.admitted).toBe(false);
    // Its offset and its chainage past the end are both exactly the band, so a
    // rectangle admits it on both axes, while the segment distance is band·√2.
    expect(Math.abs(corner.y)).toBe(ENDCAP_BAND);
    expect(Math.abs(corner.x - ENDCAP_A[0])).toBe(ENDCAP_BAND);
    expect(endcapDistance(corner)).toBeCloseTo(ENDCAP_BAND * Math.SQRT2, 12);
    // Cases 4 and 5b say what the rejection is measured from: both sit inside
    // the square-ended rule on both axes and are still rejected, because the
    // radius to the endpoint is what exceeds the band.
    for (const id of ['c4-start-cap-outside', 'c5b-end-cap-outside']) {
      const p = PROBES.find((q) => q.id === id)!;
      expect(Math.abs(p.y), `${id} offset`).toBeLessThan(ENDCAP_BAND);
      expect(endcapRectangle(p), `${id} rectangle`).toBe(true);
      expect(p.admitted, `${id} capsule`).toBe(false);
    }
  });

  it('the sampler agrees with the hand-derived verdict on all seven cases', () => {
    for (const probe of PROBES) {
      expect(sampled(probe.x, probe.y), `${probe.id} (case ${probe.caseNo})`).toBe(probe.admitted);
    }
  });

  it('breaks the exact-boundary tie inclusively, at the cap and at the band', () => {
    for (const id of BOUNDARY_IDS) {
      const probe = PROBES.find((p) => p.id === id)!;
      // Admitted at the threshold, and one Float32 ulp further out is rejected:
      // the probe is ON the boundary and the admission is the equality branch,
      // not a value that landed just inside.
      expect(sampled(probe.x, probe.y), `${id} on the boundary`).toBe(true);
      const out = nextFloat32(probe.y, 1);
      expect(out, `${id}: the ulp step must move y`).not.toBe(probe.y);
      expect(sampled(probe.x, out), `${id} one ulp outward`).toBe(false);
      expect(sampled(probe.x, nextFloat32(probe.y, -1)), `${id} one ulp inward`).toBe(true);
    }
  });

  withReference('agrees with the OGR/SpatiaLite verdict on all seven cases', () => {
    const ref = readReference(REF);
    expect(ref.size, 'reference probe count').toBe(PROBES.length);
    for (const probe of PROBES) {
      const row = ref.get(probe.id);
      expect(row, `reference has no row for ${probe.id}`).toBeDefined();
      const label = `${probe.id} (case ${probe.caseNo}), ST_Distance ${row!.dist}`;
      expect(row!.capsule, `${label}: reference vs hand-derived`).toBe(probe.admitted);
      expect(sampled(probe.x, probe.y), `${label}: sampler vs reference`).toBe(row!.capsule);
      // Distances agree to the last bit the reference printed.
      expect(row!.dist).toBeCloseTo(endcapDistance(probe), 12);
    }
  });

  withReference('the reference puts the two tie cases exactly on the threshold', () => {
    const ref = readReference(REF);
    for (const [id, row] of ref) {
      const onBoundary = BOUNDARY_IDS.includes(id);
      // ST_Distance returned the band itself, not a neighbouring double. Without
      // this the inclusive verdict below would be a rounding accident.
      expect(row.onBoundary, `${id}: ST_Distance = band`).toBe(onBoundary);
      if (onBoundary) {
        expect(row.dist).toBe(ENDCAP_BAND);
        expect(row.capsule, `${id}: reference admits at equality`).toBe(true);
      }
    }
  });

  withReference('the reference states the rectangle rule itself', () => {
    const ref = readReference(REF);
    // The reference admits every probe under the square-ended rule and rejects
    // three under the segment rule, so the disagreement is the reference's
    // finding and not an assertion written on this side.
    for (const [id, row] of ref) expect(row.rect, `${id} rectangle`).toBe(true);
    expect([...ref].filter(([, r]) => !r.capsule).map(([id]) => id))
      .toEqual(['c3-square-corner', 'c4-start-cap-outside', 'c5b-end-cap-outside']);
  });

  withReference('records what produced the reference, separately from the study', () => {
    const runs = JSON.parse(readFileSync(RUNS, 'utf8')) as {
      runs: Record<string, { status: string; membershipSql?: string; band?: number }>;
    };
    expect(runs.runs.endcap.status).toBe('ok');
    expect(runs.runs.endcap.band).toBe(ENDCAP_BAND);
    // The corridor rule the reference applied, in its own words.
    expect(runs.runs.endcap.membershipSql).toContain(
      `ST_Distance(GeomFromText('LINESTRING(0 0,32 0)'), MakePoint(CAST(x AS REAL), CAST(y AS REAL))) <= 2.5`,
    );
  });
});
