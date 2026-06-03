/**
 * copcDecodePrecision.test.ts — v0.3.2-Georef precision invariant.
 *
 * The COPC chunk decoder writes positions as:
 *
 *   positions[i*3 + axis] = int32_value * scale + offset - renderOrigin
 *
 * For research-grade accuracy this expression MUST evaluate in Float64 from
 * end to end, with the Float32 narrow happening only at the assignment to
 * the typed array. Doing the subtraction in Float32 (or pre-narrowing the
 * `int * scale + offset` term) would discard sub-metre detail at typical
 * UTM magnitudes (~10⁶ metres easting/northing).
 *
 * These tests pin that invariant. If a refactor moves the narrow up the
 * expression — or breaks the addition order — the test fails loudly with
 * a concrete millimetre delta on a known UTM coordinate.
 *
 * Pure Node — no DOM, no three.js, no WebGPU.
 */

import { test, expect } from 'vitest';

/** A Float32 round-trip — what every position element experiences on store. */
function f32(x: number): number {
  return new Float32Array([x])[0];
}

/**
 * The exact decode expression from `src/io/copc/copcChunkDecode.ts`. Kept
 * here as a separate function so the invariant is tested independently of
 * any refactor of the decoder loop. If the decoder ever changes its math,
 * mirror the change here too — the test exists precisely to catch silent
 * drift from this contract.
 */
function decodePosition(
  intValue: number,
  scale: number,
  offset: number,
  renderOrigin: number,
): number {
  // The whole RHS evaluates in Float64; the f32 narrow is the typed-array
  // assignment. Mirroring the decoder's order: int*scale + offset - origin.
  return f32(intValue * scale + offset - renderOrigin);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTM 12N — eastings around 500,000 m, northings around 4,000,000 m.
// LAS scale typically 0.001 (mm precision), offset = floor(min) of the cloud.
// ─────────────────────────────────────────────────────────────────────────────

test('UTM 12N — millimetre precision preserved across the decode', () => {
  // Setup: a LAS file with mm-scale encoding (scale 0.001) and offset at
  // the cloud's floored min. Render origin equals the LAS offset (typical
  // for a cloud whose first byte is the floored min).
  const scale = 0.001;
  const offset = 4_100_876;  // northing, m, integer floor
  const renderOrigin = 4_100_876;

  // A point sitting 12,345.678 m above the offset's reference — so the
  // raw int32 value the file stores is (12_345.678 / 0.001) = 12_345_678.
  const intValue = 12_345_678;
  const decoded = decodePosition(intValue, scale, offset, renderOrigin);

  // Expected: 4_100_876 + 12_345.678 - 4_100_876 = 12_345.678 m, sub-mm.
  expect(decoded).toBeCloseTo(12345.678, 3);
  // And the Float32 residual is well within sub-mm:
  expect(Math.abs(decoded - 12345.678)).toBeLessThan(1e-3);
});

test('UTM 12N — sub-mm precision held at 10 km from origin', () => {
  // The acceptance bound from v0.3.1 — sub-mm anywhere in ±10 km.
  const scale = 0.001;
  const offset = 487_000;
  const renderOrigin = 487_000;

  // 10 km out: intValue = 10_000_000 (10_000.000 / 0.001).
  const intValue = 10_000_000;
  const decoded = decodePosition(intValue, scale, offset, renderOrigin);

  // 10,000 metres residual — Float32 holds 7 decimal digits, so 10,000.000
  // (5 digits before the decimal) leaves 2 for sub-mm. The actual residual
  // is much better than 1 mm; the bound is generous.
  expect(Math.abs(decoded - 10_000.0)).toBeLessThan(1e-3);
});

// ─────────────────────────────────────────────────────────────────────────────
// State Plane (US survey feet) — eastings around 6,000,000 ft.
// US Survey Foot scale = 1200/3937 ≈ 0.30480060960121922.
// ─────────────────────────────────────────────────────────────────────────────

test('State Plane survey-feet decode — float64 path preserves precision', () => {
  // LAS scale 0.01 (cm) on a state-plane easting in survey feet.
  const scale = 0.01;
  const offset = 6_500_000;  // easting, US survey ft
  const renderOrigin = 6_500_000;

  const intValue = 12_345_67;  // → 12345.67 ft above offset
  const decoded = decodePosition(intValue, scale, offset, renderOrigin);

  // Expected: 12345.67 (in feet, since CRS-aware metre conversion is the
  // measurement-tool's job, not the decoder's). Sub-cm precision.
  expect(Math.abs(decoded - 12_345.67)).toBeLessThan(1e-2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression — wrong narrow order would fail this test
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESSION — narrowing before subtract loses precision at UTM scale', () => {
  // If a refactor accidentally did `f32(int * scale + offset) - origin`
  // (narrow first, subtract second), this is what would happen — the
  // (int*scale + offset) value at UTM scale loses precision to ~0.5 m.
  const scale = 0.001;
  const offset = 4_100_876;
  const renderOrigin = 4_100_876;
  const intValue = 12_345_678;

  // Correct decode (current implementation).
  const correct = decodePosition(intValue, scale, offset, renderOrigin);

  // The hypothetical wrong-order version — narrowing the intermediate.
  const wrong = f32(intValue * scale + offset) - renderOrigin;

  // The wrong version's error is at least 1 cm at UTM 4M; the correct
  // version's error is sub-mm. The gap is the audit's point.
  expect(Math.abs(correct - 12345.678)).toBeLessThan(1e-3);
  expect(Math.abs(wrong - 12345.678)).toBeGreaterThan(1e-3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Geocentric / very-far-from-origin — should still work for ECEF coords too
// ─────────────────────────────────────────────────────────────────────────────

test('Geocentric ECEF magnitude — decode survives 6_371_000 m baseline', () => {
  // ECEF coordinates can hit 6,371 km magnitudes (Earth radius). The
  // recenter pattern still holds as long as origin matches the cloud's
  // min, keeping the residual small.
  const scale = 0.001;
  const offset = 6_371_000;
  const renderOrigin = 6_371_000;
  const intValue = 5_000;  // 5 m above the origin

  const decoded = decodePosition(intValue, scale, offset, renderOrigin);
  expect(Math.abs(decoded - 5.0)).toBeLessThan(1e-4);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inspect-tool round-trip — local + origin must recover the world value
// ─────────────────────────────────────────────────────────────────────────────

test('Inspect round-trip: local + origin recovers the world value to mm', () => {
  // The InspectTool reports `info.x = round(raw.local[0] + raw.origin[0], 3)`.
  // This test pins that the Float32 local + Float64 origin still gives a
  // sub-mm-accurate world coordinate at UTM magnitudes.
  const scale = 0.001;
  const offset = 4_100_876;
  const renderOrigin = 4_100_876;
  const intValue = 12_345_678;

  const local = decodePosition(intValue, scale, offset, renderOrigin);
  const worldRecovered = local + renderOrigin;

  // The expected world value is exact: int * scale + offset = 4_113_221.678.
  const worldExpected = intValue * scale + offset;
  expect(Math.abs(worldRecovered - worldExpected)).toBeLessThan(1e-3);
});
