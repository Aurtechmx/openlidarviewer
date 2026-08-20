/**
 * profileCrossCheck.test.ts — the corridor section profile against an
 * independent implementation.
 *
 * A profile is two operations, and neither of them is done twice in this
 * repository to produce the reference. Chainage and perpendicular distance come
 * from OGR's SpatiaLite functions (ST_Line_Locate_Point, ST_Distance); the
 * per-station reduction comes from R's `quantile(type = 7)`, the implementation
 * the type numbering is named after. `scripts/run-profile-reference.mjs` runs
 * both once and commits the outputs; this file reads them and never invokes a
 * tool.
 *
 * THREE WAYS ON THE RAMP. The ramp fixture holds ten corridor elevations per
 * station in an exact arithmetic progression, and the type-7 quantile of an
 * arithmetic progression is `first + step·(p/100)·(n − 1)` — a closed form with
 * no sort and no order statistic in it. So the ramp is checked against the
 * external reference AND against the surface equation, and the reference is
 * checked against the surface equation too. A reference produced with the wrong
 * corridor or the wrong percentile surfaces against the closed form instead of
 * being averaged into a plausible agreement.
 *
 * The oblique scatter fixture is where the closed form runs out: irregular
 * corridor populations, stations with one return, stations with none, vegetation
 * and building returns above the ground, and ground returns outside the
 * corridor. Only an independent implementation can say what its profile is.
 *
 * COUNTS ARE COMPARED EXACTLY, not against the tolerance. They are what makes a
 * gap a gap: a station the sampler reports empty has to be a station the
 * reference found no corridor points for, and a height quietly interpolated
 * across a gap would show as a count of zero beside a number.
 *
 * Skips rather than fails when the reference is absent (neither GDAL nor R is a
 * project dependency); the slot stays pending until the files land.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sampleProfile } from '../src/render/measure/profileSampler';
import type { Vec3 } from '../src/render/navMath';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import {
  RAMP_A, RAMP_B, RAMP_SAMPLES, RAMP_BAND, RAMP_T_COUNT, rampExpected,
  SCATTER_A, SCATTER_B, SCATTER_SAMPLES, SCATTER_BAND, SCATTER_EMPTY_BINS,
  PERCENTILE_PRIMARY, PERCENTILE_SECONDARY, EXCLUDED_CLASSES, UP,
} from '../scripts/profile-fixture-params.mjs';

const DIR = resolve(__dirname, '../validation/cross-implementation/profile');
const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'MEAS-PROFILE')!;
const TOL = SLOT.toleranceAbs;
const vec3 = (v: number[]): Vec3 => [v[0], v[1], v[2]];

interface Cloud {
  positions: Float32Array;
  classification?: Uint8Array;
}

/** Read an x,y,z[,cls] fixture into the interleaved buffer the sampler reads. */
function readCloud(path: string): Cloud {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const hasClass = header.includes('cls');
  const n = lines.length - 1;
  const positions = new Float32Array(n * 3);
  const classification = hasClass ? new Uint8Array(n) : undefined;
  for (let i = 0; i < n; i++) {
    const f = lines[i + 1].split(',');
    positions[i * 3] = Number(f[0]);
    positions[i * 3 + 1] = Number(f[1]);
    positions[i * 3 + 2] = Number(f[2]);
    if (classification) classification[i] = Number(f[3]);
  }
  return { positions, classification };
}

interface ReferenceSeries {
  counts: number[];
  /** Percentile column name (`p25`) to its per-station values, NaN where empty. */
  heights: Record<string, number[]>;
}

/** Read a reference series: station, count, then one column per percentile. */
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

const RAMP_CLOUD = resolve(DIR, 'profile-ramp.csv');
const SCATTER_CLOUD = resolve(DIR, 'profile-scatter.csv');
const RAMP_REF = resolve(DIR, 'profile-ramp__profile.csv');
const SCATTER_REF = resolve(DIR, 'profile-scatter__profile.csv');

const rampProfile = (percentile: number) =>
  sampleProfile({
    a: vec3(RAMP_A),
    b: vec3(RAMP_B),
    up: vec3(UP),
    positions: readCloud(RAMP_CLOUD).positions,
    samples: RAMP_SAMPLES,
    bandWidth: RAMP_BAND,
    groundPercentile: percentile,
  });

const scatterProfile = () => {
  const cloud = readCloud(SCATTER_CLOUD);
  return sampleProfile({
    a: vec3(SCATTER_A),
    b: vec3(SCATTER_B),
    up: vec3(UP),
    positions: cloud.positions,
    samples: SCATTER_SAMPLES,
    bandWidth: SCATTER_BAND,
    groundPercentile: PERCENTILE_PRIMARY,
    classification: cloud.classification,
    excludeClasses: EXCLUDED_CLASSES,
  });
};

