#!/usr/bin/env node
/**
 * make-profile-fixture.mjs — the two committed point clouds behind the
 * MEAS-PROFILE cross-implementation study.
 *
 * Both are written as plain CSV (x,y,z[,cls]) because the reference pipeline
 * reads them with OGR and the elevations must survive the trip UNCHANGED: the
 * reference SQL passes the z column through as its original text, so the number
 * R reduces is the same number the sampler binned. Nothing re-prints an
 * elevation, so no comparison here can be measuring a transcode.
 *
 * Every coordinate is rounded to Float32 before it is printed, and printed with
 * the shortest decimal that round-trips. The sampler stores positions in a
 * Float32Array; the reference tools work in double. Writing values that are
 * exactly representable in both makes the two sides read identical numbers.
 *
 *   profile-ramp.csv     2570 corridor points + 514 off-corridor decoys + 2
 *                        beyond-the-end decoys. Ten points per station whose
 *                        elevations form an exact arithmetic progression across
 *                        the corridor, which is what gives the type-7 quantile
 *                        a closed form (see scripts/profile-fixture-params.mjs).
 *
 *   profile-scatter.csv  an oblique section line, irregular corridor
 *                        populations including single-point and empty stations,
 *                        classified vegetation / building / noise returns above
 *                        the ground, and returns outside the corridor. No closed
 *                        form applies; this is the fixture the external
 *                        reference is there for.
 *
 * Usage: node scripts/make-profile-fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RAMP_A, RAMP_B, RAMP_SAMPLES, RAMP_BAND, RAMP_BIN_STEP,
  RAMP_T_START, RAMP_T_STEP, RAMP_T_COUNT, RAMP_CROSS,
  RAMP_DECOY_T, RAMP_DECOY_LIFT, RAMP_END_DECOYS, rampGround,
  SCATTER_A, SCATTER_B, SCATTER_SAMPLES, SCATTER_BAND, SCATTER_BIN_STEP,
  SCATTER_EDGE_MARGIN, SCATTER_EMPTY_BINS, SCATTER_SEED,
  EXCLUDED_CLASSES,
} from './profile-fixture-params.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = resolve(ROOT, 'validation/cross-implementation/profile');

/** Float32-exact value, printed as the shortest decimal that round-trips. */
const f = (v) => String(Math.fround(v));

/** Deterministic 32-bit generator; the fixture bytes must not move between runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── RAMP ────────────────────────────────────────────────────────────────────

/**
 * z(s, t) = ground(s) + RAMP_CROSS·t. The cross-line term is what turns each
 * bin's elevations into an arithmetic progression.
 */
export function rampRows() {
  const rows = [];
  for (let i = 0; i < RAMP_SAMPLES; i++) {
    const s = i * RAMP_BIN_STEP;
    const g = rampGround(s);
    for (let k = 0; k < RAMP_T_COUNT; k++) {
      const t = RAMP_T_START + RAMP_T_STEP * k;
      rows.push([s, t, g + RAMP_CROSS * t]);
    }
    // Outside the corridor and well above it: a corridor gate that leaked would
    // move the reduced height by tens of metres, not by a rounding step.
    rows.push([s, -RAMP_DECOY_T, g + RAMP_DECOY_LIFT]);
    rows.push([s, RAMP_DECOY_T, g + RAMP_DECOY_LIFT]);
  }
  for (const s of RAMP_END_DECOYS) {
    rows.push([s, 0, rampGround(0) + RAMP_DECOY_LIFT]);
  }
  return rows;
}

function writeRamp() {
  const lines = ['x,y,z'];
  for (const [x, y, z] of rampRows()) lines.push(`${f(x)},${f(y)},${f(z)}`);
  const path = resolve(OUT_DIR, 'profile-ramp.csv');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, points: lines.length - 1 };
}

// ── SCATTER ─────────────────────────────────────────────────────────────────

const SCATTER_LEN = Math.hypot(SCATTER_B[0] - SCATTER_A[0], SCATTER_B[1] - SCATTER_A[1]);
const H_DIR = [(SCATTER_B[0] - SCATTER_A[0]) / SCATTER_LEN, (SCATTER_B[1] - SCATTER_A[1]) / SCATTER_LEN];
/** Left normal, in the horizontal plane. */
const N_DIR = [-H_DIR[1], H_DIR[0]];

/** Ground along the oblique section: a gentle rise with a wave on it. */
const scatterGround = (s) => 12 + 0.03 * s + 1.5 * Math.sin(s / 17);

/** Place a point at chainage `s` and cross-line offset `d`, rounded to Float32. */
function placeScatter(s, d) {
  return [
    Math.fround(SCATTER_A[0] + H_DIR[0] * s + N_DIR[0] * d),
    Math.fround(SCATTER_A[1] + H_DIR[1] * s + N_DIR[1] * d),
  ];
}

