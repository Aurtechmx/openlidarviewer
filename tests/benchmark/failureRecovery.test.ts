/**
 * failureRecovery.test.ts — what the application reports when its input or its
 * environment fails.
 *
 * The honesty contract this suite exists to test is stated in
 * `benchmarks/framework/types.ts`: a reported quantity is either measured with
 * a stated unit, or unavailable with a stated reason. The defect this suite
 * hunts is the third case — a number that survives a failure and reaches a
 * reader looking like a measurement.
 *
 * So "it did not crash" is never the assertion. Every check below pins the
 * outcome to one of three shapes:
 *
 *   (a) a correct result,
 *   (b) an explicit unavailable, carrying a reason,
 *   (c) a thrown, typed error.
 *
 * PROVING AN INJECTION LANDED. A corruption that never reaches the code under
 * test makes a green check that proves nothing, which is the failure mode of
 * most fault-injection suites. Two devices guard against it here. First, every
 * throw is matched on a message substring unique to ONE guard in `src/`, not on
 * the error class alone — `toThrow(Error)` would pass on an accidental
 * `undefined is not a function`. Second, the clamping and degeneracy checks
 * carry a paired HEALTHY control built by the same fixture function: the
 * control asserts the uncorrupted input produces the full, correct answer, so
 * the corrupted case's different answer is attributable to the injection rather
 * than to a fixture that was broken from the start. `healthy`/`injected` pairs
 * in the same `test()` body are that pattern.
 *
 * WHAT THIS SUITE PINS RATHER THAN FIXES. Two loaders answer a truncated body
 * differently — LAS clamps silently, EPT throws a tagged error — and one CRS
 * path resolves an unrecognised unit code to metres. The divergences are
 * recorded as assertions on the CURRENT behaviour so a later change to either
 * is visible in a diff. Where the current behaviour is a defect it says so at
 * the assertion.
 *
 * NOT COVERABLE HERE, and covered nowhere in Node:
 *   - GPU frame timing, WebGPU device loss, and texture-allocation failure:
 *     browser-only, exercised by `tests/e2e/` under Playwright.
 *   - Worker termination mid-decode (`copcWorkerClient`, `eptLaszipWorkerClient`)
 *     needs a real `Worker`; the decode functions those clients wrap are called
 *     directly here instead, so the decode contract is covered and the transport
 *     is not.
 *   - Real network failure (`HttpRangeSource`) needs a socket. The abort and
 *     out-of-range paths are covered through `ArrayBufferRangeSource`, which
 *     shares `clampRange` with the HTTP source.
 *   - Genuine heap exhaustion cannot be provoked deterministically. The
 *     allocation GUARD that stands in front of it is exercised instead.
 */

import { describe, test, expect } from 'vitest';

import { parseLasHeader } from '../../src/io/lasHeader';
import { loadLas } from '../../src/io/loadLas';
import { parseBuffer } from '../../src/io/parseBuffer';
import { LoadError, describeLoadError, classifyLoadError } from '../../src/io/loadErrors';
import { validateDeclaredPointCount } from '../../src/io/validateCount';
import { decodeRecords, type ChunkDecodeMetadata } from '../../src/io/copc/copcChunkDecode';
import {
  decodeEptBinaryTile,
  EptTruncatedTileError,
} from '../../src/io/ept/eptBinaryDecode';
import type { EptSchemaField } from '../../src/io/ept/eptTypes';
import { ArrayBufferRangeSource } from '../../src/io/range/ArrayBufferRangeSource';
import { RangeReadError, clampRange } from '../../src/io/range/RangeSource';
import { crsFromGeoTiff, crsFromWkt, toMetres } from '../../src/io/crs';
import { assertFinitePositions } from '../../src/io/streamingFiniteGuard';

import { validatePolygon } from '../../src/render/measure/polygonHygiene';
import { volumeCutFill } from '../../src/render/measure/volume';
import { spaceMetrics } from '../../src/terrain/spaceMetrics';
import { buildMeasurementRows } from '../../src/report/ReportMeasurementSection';
import { slopeBetween } from '../../src/render/measure/geometry';
import { formatGrade } from '../../src/render/measure/format';
import type { Measurement, Vec3 } from '../../src/render/measure/types';

import { measured, unavailable, isMeasured, isUnavailable } from '../../benchmarks/framework/types';
import { startMemorySampler } from '../../benchmarks/framework/memory';
import { runStage, runStageAsync } from '../../benchmarks/framework/stage';
import { summariseRuns } from '../../benchmarks/runner/summarise';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. Each builder produces a HEALTHY artifact by default and takes the
// corruption as an explicit override, so the control and the injected case come
// off the same code path and cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/** Public-header size and record layout for the LAS 1.2 / PDRF 0 fixture. */
const LAS_HEADER_BYTES = 227;
const PDRF0_RECORD_BYTES = 20;

interface LasFixture {
  /** Points written into the body. Defaults to `declaredCount`. */
  bodyPoints?: number;
  /** Point count the header declares. */
  declaredCount?: number;
  scale?: [number, number, number];
  offset?: [number, number, number];
  min?: [number, number, number];
  max?: [number, number, number];
  recordLength?: number;
  versionMinor?: number;
  signature?: string;
}

/**
 * A LAS 1.2 file with `declaredCount` in the header and `bodyPoints` records
 * after it. Every corruption this suite injects into the LAS path is one
 * changed argument here; with no arguments the file is well-formed and decodes
 * to exactly `declaredCount` points.
 */