const withReference = existsSync(RAMP_REF) && existsSync(SCATTER_REF) ? it : it.skip;

describe('section profile cross-implementation', () => {
  it('has a declared reference slot with a pre-registered tolerance', () => {
    expect(SLOT.referenceTool).toBe('R');
    expect(SLOT.toleranceAbs).toBe(1e-6);
    expect(SLOT.unit).toBe('m');
  });

  it('the ramp profile matches the closed form the fixture surface implies', () => {
    for (const p of [PERCENTILE_PRIMARY, PERCENTILE_SECONDARY]) {
      const ours = rampProfile(p);
      expect(ours).toHaveLength(RAMP_SAMPLES);
      const truth = ours.map((_, i) => rampExpected(i, p));
      const report = crossCheck(ours.map((s) => s.height), truth, {
        toleranceAbs: TOL, minCells: 250,
      });
      expect(report.verdict, `p=${p} vs closed form: ${report.summary}`).toBe('agree');
      // Off-corridor and beyond-the-end returns never entered a station.
      for (const s of ours) expect(s.count).toBe(RAMP_T_COUNT);
    }
  });

  it('reports the deliberate gaps in the oblique fixture as gaps', () => {
    const ours = scatterProfile();
    expect(ours).toHaveLength(SCATTER_SAMPLES);
    for (const i of SCATTER_EMPTY_BINS) {
      expect(ours[i].count, `station ${i} should be empty`).toBe(0);
      expect(Number.isNaN(ours[i].height), `station ${i} should be a gap`).toBe(true);
    }
  });

  withReference('agrees with the OGR/R reference, which agrees with the closed form', () => {
    let compared = 0;
    let skipped = 0;
    let worst = 0;
    let sumSq = 0;
    let sumDiff = 0;
    let within = 0;

    const legs: Array<{ name: string; ours: ReturnType<typeof sampleProfile>; ref: ReferenceSeries; column: string; truth: number[] | null }> = [
      {
        name: `ramp p${PERCENTILE_PRIMARY}`,
        ours: rampProfile(PERCENTILE_PRIMARY),
        ref: readSeries(RAMP_REF),
        column: `p${PERCENTILE_PRIMARY}`,
        truth: Array.from({ length: RAMP_SAMPLES }, (_, i) => rampExpected(i, PERCENTILE_PRIMARY)),
      },
      {
        name: `ramp p${PERCENTILE_SECONDARY}`,
        ours: rampProfile(PERCENTILE_SECONDARY),
        ref: readSeries(RAMP_REF),
        column: `p${PERCENTILE_SECONDARY}`,
        truth: Array.from({ length: RAMP_SAMPLES }, (_, i) => rampExpected(i, PERCENTILE_SECONDARY)),
      },
      {
        name: `scatter p${PERCENTILE_PRIMARY}`,
        ours: scatterProfile(),
        ref: readSeries(SCATTER_REF),
        column: `p${PERCENTILE_PRIMARY}`,
        truth: null,
      },
    ];

    for (const leg of legs) {
      const reference = leg.ref.heights[leg.column];
      expect(reference, `${leg.name}: reference has no ${leg.column} column`).toBeDefined();
      expect(reference.length, `${leg.name}: reference station count`).toBe(leg.ours.length);
      // The corridor the two implementations selected has to be the same one.
      expect(leg.ours.map((s) => s.count), `${leg.name}: per-station corridor counts`)
        .toEqual(leg.ref.counts);

      const opts = { toleranceAbs: TOL, minCells: 230 };
      if (leg.truth !== null) {
        const refVsTruth = crossCheck(reference, leg.truth, opts);
        expect(refVsTruth.verdict, `${leg.name} reference vs closed form: ${refVsTruth.summary}`).toBe('agree');
      }
      const report = crossCheck(leg.ours.map((s) => s.height), reference, opts);
      expect(report.verdict, `${leg.name}: ${report.summary}`).toBe('agree');
      console.log(`MEAS-PROFILE  ${leg.name}: ${report.summary}`);

      compared += report.count;
      skipped += report.skipped;
      worst = Math.max(worst, report.maxAbsDiff);
      sumSq += report.rmse * report.rmse * report.count;
      sumDiff += report.meanDiff * report.count;
      within += report.withinTolFraction * report.count;
    }

    console.log(
      `MEAS-PROFILE pooled: ${compared} stations compared, ${skipped} skipped, `
        + `max |Δ| ${worst}, RMSE ${Math.sqrt(sumSq / compared)}, `
        + `bias ${sumDiff / compared}, within ${within / compared}`,
    );
    expect(compared).toBeGreaterThanOrEqual(700);
    expect(within / compared).toBe(1);
  });

  it('keeps the slot pending until a reference is actually supplied', () => {
    expect(SLOT.status).toBe(existsSync(RAMP_REF) && existsSync(SCATTER_REF) ? 'supplied' : 'pending');
  });
});
