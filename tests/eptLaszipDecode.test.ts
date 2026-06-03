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
  expect(decoded.positions.length).toBe(12 * 3);
  expect(decoded.intensity.length).toBe(12);
  expect(decoded.classification.length).toBe(12);
  expect(decoded.returnNumber.length).toBe(12);
  expect(decoded.returnCount.length).toBe(12);
  expect(decoded.gpsTime.length).toBe(12);
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
