#!/usr/bin/env node
/**
 * make-profile-section-fixture.mjs — the point cloud behind the per-point
 * section projection reference.
 *
 * The MEAS-PROFILE study checks the reduced percentile series. It says nothing
 * about where an individual return lands, which is what a cross-section view
 * shows. This fixture supplies that: every point's chainage and lateral offset
 * are resolved by OGR, so the projection is graded against an implementation
 * OLV did not write.
 *
 * Written as plain CSV for the same reason as the other profile fixtures: the
 * reference SQL passes coordinates through as their original text, so no
 * comparison here can be measuring a transcode.
 *
 * Every coordinate is a dyadic rational and is exactly representable in
 * Float32 and in double, so both sides read identical numbers.
 *
 * The section is oblique in XY and the scene is Z-up, because OGR resolves
 * geometry in the horizontal plane and cannot express an arbitrary up axis.
 * Orientation beyond Z-up is covered by the metamorphic relations, not here.
 */
import { writeFileSync } from 'node:fs';
import { isCliEntry } from './lib/isCliEntry.mjs';

/** Section endpoints. Oblique, and dyadic so the length is exact. */
export const SECTION_A = [-8, 6];
export const SECTION_B = [40, 42];
export const BAND = 2.5;

/** |b - a| = hypot(48, 36) = 60 exactly, a 3-4-5 triple scaled by 12. */
const LEN = Math.hypot(SECTION_B[0] - SECTION_A[0], SECTION_B[1] - SECTION_A[1]);
const ALONG = [(SECTION_B[0] - SECTION_A[0]) / LEN, (SECTION_B[1] - SECTION_A[1]) / LEN];
// Left normal, matching up x along for up = +Z.
const LATERAL = [-ALONG[1], ALONG[0]];

/**
 * Points placed by construction at a chosen chainage and lateral offset, so
 * the expected projection is known before any tool runs.
 *
 * Chainages and offsets are eighths, and the unit vectors are exact fifths
 * (0.8, 0.6), so every product below is exact in binary floating point.
 */
function place(chainage, lateral, height) {
  return [
    SECTION_A[0] + ALONG[0] * chainage + LATERAL[0] * lateral,
    SECTION_A[1] + ALONG[1] * chainage + LATERAL[1] * lateral,
    height,
  ];
}

const rows = [];
let n = 0;
const push = (id, chainage, lateral, height, attrs) => {
  const [x, y, z] = place(chainage, lateral, height);
  rows.push({ id, x, y, z, chainage, lateral, ...attrs });
  n++;
};

// Body returns across the whole section, both sides, at eighth offsets.
const OFFSETS = [-2.5, -1.875, -1.25, -0.625, 0, 0.625, 1.25, 1.875, 2.5];
for (let sIdx = 0; sIdx <= 48; sIdx++) {
  const chainage = sIdx * 1.25;
  for (let k = 0; k < OFFSETS.length; k++) {
    const lateral = OFFSETS[k];
    // Height varies with both chainage and offset so a swapped axis shows up.
    const height = 100 + chainage * 0.25 + lateral * 0.5;
    push(`b${sIdx}-${k}`, chainage, lateral, height, {
      intensity: (sIdx * 9 + k * 101) % 65536,
      classification: [2, 3, 4, 5, 6][(sIdx + k) % 5],
      return_number: (k % 4) + 1,
      return_count: 4,
      point_source_id: 7000 + (sIdx % 13),
      gps_time: 1351260714.5 + sIdx * 0.125 + k * 0.015625,
      r: (sIdx * 5) % 256,
      g: (k * 29) % 256,
      b: (sIdx + k * 7) % 256,
    });
  }
}

// Off-corridor decoys just past the band on both sides.
for (let sIdx = 0; sIdx <= 48; sIdx += 4) {
  const chainage = sIdx * 1.25;
  for (const lateral of [-3.125, 3.125, -5, 5]) {
    push(`o${sIdx}-${lateral}`, chainage, lateral, 100 + chainage * 0.25, {
      intensity: 1,
      classification: 1,
      return_number: 1,
      return_count: 1,
      point_source_id: 7999,
      gps_time: 1351260800.0,
      r: 0,
      g: 0,
      b: 0,
    });
  }
}

// Beyond the caps, on the axis and diagonally, to exercise capsule ends.
//
// The corner entries are the discriminating ones. Each sits less than a band
// past an end, so the corridor's cheap scalar reject does not reach it, and
// its radial distance from the endpoint exceeds the band while its distance
// from the infinite line does not. A corridor that dropped its end caps would
// admit them.
for (const [chainage, lateral, tag] of [
  [-1.25, 0, 'pre-axis'],
  [-1.25, 1.875, 'pre-diag'],
  [-1.25, 2.5, 'pre-corner'],
  [-2.5, 2.5, 'pre-corner-far'],
  [-3.125, 0, 'pre-far'],
  [61.25, 0, 'post-axis'],
  [61.25, 1.875, 'post-diag'],
  [61.25, 2.5, 'post-corner'],
  [62.5, 2.5, 'post-corner-far'],
  [63.125, 0, 'post-far'],
]) {
  push(`c-${tag}`, chainage, lateral, 100, {
    intensity: 2,
    classification: 2,
    return_number: 1,
    return_count: 1,
    point_source_id: 7998,
    gps_time: 1351260900.0,
    r: 255,
    g: 255,
    b: 255,
  });
}

// Offsets a hair outside the band, at 2^-14 and 2^-13 beyond it. Both are
// dyadic and exact in Float32 and in double. A band widened by even 1e-4
// relative would admit them, which offsets on an eighth grid cannot show.
for (const [chainage, lateral, tag] of [
  [15, 2.50006103515625, 'edge-out-a'],
  [30, 2.5001220703125, 'edge-out-b'],
  [45, -2.50006103515625, 'edge-out-c'],
  [22.5, 2.5, 'edge-on'],
  [37.5, -2.5, 'edge-on-neg'],
]) {
  push(`e-${tag}`, chainage, lateral, 100 + chainage * 0.25, {
    intensity: 3,
    classification: 2,
    return_number: 1,
    return_count: 1,
    point_source_id: 7997,
    gps_time: 1351260950.0,
    r: 128,
    g: 128,
    b: 128,
  });
}

const COLUMNS = [
  'id',
  'x',
  'y',
  'z',
  'intensity',
  'classification',
  'return_number',
  'return_count',
  'point_source_id',
  'gps_time',
  'r',
  'g',
  'b',
];

/** Shortest decimal that round-trips, so no value is re-quantised on read. */
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(v));

export function buildSectionFixture() {
  return {
    columns: COLUMNS,
    rows,
    sectionA: SECTION_A,
    sectionB: SECTION_B,
    band: BAND,
    length: LEN,
  };
}

export function writeSectionFixture(path) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => fmt(r[c])).join(','));
  writeFileSync(path, lines.join('\n') + '\n');
  return rows.length;
}

/** Expected chainage and lateral offset per point, known by construction. */
export function writeExpected(path) {
  const lines = ['id,chainage,lateral'];
  for (const r of rows) lines.push(`${r.id},${fmt(r.chainage)},${fmt(r.lateral)}`);
  writeFileSync(path, lines.join('\n') + '\n');
  return rows.length;
}

if (isCliEntry(import.meta.url)) {
  const base = 'validation/cross-implementation/profile';
  const a = writeSectionFixture(`${base}/profile-section.csv`);
  writeExpected(`${base}/profile-section__expected.csv`);
  process.stdout.write(`profile-section.csv: ${a} points, length ${LEN}, band ${BAND}\n`);
}
