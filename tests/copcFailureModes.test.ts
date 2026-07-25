/**
 * copcFailureModes.test.ts
 *
 * Corrupt-input regression tests for the COPC pipeline (stable hardening #68).
 * Every failure mode a truncated or malformed COPC file can trigger must
 * surface as a STRUCTURED, human-readable error — a typed `LoadError` (or a
 * collected hierarchy-page error string) that names COPC, the hierarchy, or
 * truncation — never a raw TypeError, an Emscripten abort value, or a silently
 * clamped read that fails somewhere far downstream.
 *
 * All inputs are SMALL synthesized in-memory buffers: the synthetic COPC
 * fixture builder plus targeted byte corruption. No large fixtures, no
 * network. House pattern: streamingFiniteGuard.test.ts.
 */

import { test, expect } from 'vitest';
import { detectCopc } from '../src/io/copc/copcDetect';
import { parseCopcMetadata } from '../src/io/copc/copcHeader';
import { parseHierarchyPage, HIERARCHY_ENTRY_SIZE } from '../src/io/copc/copcHierarchy';
import { decompressChunk } from '../src/io/copc/copcChunkDecompress';
import { CopcSource } from '../src/io/copc/CopcSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { LoadError } from '../src/io/loadErrors';
import { getLazPerf } from '../src/io/loadLas';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { ChunkDecodeMetadata } from '../src/io/copc/copcChunkDecode';
import type { OctreeCube } from '../src/io/copc/copcTypes';

// ── Helpers ──────────────────────────────────────────────────────────────────

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

/**
 * A surfaced failure must be an Error whose message reads like a diagnosis of
 * the file, not like a crash: no "undefined", no "NaN", no property-access
 * TypeError text, no raw Emscripten abort — and it must name what went wrong
 * (COPC / the hierarchy / truncation / the LAS header).
 */
function expectStructured(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message.length).toBeGreaterThan(10);
  expect(message).not.toMatch(/undefined|Cannot read propert|\[object |Exception catching/);
  expect(message).not.toMatch(/\bNaN\b/);
  expect(message).toMatch(/COPC|hierarch|truncat|LAS/i);
}

const CHUNK_META = (over: Partial<ChunkDecodeMetadata> = {}): ChunkDecodeMetadata => ({
  pointDataRecordFormat: 6,
  pointRecordLength: 30,
  pointCount: 10,
  scale: [0.01, 0.01, 0.01],
  offset: [0, 0, 0],
  renderOrigin: [0, 0, 0],
  ...over,
});

// ── Empty (0-byte) input ─────────────────────────────────────────────────────

test('a 0-byte input is refused with a readable reason at every entry point', async () => {
  const d = detectCopc(new ArrayBuffer(0));
  expect(d.isCopc).toBe(false);
  expect(d.reason).toMatch(/too short/);

  const err = await rejection(
    CopcSource.open(new ArrayBufferRangeSource(new ArrayBuffer(0), 'empty.copc.laz')),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('unsupported-format');
});

// ── Truncated file (header cut mid-struct) ───────────────────────────────────

test('a header slice cut mid-struct is refused, never mis-parsed', () => {
  const whole = buildSyntheticCopc();
  // Cuts inside the LAS public header, inside the COPC info VLR header, and
  // one byte short of the minimum — every one must throw the typed error.
  for (const cut of [96, 200, 374, 430, 588]) {
    const err = caught(() => parseCopcMetadata(whole.buffer.slice(0, cut)));
    expectStructured(err);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
  }
});

test('CopcSource.open refuses a file truncated inside the header', async () => {
  const truncated = buildSyntheticCopc({ corrupt: 'truncated-file' });
  const err = await rejection(
    CopcSource.open(new ArrayBufferRangeSource(truncated.buffer, 'cut.copc.laz')),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
});

// ── Valid LAS header, missing or malformed COPC info VLR ─────────────────────

test('a valid LAS header without the COPC info VLR is refused as plain LAZ', async () => {
  const fixture = buildSyntheticCopc({ corrupt: 'no-copc-vlr' });
  const err = await rejection(
    CopcSource.open(new ArrayBufferRangeSource(fixture.buffer, 'plain.laz')),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('unsupported-format');
  expect((err as Error).message).toMatch(/plain LAZ/);
});

test('a corrupt COPC info VLR is refused field-by-field with a named reason', () => {
  // Payload layout at 429: center(24) halfsize@453 spacing@461
  // rootHierOffset@469 rootHierSize@477.
  const cases: Array<{ label: RegExp; corrupt: (view: DataView) => void }> = [
    { label: /half-size/, corrupt: (v) => v.setFloat64(453, 0, true) },
    { label: /spacing/, corrupt: (v) => v.setFloat64(461, NaN, true) },
    { label: /hierarchy/, corrupt: (v) => v.setBigUint64(469, 0n, true) },
    // A hierarchy size that is not a multiple of the 32-byte entry size.
    { label: /hierarchy/, corrupt: (v) => v.setBigUint64(477, 33n, true) },
  ];
  for (const c of cases) {
    const fixture = buildSyntheticCopc();
    c.corrupt(new DataView(fixture.buffer));
    const err = caught(() => parseCopcMetadata(fixture.buffer));
    expectStructured(err);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as Error).message).toMatch(c.label);
  }
});

// ── Hierarchy pointing past EOF (truncated node range) ───────────────────────

test('a root hierarchy that runs past EOF is refused as truncated at open', async () => {
  const fixture = buildSyntheticCopc({ corrupt: 'oversized-root-hier' });
  const err = await rejection(
    CopcSource.open(new ArrayBufferRangeSource(fixture.buffer, 'oversized.copc.laz')),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
  expect((err as Error).message).toMatch(/hierarchy/i);
});

test('a hierarchy entry whose chunk offset points past EOF is refused at read', async () => {
  const fixture = buildSyntheticCopc({ nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }] });
  const view = new DataView(fixture.buffer);
  // Entry layout: key(16) offset(u64)@+16 byteSize(i32)@+24 count(i32)@+28.
  view.setBigUint64(
    fixture.rootHierOffset + 16,
    BigInt(fixture.buffer.byteLength + 4096),
    true,
  );
  const source = await CopcSource.open(
    new ArrayBufferRangeSource(fixture.buffer, 'past-eof.copc.laz'),
  );
  // The entry itself is well-formed, so it parses; the refusal happens at read.
  expect(source.rootPage.nodes).toHaveLength(1);
  const err = await rejection(source.readNodeChunk(source.rootPage.nodes[0]));
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
  expect((err as Error).message).toMatch(/past the end|truncat/i);
});