/** Chainage and perpendicular distance of a placed point, recomputed in double. */
function measure(x, y) {
  const dx = x - SCATTER_A[0];
  const dy = y - SCATTER_A[1];
  const along = dx * H_DIR[0] + dy * H_DIR[1];
  const px = dx - H_DIR[0] * along;
  const py = dy - H_DIR[1] * along;
  return { along, perp: Math.hypot(px, py) };
}

/**
 * Refuse a point that sits close enough to a bin boundary or to the corridor
 * edge that two implementations could classify it differently. The margin is a
 * property of the fixture, so it is asserted here rather than hoped for.
 */
function assertClear(x, y, expectBin) {
  const { along, perp } = measure(x, y);
  const offset = Math.abs(along / SCATTER_BIN_STEP - Math.round(along / SCATTER_BIN_STEP));
  if (Math.abs(0.5 - offset) < SCATTER_EDGE_MARGIN) {
    throw new Error(`point (${x}, ${y}) sits ${offset} of a bin from the boundary`);
  }
  if (Math.abs(perp - SCATTER_BAND) < SCATTER_EDGE_MARGIN) {
    throw new Error(`point (${x}, ${y}) sits ${perp} from the line, at the corridor edge`);
  }
  if (expectBin !== null && Math.round(along / SCATTER_BIN_STEP) !== expectBin) {
    throw new Error(`point (${x}, ${y}) landed in bin ${Math.round(along)}, not ${expectBin}`);
  }
}

export function scatterRows() {
  const rnd = mulberry32(SCATTER_SEED);
  const empty = new Set(SCATTER_EMPTY_BINS);
  const rows = [];
  const inner = SCATTER_BAND - SCATTER_EDGE_MARGIN;

  for (let i = 0; i < SCATTER_SAMPLES; i++) {
    if (empty.has(i)) continue;
    // Counts run 1 … 12 so ranks land at many different fractional positions,
    // and a station with a single return exercises the one-point path.
    const count = 1 + Math.floor(rnd() * 12);
    for (let k = 0; k < count; k++) {
      const s = i * SCATTER_BIN_STEP + (rnd() - 0.5) * 0.9;
      const d = (rnd() - 0.5) * 2 * inner;
      const [x, y] = placeScatter(s, d);
      assertClear(x, y, i);
      const ground = scatterGround(s) + (rnd() - 0.5) * 0.8;
      // One return in six is vegetation, building or noise, lifted well above
      // the ground so a class gate that failed would be unmistakable.
      const nonGround = rnd() < 1 / 6;
      const cls = nonGround
        ? EXCLUDED_CLASSES[Math.floor(rnd() * EXCLUDED_CLASSES.length)]
        : (rnd() < 0.2 ? 1 : 2);
      const z = nonGround ? ground + 12 + rnd() * 8 : ground;
      rows.push([x, y, Math.fround(z), cls]);
    }
    // Ground-classified returns OUTSIDE the corridor: rejected by geometry, not
    // by class, and at ordinary elevations so only the corridor gate can drop them.
    if (i % 5 === 0) {
      const side = rnd() < 0.5 ? -1 : 1;
      const d = side * (SCATTER_BAND + SCATTER_EDGE_MARGIN + rnd() * 3);
      const [x, y] = placeScatter(i * SCATTER_BIN_STEP, d);
      assertClear(x, y, null);
      rows.push([x, y, Math.fround(scatterGround(i) - 1.5), 2]);
    }
  }

  // Beyond both ends of the section, far enough out that the along-line gate and
  // a distance-to-segment test agree that they are not in the corridor.
  for (const s of [-8, SCATTER_LEN + 8]) {
    const [x, y] = placeScatter(s, 0);
    rows.push([x, y, Math.fround(scatterGround(0)), 2]);
  }
  return rows;
}

function writeScatter() {
  const lines = ['x,y,z,cls'];
  for (const [x, y, z, cls] of scatterRows()) lines.push(`${f(x)},${f(y)},${f(z)},${cls}`);
  const path = resolve(OUT_DIR, 'profile-scatter.csv');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, points: lines.length - 1 };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT_DIR, { recursive: true });
  const ramp = writeRamp();
  const scatter = writeScatter();
  console.log(`profile fixtures written`);
  console.log(`  ${ramp.path}  ${ramp.points} points, ${RAMP_SAMPLES} stations, corridor ±${RAMP_BAND} m`);
  console.log(`  ${scatter.path}  ${scatter.points} points, ${SCATTER_SAMPLES} stations, corridor ±${SCATTER_BAND} m`);
}
