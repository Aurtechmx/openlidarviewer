/**
 * profileCapsCrossCheck.test.ts — the corridor END CAPS against the same
 * independent implementation the MEAS-PROFILE study uses.
 *
 * WHY A SECOND FIXTURE. The reference corridor is
 * `ST_Distance(line, point) <= band` on a finite LINESTRING, which is a
 * distance to the SEGMENT: past an endpoint the corridor closes with a
 * half-disc of radius `band`. The ramp and scatter fixtures cannot detect
 * whether the sampler agrees, because their beyond-the-end returns are 10 m and
 * 8 m out against bands of 2.5 m and 1.75 m, so a rectangle with square ends
 * and a capsule reject them both. The MEAS-PROFILE-OGR-R-CORRIDOR study says so
 * in its own scope.unsupported, and this file is what closes that gap.
 *
 * The caps fixture puts thirteen probes past each end: five inside the cap, six
 * in the region a rectangle admits and the segment rule does not (cross-line
 * offset within the band, chainage no further past the end than the band, more
 * than the band from the endpoint), and two outside on either rule. The six are
 * carried at CAPS_REJECT_LIFT below the ground, so admitting one moves the
 * station's p25 by tens of metres.
 *
 * PER-STATION COUNTS ARE COMPARED EXACTLY. That is where the cap rule shows:
 * the two end stations hold eight interior returns plus the five admitted
 * probes, and a corridor gate with square ends would report nineteen.
 *
 * The reference is produced by scripts/run-profile-reference.mjs and recorded
 * in reference-runs-profile-caps.json, separate from the study's own record.
 * Skips rather than fails when it is absent; neither GDAL nor R is a project
 * dependency.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sampleProfile } from '../src/render/measure/profileSampler';
import type { Vec3 } from '../src/render/navMath';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import {
  CAPS_A, CAPS_B, CAPS_SAMPLES, CAPS_BAND, CAPS_T_COUNT, CAPS_PROBES, capsExpected,
  PERCENTILE_PRIMARY, PERCENTILE_SECONDARY, UP,
} from '../scripts/profile-fixture-params.mjs';

const DIR = resolve(__dirname, '../validation/cross-implementation/profile');
const CLOUD = resolve(DIR, 'profile-caps.csv');
const REF = resolve(DIR, 'profile-caps__profile.csv');
const RUNS = resolve(DIR, 'reference-runs-profile-caps.json');

/**
 * The tolerance is the one registered for MEAS-PROFILE in
 * PROTO-PROFILE-OGR-R-CORRIDOR. It is carried over, not preregistered for this
 * fixture: the caps fixture and its result were written in the same change.
 */
const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'MEAS-PROFILE')!;
const TOL = SLOT.toleranceAbs;
const vec3 = (v: number[]): Vec3 => [v[0], v[1], v[2]];

/** How many probes per end the segment rule admits, and how many it rejects. */
const ADMITTED_PROBES = CAPS_PROBES.filter(([, , a]) => a).length;
const REJECTED_PROBES = CAPS_PROBES.length - ADMITTED_PROBES;

function readCloud(path: string): Float32Array {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const n = lines.length - 1;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = lines[i + 1].split(',');
    positions[i * 3] = Number(f[0]);
    positions[i * 3 + 1] = Number(f[1]);
    positions[i * 3 + 2] = Number(f[2]);
  }
  return positions;
}

interface ReferenceSeries {
  counts: number[];
  heights: Record<string, number[]>;
}

function readSeries(path: string): ReferenceSeries {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const counts: number[] = [];
  const heights: Record<string, number[]> = {};
  for (const name of header.slice(2)) heights[name] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    expect(Number(f[0]), `${path}: stations out of order at row ${i}`).toBe(i - 1);
    counts.push(Number(f[1]));
    header.slice(2).forEach((name, k) => {
      heights[name].push(f[k + 2] === 'NA' ? Number.NaN : Number(f[k + 2]));
    });
  }
  return { counts, heights };
}

const capsProfile = (percentile: number) =>
  sampleProfile({
    a: vec3(CAPS_A),
    b: vec3(CAPS_B),
    up: vec3(UP),
    positions: readCloud(CLOUD),
    samples: CAPS_SAMPLES,
    bandWidth: CAPS_BAND,
    groundPercentile: percentile,
  });