function lasFile(fx: LasFixture = {}): ArrayBuffer {
  const declared = fx.declaredCount ?? 100;
  const body = fx.bodyPoints ?? declared;
  const recordLength = fx.recordLength ?? PDRF0_RECORD_BYTES;
  const buf = new ArrayBuffer(LAS_HEADER_BYTES + body * PDRF0_RECORD_BYTES);
  const view = new DataView(buf);

  const signature = fx.signature ?? 'LASF';
  for (let i = 0; i < 4; i++) view.setUint8(i, signature.charCodeAt(i));
  view.setUint8(25, fx.versionMinor ?? 2);
  view.setUint16(94, LAS_HEADER_BYTES, true); // header size
  view.setUint32(96, LAS_HEADER_BYTES, true); // offset to point data
  view.setUint32(100, 0, true); // VLR count
  view.setUint8(104, 0); // PDRF 0
  view.setUint16(105, recordLength, true);
  view.setUint32(107, declared, true);

  const scale = fx.scale ?? [0.01, 0.01, 0.01];
  const offset = fx.offset ?? [0, 0, 0];
  const min = fx.min ?? [0, 0, 0];
  const max = fx.max ?? [10, 10, 10];
  for (let a = 0; a < 3; a++) {
    view.setFloat64(131 + a * 8, scale[a], true);
    view.setFloat64(155 + a * 8, offset[a], true);
  }
  // Bounds are stored MAX-then-MIN per axis.
  view.setFloat64(179, max[0], true); view.setFloat64(187, min[0], true);
  view.setFloat64(195, max[1], true); view.setFloat64(203, min[1], true);
  view.setFloat64(211, max[2], true); view.setFloat64(219, min[2], true);

  // Body: a diagonal ramp of distinct integer coordinates, so a decoded point
  // count is not the only thing distinguishing a full read from a short one.
  for (let i = 0; i < body; i++) {
    const o = LAS_HEADER_BYTES + i * PDRF0_RECORD_BYTES;
    view.setInt32(o, i, true);
    view.setInt32(o + 4, i, true);
    view.setInt32(o + 8, i, true);
  }
  return buf;
}

/** A GeoTIFF GeoKeyDirectory over `[keyId, value]` pairs, tiffTag 0 (inline). */
function geoKeyDirectory(pairs: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const u16 = new Uint16Array(4 + pairs.length * 4);
  u16[0] = 1; u16[1] = 1; u16[2] = 0; u16[3] = pairs.length;
  pairs.forEach(([key, value], i) => {
    const o = 4 + i * 4;
    u16[o] = key; u16[o + 1] = 0; u16[o + 2] = 1; u16[o + 3] = value;
  });
  return new Uint8Array(u16.buffer);
}

/** GeoTIFF GeoKey ids used below. */
const GEOKEY_MODEL_TYPE = 1024;
const GEOKEY_PROJECTED_CRS = 3072;
const GEOKEY_PROJ_LINEAR_UNITS = 3076;
/** EPSG 9095 — British foot (1936). A real code, absent from our unit table. */
const EPSG_UNIT_BRITISH_FOOT_1936 = 9095;

/** COPC PDRF 6 record length, and metadata for a chunk of `pointCount` points. */
const PDRF6_RECORD_BYTES = 30;
function copcChunkMeta(pointCount: number): ChunkDecodeMetadata {
  return {
    pointDataRecordFormat: 6,
    pointRecordLength: PDRF6_RECORD_BYTES,
    pointCount,
    scale: [0.01, 0.01, 0.01],
    offset: [0, 0, 0],
    renderOrigin: [0, 0, 0],
  };
}

