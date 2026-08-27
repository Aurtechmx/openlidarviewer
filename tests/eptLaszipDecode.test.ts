/**
 * eptLaszipDecode.test.ts — v0.3.3 — laszip tile decoder.
 *
 * Two layers covered:
 *   1. End-to-end decode of a real LAZ tile (`tests/fixtures/tiny.laz`,
 *      663 bytes) — verifies LAS header parse + laz-perf invocation +
 *      DecodedChunk output shape + the Float64-subtract-narrow precision
 *      contract from `docs/coordinate-precision.md`.
 *   2. Failure paths — buffers that aren't LAS, unsupported PDRFs.
 *
 * The fixture is the same `tiny.laz` the static-loader tests use; reusing
 * it means we don't grow the test-data footprint and the decoder is
 * automatically exercised against the same bytes the COPC pipeline reads.
 *
 * laz-perf needs the WASM module — slow first call (~30-50 ms) then
 * cached. The test runs in Node via vitest's default DOM-shim so
 * `WebAssembly` is available.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { decodeEptLaszipTile } from '../src/io/ept/eptLaszipDecode';

const TINY_LAZ = readFileSync(join(__dirname, 'fixtures', 'tiny.laz'));
const TINY_LAZ_BUF = TINY_LAZ.buffer.slice(
  TINY_LAZ.byteOffset,
  TINY_LAZ.byteOffset + TINY_LAZ.byteLength,
);

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end decode against the real tiny.laz fixture
// ─────────────────────────────────────────────────────────────────────────────

test('decodeEptLaszipTile decodes the tiny.laz fixture into a DecodedChunk', async () => {
  const decoded = await decodeEptLaszipTile(TINY_LAZ_BUF, [0, 0, 0]);
  // tiny.laz has 12 points (the bundled fixture's actual count).
  expect(decoded.pointCount).toBe(12);
  expect(decoded.positions).toHaveLength(12 * 3);
  expect(decoded.intensity).toHaveLength(12);
  expect(decoded.classification).toHaveLength(12);
  expect(decoded.returnNumber).toHaveLength(12);
  expect(decoded.returnCount).toHaveLength(12);
  expect(decoded.gpsTime).toHaveLength(12);
  // tiny.laz has no RGB (PDRF without colour); the field is undefined.
  expect(decoded.rgb).toBeUndefined();
});

test('decodeEptLaszipTile produces finite positions inside a reasonable bound', async () => {
  const decoded = await decodeEptLaszipTile(TINY_LAZ_BUF, [0, 0, 0]);
  // The fixture's coordinates are small (no offset/origin); every value
  // must be finite (no NaN / Infinity from a misaligned read).
  for (let i = 0; i < decoded.positions.length; i++) {
    expect(Number.isFinite(decoded.positions[i])).toBe(true);
  }
});

test('decodeEptLaszipTile applies the render origin in Float64', async () => {
  // Render origin shifts every local position by the same delta. Run twice
  // — once with origin (0,0,0), once with (100, 200, 300) — and check
  // the corresponding coordinate residuals match to sub-mm precision.
  const a = await decodeEptLaszipTile(TINY_LAZ_BUF, [0, 0, 0]);
  const b = await decodeEptLaszipTile(TINY_LAZ_BUF, [100, 200, 300]);
  for (let i = 0; i < a.pointCount; i++) {
    expect(Math.abs((a.positions[i * 3]     - b.positions[i * 3])     - 100)).toBeLessThan(1e-3);
    expect(Math.abs((a.positions[i * 3 + 1] - b.positions[i * 3 + 1]) - 200)).toBeLessThan(1e-3);
    expect(Math.abs((a.positions[i * 3 + 2] - b.positions[i * 3 + 2]) - 300)).toBeLessThan(1e-3);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────────────────────────────────────

test('decodeEptLaszipTile rejects a non-LAS buffer', async () => {
  const garbage = new Uint8Array(1024).buffer;
  await expect(decodeEptLaszipTile(garbage, [0, 0, 0])).rejects.toThrow(/LAS|signature|small/i);
});

test('decodeEptLaszipTile rejects an unsupported PDRF', async () => {
  // Synthesise a buffer with the LASF signature + a PDRF byte set to 9
  // (which is in the spec but not in our supported set). Use a real LAS
  // header so parseLasHeader runs to completion.
  const buf = new Uint8Array(TINY_LAZ_BUF.byteLength);
  buf.set(new Uint8Array(TINY_LAZ_BUF));
  // Stripping the LAZ compression bit means the high-bit clear leaves the
  // PDRF in the low six bits. Force the field to 9.
  // OFFSET_POINT_FORMAT is at byte 104 per the LAS spec.
  buf[104] = 9;
  await expect(decodeEptLaszipTile(buf.buffer, [0, 0, 0])).rejects.toThrow(/format 9|unsupported/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Finite-coordinate guard
//
// The COPC chunk decoder and the EPT binary decoder both refuse a node whose
// transform or decoded positions are non-finite. This path called neither, so a
// corrupt or hostile remote tile delivered Infinity straight into three.js: NaN
// bounding sphere, broken culling, blank cloud, and no structured error for the
// scheduler to back off from.
// ─────────────────────────────────────────────────────────────────────────────

test('decodeEptLaszipTile refuses a non-finite render origin', async () => {
  await expect(decodeEptLaszipTile(TINY_LAZ_BUF, [Number.NaN, 0, 0])).rejects.toThrow(
    /non-finite value.*node is refused/s,
  );
});

test('decodeEptLaszipTile refuses a tile whose scale overflows a coordinate', async () => {
  // parseLasHeader accepts this scale — it is finite and positive — but
  // int32 · 1e300 overflows to ±Infinity in the coordinate loop, which is
  // exactly what the up-front transform check cannot catch.
  const buf = new Uint8Array(TINY_LAZ_BUF.byteLength);
  buf.set(new Uint8Array(TINY_LAZ_BUF));
  const v = new DataView(buf.buffer);
  for (let a = 0; a < 3; a++) v.setFloat64(131 + a * 8, 1e300, true);
  await expect(decodeEptLaszipTile(buf.buffer, [0, 0, 0])).rejects.toThrow(
    /non-finite coordinate at point/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GPS time is the one channel a LAS point record can genuinely lack.
//
// A LAZ-backed EPT tile is a complete LAS file, so intensity, the return bits,
// classification and point source id are structurally in every supported
// record (PDRF 0-3 and 6-8) and are always readings. GPS time is not: PDRF 0
// and 2 carry no GPS field at all. The decoder used to allocate a full-length
// Float64Array regardless, so every point of such a tile reported a GPS time of
// exactly zero — a measurement the file never made.
//
// `tiny-pdrf0.laz` and `tiny-pdrf1.laz` are the A/B pair: 8 points of identical
// data, written with laspy at point_format 0 and 1, version 1.2, scales
// [0.001, 0.001, 0.001] and zero offsets:
//   x = i·1.0, y = i·2.0, z = i·0.5, intensity = i·100 + 7,
//   classification = [2,2,5,5,1,1,6,6], return_number = [1,2]·4,
//   number_of_returns = 2 for every point
// PDRF 1 additionally carries gps_time = 100.5 + i·0.25. Same points, one
// format with a GPS field and one without, so the only difference the tests can
// see is the one the fix is about.
// ─────────────────────────────────────────────────────────────────────────────

function tileBuffer(name: string): ArrayBuffer {
  const bytes = readFileSync(join(__dirname, 'fixtures', name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const PDRF0_LAZ_BUF = tileBuffer('tiny-pdrf0.laz');
const PDRF1_LAZ_BUF = tileBuffer('tiny-pdrf1.laz');

test('a PDRF 0 tile carries no gpsTime channel', async () => {
  const decoded = await decodeEptLaszipTile(PDRF0_LAZ_BUF, [0, 0, 0]);
  expect(decoded.pointCount).toBe(8);
  expect(decoded.gpsTime).toBeUndefined();
});

test('a PDRF 0 tile still carries the channels its records do hold', async () => {
  // The fields above are in every PDRF 0 record, so dropping them alongside
  // GPS time would lose real readings. Values are the ones written into the
  // fixture, read back exactly.
  const decoded = await decodeEptLaszipTile(PDRF0_LAZ_BUF, [0, 0, 0]);
  expect([...decoded.intensity!]).toEqual([7, 107, 207, 307, 407, 507, 607, 707]);
  expect([...decoded.classification!]).toEqual([2, 2, 5, 5, 1, 1, 6, 6]);
  expect([...decoded.returnNumber!]).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
  expect([...decoded.returnCount!]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  expect(decoded.pointSourceId).toHaveLength(8);
  // x = i·1.0, y = i·2.0, z = i·0.5 for i in 0..7.
  for (let i = 0; i < 8; i++) {
    expect(decoded.positions[i * 3]).toBeCloseTo(i, 3);
    expect(decoded.positions[i * 3 + 1]).toBeCloseTo(i * 2, 3);
    expect(decoded.positions[i * 3 + 2]).toBeCloseTo(i * 0.5, 3);
  }
});

test('the same points at PDRF 1 keep gpsTime, with the times the file stores', async () => {
  // The counterpart the fix must not touch. Same eight points as the PDRF 0
  // fixture; the only change is a format whose records carry GPS time, and the
  // channel comes back with the written values rather than a run of zeroes.
  const decoded = await decodeEptLaszipTile(PDRF1_LAZ_BUF, [0, 0, 0]);
  expect([...decoded.gpsTime!]).toEqual([
    100.5, 100.75, 101, 101.25, 101.5, 101.75, 102, 102.25,
  ]);
  expect([...decoded.intensity!]).toEqual([7, 107, 207, 307, 407, 507, 607, 707]);
  expect([...decoded.classification!]).toEqual([2, 2, 5, 5, 1, 1, 6, 6]);
});

test('a PDRF 6 tile keeps its gpsTime channel', async () => {
  // tiny.laz is PDRF 6, whose records carry a GPS field. Every time it stores
  // is 0.0, and those zeroes are readings the file made — which is exactly what
  // a PDRF 0 tile's absent channel is not.
  const decoded = await decodeEptLaszipTile(TINY_LAZ_BUF, [0, 0, 0]);
  expect(decoded.gpsTime).toHaveLength(12);
});