const withReference = existsSync(REF) ? it : it.skip;
const LAST = CAPS_SAMPLES - 1;

describe('section profile cross-implementation: end caps', () => {
  it('the fixture actually contains probes in the disputed region', () => {
    // Without these the comparison would prove nothing the ramp does not.
    expect(ADMITTED_PROBES).toBeGreaterThan(0);
    expect(REJECTED_PROBES).toBeGreaterThan(0);
    const disputed = CAPS_PROBES.filter(
      ([past, t, admitted]) => !admitted && past <= CAPS_BAND && Math.abs(t) <= CAPS_BAND,
    );
    // A rectangle with square ends admits every one of these; the segment rule
    // rejects them because each is further than the band from the endpoint.
    expect(disputed.length).toBeGreaterThanOrEqual(4);
    for (const [past, t] of disputed) expect(Math.hypot(past, t)).toBeGreaterThan(CAPS_BAND);
  });

  it('admits the cap probes and no others, at both ends', () => {
    const ours = capsProfile(PERCENTILE_PRIMARY);
    expect(ours).toHaveLength(CAPS_SAMPLES);
    expect(ours[0].count, 'first station').toBe(CAPS_T_COUNT + ADMITTED_PROBES);
    expect(ours[LAST].count, 'last station').toBe(CAPS_T_COUNT + ADMITTED_PROBES);
    for (let i = 1; i < LAST; i++) {
      expect(ours[i].count, `interior station ${i}`).toBe(CAPS_T_COUNT);
    }
  });

  it('matches the closed form at every interior station', () => {
    // The end stations are outside its reach: the admitted probes join their
    // corridors, so those two are no longer an arithmetic progression.
    for (const p of [PERCENTILE_PRIMARY, PERCENTILE_SECONDARY]) {
      const ours = capsProfile(p).slice(1, LAST).map((s) => s.height);
      const truth = Array.from({ length: LAST - 1 }, (_, k) => capsExpected(k + 1, p));
      const report = crossCheck(ours, truth, { toleranceAbs: TOL, minCells: 30 });
      expect(report.verdict, `p=${p} vs closed form: ${report.summary}`).toBe('agree');
    }
  });

  withReference('agrees with the OGR/R reference over the cap region', () => {
    const ref = readSeries(REF);
    expect(ref.counts.length, 'reference station count').toBe(CAPS_SAMPLES);

    let compared = 0;
    let worst = 0;
    for (const p of [PERCENTILE_PRIMARY, PERCENTILE_SECONDARY]) {
      const ours = capsProfile(p);
      // The corridor both implementations selected has to be the same one.
      expect(ours.map((s) => s.count), `p=${p}: per-station corridor counts`)
        .toEqual(ref.counts);

      const reference = ref.heights[`p${p}`];
      expect(reference, `reference has no p${p} column`).toBeDefined();
      const report = crossCheck(ours.map((s) => s.height), reference, {
        toleranceAbs: TOL, minCells: 30,
      });
      expect(report.verdict, `caps p${p}: ${report.summary}`).toBe('agree');
      console.log(`MEAS-PROFILE caps  p${p}: ${report.summary}`);
      compared += report.count;
      worst = Math.max(worst, report.maxAbsDiff);
    }
    console.log(`MEAS-PROFILE caps pooled: ${compared} stations compared, max |Δ| ${worst}`);
    expect(compared).toBe(2 * CAPS_SAMPLES);
  });

  withReference('records what produced the reference, separately from the study', () => {
    const runs = JSON.parse(readFileSync(RUNS, 'utf8')) as {
      runs: Record<string, { status: string; corridorSql?: string }>;
    };
    expect(runs.runs.caps.status).toBe('ok');
    // The corridor rule the reference applied, in its own words.
    expect(runs.runs.caps.corridorSql).toContain(`ST_Distance(GeomFromText('LINESTRING(0 0,32 0)'), MakePoint(CAST(x AS REAL), CAST(y AS REAL))) <= 2`);
  });
});