/** The minimal EPT binary schema: X/Y/Z as scaled int32. */
const EPT_XYZ_SCHEMA: readonly EptSchemaField[] = [
  { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
  { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
  { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
];
const EPT_XYZ_STRIDE = 12;

/** A measurement record with the given kind and vertices. */
function measurement(kind: string, points: Vec3[]): Measurement {
  return { id: 'm', kind, name: kind, points } as unknown as Measurement;
}

const NODE_METRIC = { runtime: 'node', deterministic: true } as const;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Truncated and clipped bodies — the header promises N, the body holds fewer
// ─────────────────────────────────────────────────────────────────────────────

describe('a body shorter than its header promised', () => {
  test('LAS clamps to what the file holds and keeps the header claim visible beside it', async () => {
    // Control: an intact file decodes every declared point.
    const healthy = await loadLas(lasFile({ declaredCount: 100 }), 'las', 'healthy.las');
    expect(healthy.pointCount).toBe(100);
    expect(healthy.declaredPointCount).toBe(100);
    expect(healthy.decodedPointCount).toBe(100);

    // Injection: same header, 40 records in the body.
    const injected = await loadLas(
      lasFile({ declaredCount: 100, bodyPoints: 40 }),
      'las',
      'short.las',
    );
    // The clamp landed: the decode stopped at the byte-derived count, which the
    // control proves is not what an intact file of this shape produces.
    expect(injected.decodedPointCount).toBe(40);
    expect(injected.pointCount).toBe(40);
    // The header's claim is preserved rather than overwritten with the clamped
    // figure. This is what keeps the clamp honest: `declaredPointCount` and
    // `decodedPointCount` disagree, so the discrepancy is reportable rather
    // than absorbed. A loader that "fixed" the header here would erase the only
    // evidence that 60 points are missing.
    expect(injected.declaredPointCount).toBe(100);
    expect(injected.declaredPointCount).not.toBe(injected.decodedPointCount);
  });

  test('a COPC node chunk clamps a short body the same way, and reports the count it reached', () => {
    const healthy = decodeRecords(
      new Uint8Array(50 * PDRF6_RECORD_BYTES),
      copcChunkMeta(50),
    );
    expect(healthy.pointCount).toBe(50);
    expect(healthy.positions.length).toBe(150);

    // Injection: the hierarchy declared 50 points, the transport delivered 18.
    const injected = decodeRecords(
      new Uint8Array(18 * PDRF6_RECORD_BYTES),
      copcChunkMeta(50),
    );
    expect(injected.pointCount).toBe(18);
    // The arrays are sized to what was decoded, not to what was declared — a
    // padded array would present 32 points at the origin as real returns.
    expect(injected.positions.length).toBe(18 * 3);
    expect(injected.intensity.length).toBe(18);
    expect(injected.classification.length).toBe(18);
  });

  test('an EPT binary tile refuses a short body with a tagged error carrying both byte counts', () => {
    const healthy = decodeEptBinaryTile(
      new ArrayBuffer(50 * EPT_XYZ_STRIDE),
      50,
      EPT_XYZ_SCHEMA,
      [0, 0, 0],
    );
    expect(healthy.pointCount).toBe(50);

    let caught: unknown;
    try {
      decodeEptBinaryTile(new ArrayBuffer(18 * EPT_XYZ_STRIDE), 50, EPT_XYZ_SCHEMA, [0, 0, 0]);
    } catch (err) {
      caught = err;
    }
    // Matched on the class AND on the guard's own wording, so an unrelated
    // throw from anywhere else in the decode cannot satisfy this.
    expect(caught).toBeInstanceOf(EptTruncatedTileError);
    expect((caught as Error).message).toContain('EPT binary tile is short');
    // The tag carries the arithmetic, so a scheduler can decide to re-fetch.
    expect((caught as EptTruncatedTileError).expectedBytes).toBe(50 * EPT_XYZ_STRIDE);
    expect((caught as EptTruncatedTileError).actualBytes).toBe(18 * EPT_XYZ_STRIDE);
  });

  test('the two streaming formats answer the same truncation differently, and both stay honest', () => {
    // Pinned divergence. COPC clamps and reports the reached count; EPT throws.
    // Neither fabricates a point, so both satisfy the contract, but a reader
    // comparing a COPC and an EPT copy of one dataset gets a shorter cloud in
    // one case and a failed node in the other. Recorded so a change to either
    // side shows up in a diff rather than in a report.
    const copc = decodeRecords(new Uint8Array(1 * PDRF6_RECORD_BYTES), copcChunkMeta(9));
    expect(copc.pointCount).toBe(1);
    expect(() =>
      decodeEptBinaryTile(new ArrayBuffer(1 * EPT_XYZ_STRIDE), 9, EPT_XYZ_SCHEMA, [0, 0, 0]),
    ).toThrow(EptTruncatedTileError);
  });

  test('a range read past the end is truncated, and a read starting past the end is refused', async () => {
    const source = new ArrayBufferRangeSource(new ArrayBuffer(1000));
    // Control: a read fully inside the source returns exactly what was asked.
    expect((await source.readRange(0, 400)).byteLength).toBe(400);
    // Injection: the file is shorter than the caller believes.
    expect((await source.readRange(900, 400)).byteLength).toBe(100);
    // An offset entirely past the end is not silently an empty buffer. Note the
    // shape: `RangeSource` documents this as a rejection, but the in-memory
    // implementation validates before it builds the promise, so it THROWS
    // synchronously. Both are typed refusals and neither returns bytes, so the
    // contract holds; pinned because a caller written against the documented
    // rejection would miss this one with `await ... .catch()`.
    expect(() => source.readRange(1200, 10)).toThrow(RangeReadError);
    expect(() => clampRange(1200, 10, 1000)).toThrow(/past the source size/);
    expect(() => clampRange(Number.NaN, 10, 1000)).toThrow(/Invalid range request/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Corrupt headers and impossible values
// ─────────────────────────────────────────────────────────────────────────────

describe('a header that cannot be believed', () => {
  test('the control fixture parses, so every rejection below is caused by its own injection', () => {
    const header = parseLasHeader(lasFile());
    expect(header.pointCount).toBe(100);
    expect(header.scale).toEqual([0.01, 0.01, 0.01]);
    expect(header.min).toEqual([0, 0, 0]);
    expect(header.max).toEqual([10, 10, 10]);
  });

  test('a wrong signature and a buffer too small for a header are each named precisely', () => {
    expect(() => parseLasHeader(lasFile({ signature: 'XXXX' }))).toThrow(
      /expected signature "LASF"/,
    );
    expect(() => parseLasHeader(new ArrayBuffer(64))).toThrow(/too small to contain a header/);
    // LAS 1.4 reads a uint64 count at byte 247, past the 1.2 header end.
    expect(() => parseLasHeader(lasFile({ versionMinor: 4, bodyPoints: 0 }))).toThrow(
      /LAS 1\.4 file: the header is truncated/,
    );
  });

  test('a scale factor that is zero, negative or non-finite is a typed refusal, not a NaN cloud', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        parseLasHeader(lasFile({ scale: [bad, 0.01, 0.01] }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoadError);
      expect((caught as LoadError).category).toBe('malformed-file');
      expect((caught as Error).message).toBe('LAS header scale factor is invalid.');
    }
  });

  test('a non-finite offset or bound is refused before it can poison the origin', () => {
    let caught: unknown;
    try {
      parseLasHeader(lasFile({ offset: [Number.NaN, 0, 0] }));
    } catch (err) {
      caught = err;
    }
    expect((caught as LoadError).message).toBe('LAS header offset is invalid.');
    expect((caught as LoadError).category).toBe('malformed-file');

    try {
      caught = undefined;
      parseLasHeader(lasFile({ min: [Number.NEGATIVE_INFINITY, 0, 0] }));
    } catch (err) {
      caught = err;
    }
    expect((caught as LoadError).message).toBe('LAS header bounds are invalid.');
  });

  test('inverted and zero-extent bounds are carried through as written, not silently repaired', () => {
    // PINNED, not endorsed. The parser's finiteness guard passes an inverted
    // box (min > max) and a zero-extent box, because the decoded points — not
    // the declared box — are what the viewer frames and measures. Recorded here
    // so a later "fix" that swaps or widens the bounds is visible: silently
    // repairing a header would make the file's own declaration unrecoverable.
    const inverted = parseLasHeader(lasFile({ min: [10, 10, 10], max: [0, 0, 0] }));
    expect(inverted.min).toEqual([10, 10, 10]);
    expect(inverted.max).toEqual([0, 0, 0]);
    expect(inverted.min[0]).toBeGreaterThan(inverted.max[0]);

    const flat = parseLasHeader(lasFile({ min: [5, 5, 5], max: [5, 5, 5] }));
    expect(flat.max[2] - flat.min[2]).toBe(0);
  });

  test('a zero point-record length yields no points and a refusal, never a fabricated cloud', async () => {
    // A record length of 0 makes the byte-derived available count 0, so the
    // decode produces nothing. The value of the check is what happens NEXT: the
    // empty cloud is refused at the parse choke point rather than reaching the
    // renderer as a scan with no points.
    const cloud = await loadLas(lasFile({ recordLength: 0 }), 'las', 'zero-record.las');
    expect(cloud.pointCount).toBe(0);
    expect(cloud.declaredPointCount).toBe(100);

    let caught: unknown;
    try {
      await parseBuffer(lasFile({ recordLength: 0 }), 'las', 'zero-record.las');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadError);
    expect((caught as LoadError).category).toBe('malformed-file');
    // PINNED: the message describes the SYMPTOM (an empty file) rather than the
    // cause (a record length of zero), because `pointDataRecordLength` is never
    // validated in `parseLasHeader`. A reader is told the file is empty when it
    // is in fact structurally corrupt. No number is fabricated, so the contract
    // holds; the diagnosis is what is lost.
    expect((caught as Error).message).toContain('empty');
  });

  test('a declared count the bytes cannot support is refused, and the message survives a worker hop', () => {
    // Control: a plausible count passes through unchanged.
    expect(validateDeclaredPointCount(1000, 20_000, 1, 'LAZ file')).toBe(1000);
    // Boundary: exactly what the bytes allow is still plausible; one more is not.
    expect(validateDeclaredPointCount(20_000, 20_000, 1, 'LAZ file')).toBe(20_000);
    expect(() => validateDeclaredPointCount(20_001, 20_000, 1, 'LAZ file')).toThrow(LoadError);

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => validateDeclaredPointCount(bad, 20_000, 1, 'LAZ file')).toThrow(
        /invalid declared point count/,
      );
    }

    // A header claiming 10^12 points is what the guard exists for.
    let caught: unknown;
    try {
      validateDeclaredPointCount(1e12, 4096, 1, 'COPC node');
    } catch (err) {
      caught = err;
    }
    expect((caught as LoadError).category).toBe('malformed-file');
    // Workers post `error.message` across the thread boundary and the category
    // is recovered from the text. Assert the round trip, not just the class:
    // this is the only thing keeping the toast accurate off the main thread.
    expect(classifyLoadError((caught as Error).message)).toBe('malformed-file');
    expect(describeLoadError(new Error((caught as Error).message))).toBe(
      'This file could not be read — it may be malformed or incomplete.',
    );
  });

  test('a non-finite decoded position is named with its index rather than shipped', () => {
    const healthy = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(() => assertFinitePositions(healthy)).not.toThrow();

    const injected = new Float32Array([1, 2, 3, 4, Number.NaN, 6]);
    expect(() => assertFinitePositions(injected)).toThrow(/1/);
    let caught: unknown;
    try {
      assertFinitePositions(injected);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Empty and degenerate geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('input with no geometry left to measure', () => {
  test('a zero-point file is refused at the single funnel every loader passes through', async () => {
    let caught: unknown;
    try {
      await parseBuffer(lasFile({ declaredCount: 0, bodyPoints: 0 }), 'las', 'empty.las');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadError);
    expect((caught as LoadError).category).toBe('malformed-file');
    expect((caught as Error).message).toContain('no points to display');
  });

  test('every degenerate polygon gets its own tag, so an empty result states which degeneracy', () => {
    // Control: a unit square is measured, and the area is the real one.
    const healthy = validatePolygon([
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    ]);
    expect(healthy.validity).toBe('ok');
    expect(healthy.absoluteArea).toBe(16);

    // Each injection produces a DISTINCT tag. A single 'invalid' tag would let
    // "you drew a bow-tie" and "your points are NaN" reach the same message.
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]).validity).toBe('too-few-vertices');
    expect(
      validatePolygon([{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 1, y: 1 }]).validity,
    ).toBe('non-finite-vertex');
    // Collinear — three points on one line enclose nothing.
    const collinear = validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
    expect(collinear.validity).toBe('zero-area');
    expect(collinear.absoluteArea).toBe(0);
    // All-identical — the whole ring collapses to one point. It reaches the
    // area check before the bounding-box check, so it is tagged 'zero-area'
    // too. `degenerate-bbox` is therefore unreachable from here: any ring with
    // a zero-width or zero-height box already has zero area. Pinned so a
    // reordering of the checks, which would change what the inspector says
    // about a collapsed footprint, shows up as a failure.
    const identical = validatePolygon([{ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }]);
    expect(identical.validity).toBe('zero-area');
    expect(identical.bboxWidth).toBe(0);
    expect(identical.bboxHeight).toBe(0);
    // Self-intersecting — a bow-tie has a finite shoelace area that is not the
    // area of anything a reader would recognise, which is why it is refused
    // rather than reported.
    expect(
      validatePolygon([
        { x: 0, y: 0 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 4 },
      ]).validity,
    ).toBe('self-intersecting');
  });

  test('a cut/fill volume over a degenerate footprint returns zeros WITH the reason attached', () => {
    const positions = new Float32Array([1, 1, 5, 2, 2, 7, 3, 1, 6]);

    const healthy = volumeCutFill({
      polygon: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]] as Vec3[],
      referenceZ: 0,
      positions,
    });
    expect(healthy.validity).toBe('ok');
    expect(healthy.footprintArea).toBe(16);
    expect(healthy.pointsInPolygon).toBeGreaterThan(0);
    expect(healthy.fill).toBeGreaterThan(0);

    // Injection: the same points, a collapsed polygon.
    const injected = volumeCutFill({
      polygon: [[0, 0, 0], [1, 1, 0], [2, 2, 0]] as Vec3[],
      referenceZ: 0,
      positions,
    });
    // The zeros are only defensible because the tag travels with them. Assert
    // the tag, not the zeros: a zero fill with `validity: 'ok'` would be a
    // measured claim that the site is already at grade.
    expect(injected.validity).not.toBe('ok');
    expect(injected.fill).toBe(0);
    expect(injected.cut).toBe(0);
    expect(injected.pointsInPolygon).toBe(0);

    // Injection: a valid polygon with no points inside it.
    const noSamples = volumeCutFill({
      polygon: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]] as Vec3[],
      referenceZ: 0,
      positions: new Float32Array(0),
    });
    expect(noSamples.sampleCount).toBe(0);
    expect(noSamples.pointsInPolygon).toBe(0);
    expect(noSamples.net).toBe(0);
  });

  test('a space too small, collinear or collapsed to measure says so instead of returning dimensions', () => {
    // Control: a filled box of points yields real dimensions.
    const box: number[] = [];
    for (let i = 0; i < 400; i++) {
      box.push((i % 10) * 0.5, (Math.floor(i / 10) % 10) * 0.5, (i % 7) * 0.4);
    }
    const healthy = spaceMetrics(new Float32Array(box), {
      upAxis: 'z',
      spaceKind: 'interior',
    });
    expect(healthy.dims.lengthM).toBeGreaterThan(0);
    expect(healthy.dims.widthM).toBeGreaterThan(0);
    expect(healthy.dims.heightM).toBeGreaterThan(0);

    const tooFewReason = 'Too few points to measure this space yet.';

    // Injection A: below the minimum sample count.
    const tooFew = spaceMetrics(new Float32Array([0, 0, 0, 1, 1, 1]), {
      upAxis: 'z',
      spaceKind: 'interior',
    });
    expect(tooFew.reasons).toContain(tooFewReason);
    expect(tooFew.ceilingHeightM).toBeNull();
    expect(tooFew.enclosedVolumeM3).toBeNull();

    // Injection B: enough points, every one non-finite. The count gate alone
    // would pass this; the reason proves the finiteness filter is what caught it.
    const allNaN = new Float32Array(120).fill(Number.NaN);
    const nonFinite = spaceMetrics(allNaN, { upAxis: 'z', spaceKind: 'interior' });
    expect(nonFinite.reasons).toContain(tooFewReason);
    expect(nonFinite.ceilingHeightM).toBeNull();
    expect(nonFinite.enclosedVolumeM3).toBeNull();
    expect(nonFinite.dims.widthM).toBe(0);

    // PINNED: `floorAreaM2` is a plain `0` on the too-few path, with no null
    // variant in the type. A reader who takes the field alone cannot tell "the
    // footprint measured zero" from "no footprint was measured". The reasons
    // array is the only thing carrying that distinction, so the two must be
    // read together — asserted here so a caller that drops the reasons is a
    // visible change.
    expect(tooFew.floorAreaM2).toBe(0);
    expect(tooFew.reasons.length).toBeGreaterThan(0);
  });

  test('DEFECT: a zero-extent cloud is reported as 1 m² of floor at 40 points per m²', () => {
    // 40 points, all at exactly the same coordinate. There is no space here:
    // no length, no width, no height, and no spacing between any two points.
    const collapsed = spaceMetrics(new Float32Array(120).fill(2), {
      upAxis: 'z',
      spaceKind: 'interior',
    });

    // The module knows how to refuse, and does so for three fields.
    expect(collapsed.dims).toEqual({ lengthM: 0, widthM: 0, heightM: 0 });
    expect(collapsed.ceilingHeightM).toBeNull();
    expect(collapsed.enclosedVolumeM3).toBeNull();

    // These three are the defect. The occupancy grid falls back to a 1-metre
    // cell when an axis has no extent, and that placeholder is then multiplied
    // out as if it were a measured cell size. One occupied cell becomes one
    // square metre of floor, and the density and spacing are derived from it.
    expect(collapsed.floorAreaM2).toBe(1); // should be 0
    expect(collapsed.quality.densityPerM2).toBe(40); // should be 0
    expect(collapsed.quality.meanSpacingM).toBeCloseTo(0.158, 3); // should be 0

    // Nothing in the reasons mentions the degeneracy, so the three numbers
    // above reach a reader with no caveat attached to them. The reasons that
    // are present are the module's standing caveats, which every scan gets.
    expect(collapsed.reasons.join(' ')).not.toMatch(/degenerate|no extent|zero/i);
  });

  test('DEFECT: a collinear cloud is reported as having floor area, from a zero-width footprint', () => {
    // 60 points along a single line: extent in one horizontal axis, none in the
    // other. A line encloses no area.
    const line: number[] = [];
    for (let i = 0; i < 60; i++) line.push(i * 0.1, 0, 0);
    const collinear = spaceMetrics(new Float32Array(line), {
      upAxis: 'z',
      spaceKind: 'interior',
    });

    expect(collinear.dims.widthM).toBe(0);
    expect(collinear.enclosedVolumeM3).toBeNull();

    // The same 1-metre placeholder cell, applied to the axis with no extent:
    // the reported floor area is the LENGTH of the line multiplied by a metre.
    expect(collinear.floorAreaM2).toBeCloseTo(collinear.dims.lengthM, 5);
    expect(collinear.floorAreaM2).toBeGreaterThan(5); // should be 0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Missing and contradictory CRS
// ─────────────────────────────────────────────────────────────────────────────

describe('a coordinate reference system that is absent or unresolvable', () => {
  test('a file with no CRS leaves the value untouched rather than declaring it metres', () => {
    // `toMetres` with no CRS is a pass-through. That is correct arithmetic and
    // an honest one ONLY while the caller knows the CRS is null; the function
    // itself cannot refuse. The gate is the separate `linearUnit` tag.
    expect(toMetres(42, null)).toBe(42);
  });

  test('an unrecognised WKT unit is tagged unknown, and the factor beside it is a no-op not a claim', () => {
    const healthy = crsFromWkt(
      'PROJCS["NAD83 / UTM 11N",UNIT["metre",1],AUTHORITY["EPSG","26911"]]',
    );
    expect(healthy.linearUnit).toBe('metre');
    expect(healthy.linearUnitToMetres).toBe(1);

    const feet = crsFromWkt(
      'PROJCS["State Plane","UNIT_PLACEHOLDER",UNIT["US survey foot",0.30480060960121924],' +
        'AUTHORITY["EPSG","2229"]]',
    );
    expect(feet.linearUnit).toBe('us-survey-foot');
    expect(feet.linearUnitToMetres).toBeCloseTo(1200 / 3937, 12);

    // Injection A: a unit whose NAME we cannot classify, declared with its own
    // scale. The name is unresolvable, so the tag is 'unknown' — but the
    // declared scale is kept and used, so the conversion is still right. This
    // is the good shape: refuse to NAME what you cannot name, without throwing
    // away what the file did state.
    const namedUnknown = crsFromWkt(
      'PROJCS["Local grid",UNIT["chain",20.1168],AUTHORITY["EPSG","0"]]',
    );
    expect(namedUnknown.linearUnit).toBe('unknown');
    expect(namedUnknown.linearUnitToMetres).toBe(20.1168);
    expect(toMetres(100, namedUnknown)).toBeCloseTo(2011.68, 6);

    // Injection B: a projected CRS that states no UNIT at all. The file has
    // declared nothing, so the format's own default applies and the CRS is
    // metres. This is the case that MUST stay distinct from a file that does
    // declare a unit we cannot resolve — see the GeoTIFF defect below.
    const noUnit = crsFromWkt('PROJCS["Local grid",AUTHORITY["EPSG","0"]]');
    expect(noUnit.linearUnit).toBe('metre');
    expect(noUnit.linearUnitToMetres).toBe(1);
    expect(toMetres(100, noUnit)).toBe(100);
  });

  test('a truncated GeoTIFF projection record says the CRS is unknown and names the truncation', () => {
    const healthy = crsFromGeoTiff(
      geoKeyDirectory([[GEOKEY_MODEL_TYPE, 1], [GEOKEY_PROJECTED_CRS, 32612], [GEOKEY_PROJ_LINEAR_UNITS, 9001]]),
      null,
      null,
    );
    expect(healthy.epsg).toBe(32612);
    expect(healthy.linearUnit).toBe('metre');

    // Injection A: fewer bytes than the 8-byte directory header.
    const shortHeader = crsFromGeoTiff(new Uint8Array(4), null, null);
    expect(shortHeader.linearUnit).toBe('unknown');
    expect(shortHeader.name).toContain('truncated GeoTIFF VLR');
    expect(shortHeader.epsg).toBeUndefined();

    // Injection B: a header declaring more keys than the record carries.
    const full = geoKeyDirectory([[GEOKEY_MODEL_TYPE, 1], [GEOKEY_PROJECTED_CRS, 32612]]);
    const shortKeys = full.slice(0, full.byteLength - 6);
    const truncated = crsFromGeoTiff(shortKeys, null, null);
    expect(truncated.linearUnit).toBe('unknown');
    expect(truncated.name).toContain('truncated GeoTIFF keys');
    // The EPSG is not read from the surviving bytes — a half-read directory
    // yields no CRS at all rather than a partially-recovered one.
    expect(truncated.epsg).toBeUndefined();
  });

  test('a vertical unit the file does not state is left undefined, never defaulted to metres', () => {
    // The Z axis is the honest half of the CRS parser: an unstated vertical
    // unit is `undefined`, so a caller must fall back explicitly and can label
    // the fallback. Contrast with the horizontal axis above, where the
    // unknown case still carries a numeric 1.
    const noVertical = crsFromGeoTiff(
      geoKeyDirectory([[GEOKEY_MODEL_TYPE, 1], [GEOKEY_PROJECTED_CRS, 32612], [GEOKEY_PROJ_LINEAR_UNITS, 9001]]),
      null,
      null,
    );
    expect(noVertical.verticalUnitToMetres).toBeUndefined();
    expect(noVertical.verticalLinearUnit).toBeUndefined();

    // A vertical unit code we do not map is also left undefined rather than
    // resolved to the horizontal unit.
    const unmappedVertical = crsFromGeoTiff(
      geoKeyDirectory([
        [GEOKEY_MODEL_TYPE, 1],
        [GEOKEY_PROJECTED_CRS, 32612],
        [GEOKEY_PROJ_LINEAR_UNITS, 9001],
        [4099, EPSG_UNIT_BRITISH_FOOT_1936],
      ]),
      null,
      null,
    );
    expect(unmappedVertical.verticalUnitToMetres).toBeUndefined();
  });

  test('DEFECT: a projected CRS that declares a unit code we cannot resolve is reported as metres', () => {
    // The file states ProjLinearUnitsGeoKey = 9095, EPSG's British foot (1936),
    // 0.3048007 m. It is a real, valid declaration; our table maps only
    // 9001/9002/9003. The unmapped code falls through to the projected default.
    //
    // The declared unit is DIFFERENT from the absent case, and the two must not
    // resolve alike: absent means "the GeoTIFF default applies", present-and-
    // unresolvable means "this file says something we cannot honour". The
    // second is the one that must refuse.
    const declaredUnknownUnit = crsFromGeoTiff(
      geoKeyDirectory([
        [GEOKEY_MODEL_TYPE, 1],
        [GEOKEY_PROJECTED_CRS, 27700],
        [GEOKEY_PROJ_LINEAR_UNITS, EPSG_UNIT_BRITISH_FOOT_1936],
      ]),
      null,
      null,
    );

    // Pinned defect. `linearUnit` should be 'unknown' so downstream gates
    // (`linearUnit !== 'unknown'`) refuse to label the result; instead every
    // length from this file is presented in metres and is wrong by 3.28×.
    expect(declaredUnknownUnit.linearUnit).toBe('metre');
    expect(declaredUnknownUnit.linearUnitToMetres).toBe(1);
    expect(toMetres(100, declaredUnknownUnit)).toBe(100); // truth: ~30.48 m

    // A file that declares NO unit at all resolves identically, which is what
    // makes the defect invisible to a caller: the two cases are indistinguishable.
    const noUnitDeclared = crsFromGeoTiff(
      geoKeyDirectory([[GEOKEY_MODEL_TYPE, 1], [GEOKEY_PROJECTED_CRS, 27700]]),
      null,
      null,
    );
    expect(noUnitDeclared.linearUnit).toBe(declaredUnknownUnit.linearUnit);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Aborted and interrupted work
// ─────────────────────────────────────────────────────────────────────────────

describe('work that stops before it finishes', () => {
  test('a cancelled range read rejects with the abort code, not with a short buffer', async () => {
    const source = new ArrayBufferRangeSource(new ArrayBuffer(1000));
    const controller = new AbortController();

    // Control: the same read succeeds while the signal is live.
    expect((await source.readRange(0, 100, controller.signal)).byteLength).toBe(100);

    controller.abort();
    let caught: unknown;
    try {
      await source.readRange(0, 100, controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeReadError);
    // The code distinguishes "the user navigated away" from "the server broke",
    // which is the difference between a silent retry and an error toast.
    expect((caught as RangeReadError).code).toBe('aborted');
  });

  test('a stage that throws is recorded as failed with its message, and still reports its cost', () => {
    const healthy = runStage('decode', () => 7);
    expect(healthy.stage.status).toBe('ok');
    expect(healthy.value).toBe(7);

    const injected = runStage('decode', (): number => {
      throw new Error('injected decode abort\nsecond line');
    });
    expect(injected.stage.status).toBe('failed');
    expect(injected.value).toBeUndefined();
    // The message survives, flattened to one line so it cannot break the report
    // table apart mid-row.
    expect(injected.stage.status === 'failed' && injected.stage.error).toBe(
      'injected decode abort; second line',
    );
    // The duration is still a measured metric: a stage that died after real
    // work tells a reader something, and a blank row does not.
    expect(isMeasured(injected.stage.duration)).toBe(true);
  });

  test('an async stage that rejects mid-transfer never rejects out of the harness', async () => {
    const injected = await runStageAsync('stream', async () => {
      await Promise.resolve();
      throw new Error('connection reset mid-transfer');
    });
    expect(injected.stage.status).toBe('failed');
    expect(injected.stage.status === 'failed' && injected.stage.error).toContain(
      'connection reset mid-transfer',
    );
    expect(injected.value).toBeUndefined();
  });

  test('a series missing from one run is not summarised over the runs that had it', () => {
    const healthy = summariseRuns(
      [
        { values: { analysisMs: 10 }, unavailable: {} },
        { values: { analysisMs: 12 }, unavailable: {} },
      ],
      2,
    );
    expect(healthy.available.map((b) => b.key)).toEqual(['analysisMs']);
    expect(healthy.unavailable).toEqual([]);

    // Injection: the second run aborted before producing the series.
    const injected = summariseRuns(
      [
        { values: { analysisMs: 10 }, unavailable: {} },
        { values: {}, unavailable: { analysisMs: 'the stage failed' } },
      ],
      2,
    );
    // No median is published over the one surviving run. A median over an
    // unstated subset looks like the number a reader asked for and answers a
    // different question.
    expect(injected.available).toEqual([]);
    expect(injected.unavailable).toHaveLength(1);
    expect(injected.unavailable[0].key).toBe('analysisMs');
    expect(injected.unavailable[0].reason).toContain('only 1 of 2 runs');
    expect(injected.unavailable[0].reason).toContain('the stage failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Instrumentation that cannot read its counter
// ─────────────────────────────────────────────────────────────────────────────

describe('a measurement the runtime cannot supply', () => {
  test('an RSS reader that is absent or throws yields unavailable-with-reason, never zero bytes', () => {
    const healthy = startMemorySampler({ readRss: () => 4096, intervalMs: 0 }).stop();
    expect(isMeasured(healthy)).toBe(true);
    expect(healthy.value).toBe(4096);
    expect(healthy.unit).toBe('bytes');

    // Injection A: the runtime has no RSS counter.
    const absent = startMemorySampler({ readRss: () => null, intervalMs: 0 }).stop();
    expect(isUnavailable(absent)).toBe(true);
    expect(absent.value).toBeNull();
    expect(absent.reason).toContain('peak RSS not readable');

    // Injection B: the counter throws — a locked sandbox refusing the call.
    // The stage must not fail because its instrumentation did.
    const throwing = startMemorySampler({
      readRss: () => {
        throw new Error('sandbox denied memoryUsage');
      },
      intervalMs: 0,
    }).stop();
    expect(isUnavailable(throwing)).toBe(true);
    expect(throwing.value).toBeNull();

    // Injection C: the counter returns a poison value. NaN serialises to JSON
    // `null`, which under status 'measured' is the exact contradiction the
    // schema exists to prevent — so it must be treated as no reading at all.
    const poison = startMemorySampler({ readRss: () => Number.NaN, intervalMs: 0 }).stop();
    expect(isUnavailable(poison)).toBe(true);
  });

  test('the metric constructors refuse to build a measurement out of a non-value', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => measured(bad, 'ms', NODE_METRIC)).toThrow(/must be finite/);
    }
    // A bare number is not a measurement.
    expect(() => measured(12, '', NODE_METRIC)).toThrow(/unit must not be empty/);
    expect(() => measured(12, '   ', NODE_METRIC)).toThrow(/unit must not be empty/);
    // "Unavailable" with no reason tells a reviewer nothing.
    expect(() => unavailable('', NODE_METRIC)).toThrow(/needs a reason/);
    expect(() => unavailable('   ', NODE_METRIC)).toThrow(/needs a reason/);

    // And the shapes are mutually exclusive: a measured metric carries no
    // reason, an unavailable one carries no unit and a null value.
    const m = measured(12, 'ms', NODE_METRIC);
    expect(m.reason).toBeUndefined();
    const u = unavailable('the stage did not run', NODE_METRIC);
    expect(u.unit).toBeUndefined();
    expect(u.value).toBeNull();
    // JSON is the form a reader actually receives; the contradiction must not
    // reappear after serialisation.
    expect(JSON.parse(JSON.stringify(u))).toEqual({
      status: 'unavailable',
      value: null,
      reason: 'the stage did not run',
      runtime: 'node',
      deterministic: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The reported quantity itself
//
// The checks above establish that a failure is caught. These establish what a
// READER is shown afterwards — the last seam, where a caught failure can still
// turn back into a printed number.
// ─────────────────────────────────────────────────────────────────────────────

describe('what the measurement report prints when the geometry is degenerate', () => {
  test('an intact measurement set is the control: real values, correctly scaled', () => {
    const rows = buildMeasurementRows(
      [measurement('distance', [[0, 0, 0], [3, 4, 0]])],
      'metric',
    );
    expect(rows[0].value).toBe('5.00 m');
    // A foot-CRS scan converts exactly once at this boundary.
    const feet = buildMeasurementRows(
      [measurement('distance', [[0, 0, 0], [3, 4, 0]])],
      'metric',
      0.3048,
    );
    expect(feet[0].value).toBe('1.52 m');
  });

  test('a measurement with too few vertices refuses rather than reporting a zero', () => {
    const rows = buildMeasurementRows(
      [
        measurement('distance', [[0, 0, 0]]),
        measurement('height', [[0, 0, 0]]),
        measurement('angle', [[0, 0, 0], [1, 1, 1]]),
        measurement('slope', [[0, 0, 0]]),
        measurement('profile', [[0, 0, 0]]),
      ],
      'metric',
    );
    expect(rows.map((r) => r.value)).toEqual(['—', '—', '—', '—', '—']);
  });

  test('DEFECT: a vertical slope prints 0.00% in the report while the live tool says "vertical"', () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 10];

    // The live measurement path. A zero horizontal run has no grade, so the
    // grade is ±Infinity and the formatter renders the word.
    expect(slopeBetween(a, b, [0, 0, 1]).gradePercent).toBe(Number.POSITIVE_INFINITY);
    expect(formatGrade(slopeBetween(a, b, [0, 0, 1]).gradePercent)).toBe('vertical');

    // The report path, for the same two points. `slopePercent` returns 0 for a
    // zero run, so the PDF states a level grade for a vertical face — a number
    // presented as measured, contradicting the tool that produced it, in the
    // artifact a reader keeps. `ReportMeasurementSection`'s own header says the
    // numbers track the live overlay's headline formula; here they do not.
    const rows = buildMeasurementRows([measurement('slope', [a, b])], 'metric');
    expect(rows[0].value).toBe('0.00%'); // should be 'vertical'
  });

  test('DEFECT: a non-finite length prints "NaN cm" and "Infinity km" instead of refusing', () => {
    const rows = buildMeasurementRows(
      [
        measurement('distance', [[0, 0, 0], [Number.NaN, 0, 0]]),
        measurement('distance', [[0, 0, 0], [Number.POSITIVE_INFINITY, 0, 0]]),
        measurement('polyline', [[0, 0, 0], [Number.NaN, 0, 0]]),
        measurement('height', [[0, 0, 0], [0, 0, Number.NaN]]),
      ],
      'metric',
    );
    // `formatLinear` in this module has no finiteness guard, unlike its
    // neighbour `formatVolume` and unlike `format.ts`'s `formatLength`, both of
    // which return '—'. Every row below should be '—'.
    expect(rows.map((r) => r.value)).toEqual(['NaN cm', 'Infinity km', 'NaN cm', 'NaN cm']);

    // The volume formatter in the same file is the counter-example that shows
    // the fix is a one-line consistency correction, not a design change.
    const volumeRow = buildMeasurementRows(
      [measurement('box', [[0, 0, 0], [Number.NaN, 1, 1]])],
      'metric',
    );
    expect(volumeRow[0].value).toBe('—');
  });
});