test('a hierarchy entry whose byte size overruns EOF is refused, not silently clamped', async () => {
  const fixture = buildSyntheticCopc({ nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }] });
  const view = new DataView(fixture.buffer);
  view.setInt32(fixture.rootHierOffset + 24, 1 << 20, true); // 1 MiB from a ~700-byte file
  const source = await CopcSource.open(
    new ArrayBufferRangeSource(fixture.buffer, 'overrun.copc.laz'),
  );
  expect(source.rootPage.nodes).toHaveLength(1);
  const err = await rejection(source.readNodeChunk(source.rootPage.nodes[0]));
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});

test('a child hierarchy page reference past EOF is refused as truncated', async () => {
  const fixture = buildSyntheticCopc();
  const source = await CopcSource.open(
    new ArrayBufferRangeSource(fixture.buffer, 'child-eof.copc.laz'),
  );
  const err = await rejection(
    source.loadChildPage({
      key: { depth: 1, x: 0, y: 0, z: 0 },
      pageOffset: fixture.buffer.byteLength + HIERARCHY_ENTRY_SIZE,
      pageSize: HIERARCHY_ENTRY_SIZE,
    }),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as Error).message).toMatch(/hierarchy/i);
});

// ── Hierarchy entries with negative / absurd values ──────────────────────────

test('negative and absurd hierarchy entries are collected as readable errors and skipped', () => {
  const cube: OctreeCube = { center: [0, 0, 0], halfsize: 512 };
  const buf = new ArrayBuffer(4 * HIERARCHY_ENTRY_SIZE);
  const view = new DataView(buf);
  const writeEntry = (
    i: number,
    key: [number, number, number, number],
    offset: bigint,
    byteSize: number,
    count: number,
  ): void => {
    const p = i * HIERARCHY_ENTRY_SIZE;
    view.setInt32(p, key[0], true);
    view.setInt32(p + 4, key[1], true);
    view.setInt32(p + 8, key[2], true);
    view.setInt32(p + 12, key[3], true);
    view.setBigInt64(p + 16, offset, true);
    view.setInt32(p + 24, byteSize, true);
    view.setInt32(p + 28, count, true);
  };
  writeEntry(0, [0, 0, 0, 0], 600n, 48, -5); // negative point count
  writeEntry(1, [1, 0, 0, 0], 600n, -48, 10); // negative byte length
  writeEntry(2, [1, 1, 0, 0], -1n, 48, 10); // negative offset
  writeEntry(3, [-2, 0, 0, 0], 600n, 48, 10); // invalid voxel key

  const page = parseHierarchyPage(buf, cube, 10);
  expect(page.nodes).toHaveLength(0);
  expect(page.childPages).toHaveLength(0);
  expect(page.errors).toHaveLength(4);
  for (const e of page.errors) {
    expect(e).toMatch(/invalid|malformed/);
    expect(e).not.toMatch(/undefined|NaN/);
  }
  expect(page.errors.some((e) => /point count -5/.test(e))).toBe(true);
});

test('one corrupt hierarchy entry never aborts the open — reported and skipped', async () => {
  const fixture = buildSyntheticCopc({ corrupt: 'bad-hierarchy-entry' });
  const source = await CopcSource.open(
    new ArrayBufferRangeSource(fixture.buffer, 'bad-entry.copc.laz'),
  );
  expect(source.rootPage.nodes).toHaveLength(0);
  expect(source.rootPage.errors.length).toBeGreaterThan(0);
  expect(source.rootPage.errors[0]).toMatch(/malformed/);
});

// ── Corrupted LAZ chunk body ─────────────────────────────────────────────────

test('a corrupted LAZ chunk body is refused with a COPC error, not a WASM abort', async () => {
  const lazPerf = await getLazPerf();
  // Deterministic garbage — laz-perf's chunk decoder aborts on this stream
  // with a raw Emscripten value; the boundary must translate it.
  const garbage = new Uint8Array(300);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 101) & 0xff;
  const err = caught(() => decompressChunk(lazPerf, garbage.buffer, CHUNK_META()));
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});

test('a node whose declared point count dwarfs its bytes is refused before allocation', async () => {
  const lazPerf = await getLazPerf();
  const err = caught(() =>
    decompressChunk(lazPerf, new ArrayBuffer(48), CHUNK_META({ pointCount: 2_147_483_647 })),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});

test('an empty chunk that still declares points is refused', async () => {
  const lazPerf = await getLazPerf();
  const err = caught(() =>
    decompressChunk(lazPerf, new ArrayBuffer(0), CHUNK_META({ pointCount: 10 })),
  );
  expectStructured(err);
  expect(err).toBeInstanceOf(LoadError);
  expect((err as LoadError).category).toBe('malformed-file');
});
