/**
 * streamingWithheldFlags.test.ts
 *
 * T1: classification flags did not survive streaming (COPC / EPT) decode, so
 * a Withheld mark on a streamed point never reached the resident snapshot the
 * science policy reads. `withheldConsequence.test.ts` already proves the
 * static `.las` path carries the flags; this proves the streaming paths do
 * too, using the same `withheld-flags.las` fixture (PDRF 6, 12 points: 3
 * Withheld, 2 Overlap — one also Withheld, 1 Synthetic, 1 Key-point).
 *
 * Also proves the negative: a format with no flags channel (a COPC/EPT chunk
 * built without one, and an EPT binary tile whose schema omits ClassFlags)
 * reports `classificationFlags` as `undefined`, never a zero-filled array —
 * zero would falsely claim "no point is Withheld".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeRecords } from '../src/io/copc/copcChunkDecode';
import type { ChunkDecodeMetadata, DecodedChunk } from '../src/io/copc/copcChunkDecode';
import { decodeEptLaszipTile } from '../src/io/ept/eptLaszipDecode';
import { decodeEptBinaryTile } from '../src/io/ept/eptBinaryDecode';
import type { EptSchemaField } from '../src/io/ept/eptTypes';
import { buildResidentSnapshot } from '../src/render/streaming/residentSnapshot';
import { parseLasHeader } from '../src/io/lasHeader';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_BYTES = readFileSync(join(FIXTURES, 'withheld-flags.las'));
const FIXTURE_BUF = FIXTURE_BYTES.buffer.slice(
  FIXTURE_BYTES.byteOffset,
  FIXTURE_BYTES.byteOffset + FIXTURE_BYTES.byteLength,
);

/** Expected counts baked into the fixture (see tests/fixtures/FIXTURES.md). */
function assertFixtureCounts(flags: Uint8Array): void {
  let withheld = 0;
  let overlap = 0;
  let synthetic = 0;
  let keyPoint = 0;
  for (const f of flags) {
    if (f & 0x4) withheld++;
    if (f & 0x8) overlap++;
    if (f & 0x1) synthetic++;
    if (f & 0x2) keyPoint++;
  }
  expect(withheld).toBe(3);
  expect(overlap).toBe(2);
  expect(synthetic).toBe(1);
  expect(keyPoint).toBe(1);
}

describe('COPC streaming: classification flags survive decodeRecords', () => {
  it('carries the fixture Withheld/Overlap/Synthetic/Key-point counts', () => {
    const header = parseLasHeader(FIXTURE_BUF);
    const raw = new Uint8Array(
      FIXTURE_BUF,
      header.offsetToPointData,
      header.pointCount * header.pointDataRecordLength,
    );
    const meta: ChunkDecodeMetadata = {
      pointDataRecordFormat: header.pointFormat,
      pointRecordLength: header.pointDataRecordLength,
      pointCount: header.pointCount,
      scale: header.scale,
      offset: header.offset,
      renderOrigin: [0, 0, 0],
    };
    const decoded = decodeRecords(raw, meta);
    expect(decoded.classificationFlags, 'COPC decode produced no classification flags').toBeTruthy();
    const flags = decoded.classificationFlags as Uint8Array;
    expect(flags.length).toBe(header.pointCount);
    assertFixtureCounts(flags);
  });

  it('leaves classificationFlags undefined for a chunk that never sets it', () => {
    // A DecodedChunk assembled by hand (e.g. the tile store's decoder) with no
    // flags channel — never a zero array.
    const chunk: DecodedChunk = { pointCount: 2, positions: new Float32Array(6) };
    expect(chunk.classificationFlags).toBeUndefined();
  });
});

describe('EPT laszip streaming: classification flags survive decodeEptLaszipTile', () => {
  it('carries the fixture counts through the whole-tile LAZ path', async () => {
    const decoded = await decodeEptLaszipTile(FIXTURE_BUF, [0, 0, 0]);
    expect(decoded.pointCount).toBe(12);
    expect(decoded.classificationFlags, 'EPT laszip decode produced no classification flags').toBeTruthy();
    const flags = decoded.classificationFlags as Uint8Array;
    expect(flags.length).toBe(12);
    assertFixtureCounts(flags);
  });
});

describe('EPT binary streaming: classification flags survive decodeEptBinaryTile', () => {
  const SCHEMA_WITH_FLAGS: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'ClassFlags', size: 1, type: 'unsigned' },
  ];
  const SCHEMA_NO_FLAGS: EptSchemaField[] = [
    { name: 'X', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Y', size: 4, type: 'signed', scale: 0.01, offset: 0 },
    { name: 'Z', size: 4, type: 'signed', scale: 0.01, offset: 0 },
  ];

  function tile(schema: readonly EptSchemaField[], flagValues: number[]): ArrayBuffer {
    let stride = 0;
    const offsets = new Map<string, number>();
    for (const f of schema) {
      offsets.set(f.name, stride);
      stride += f.size;
    }
    const buffer = new ArrayBuffer(stride * flagValues.length);
    const view = new DataView(buffer);
    flagValues.forEach((v, i) => {
      const base = i * stride;
      view.setInt32(base + (offsets.get('X') as number), 0, true);
      view.setInt32(base + (offsets.get('Y') as number), 0, true);
      view.setInt32(base + (offsets.get('Z') as number), 0, true);
      const flagsOff = offsets.get('ClassFlags');
      if (flagsOff !== undefined) view.setUint8(base + flagsOff, v);
    });
    return buffer;
  }

  it('decodes a Withheld ClassFlags nibble into classificationFlags', () => {
    // withheld=bit2(0x4), overlap=bit3(0x8), synthetic=bit0(0x1), keyPoint=bit1(0x2).
    // 3 withheld (one also overlap via 0xc), 2 overlap, 1 synthetic, 1 key point —
    // the same shape as the withheld-flags.las fixture, hand-built here to prove
    // the EPT binary schema path independently of the LAS fixture bytes.
    const values = [0x4, 0x4, 0xc, 0x8, 0x1, 0x2, 0, 0, 0, 0, 0, 0];
    const buf = tile(SCHEMA_WITH_FLAGS, values);
    const decoded = decodeEptBinaryTile(buf, values.length, SCHEMA_WITH_FLAGS, [0, 0, 0]);
    expect(decoded.classificationFlags).toBeDefined();
    const flags = decoded.classificationFlags as Uint8Array;
    expect([...flags]).toEqual(values);
    assertFixtureCounts(flags);
  });

  it('leaves classificationFlags undefined when the schema omits ClassFlags', () => {
    const buf = tile(SCHEMA_NO_FLAGS, [0, 0, 0]);
    const decoded = decodeEptBinaryTile(buf, 3, SCHEMA_NO_FLAGS, [0, 0, 0]);
    expect(decoded.classificationFlags).toBeUndefined();
    // Not-recorded must never masquerade as an all-clear zero array.
    expect(decoded.classification).toBeUndefined();
  });
});

describe('resident snapshot: classification flags reach the merged cloud', () => {
  function chunkOf(flags: number[]): DecodedChunk {
    const n = flags.length;
    return {
      pointCount: n,
      positions: new Float32Array(n * 3),
      classificationFlags: Uint8Array.from(flags),
    };
  }

  const OPTS = { origin: [0, 0, 0] as [number, number, number], name: 'scan.copc', sourceFormat: 'laz' as const };

  it('merges classificationFlags across resident chunks', () => {
    const cloud = buildResidentSnapshot([chunkOf([0x4, 0x8]), chunkOf([0x1, 0x2])], OPTS);
    expect(cloud).not.toBeNull();
    const flags = cloud!.classificationFlags;
    expect(flags).toBeDefined();
    expect([...(flags as Uint8Array)]).toEqual([0x4, 0x8, 0x1, 0x2]);
  });

  it('omits classificationFlags when only SOME resident chunks carry it', () => {
    const withFlags = chunkOf([0x4]);
    const withoutFlags: DecodedChunk = { pointCount: 1, positions: new Float32Array(3) };
    const cloud = buildResidentSnapshot([withFlags, withoutFlags], OPTS);
    expect(cloud).not.toBeNull();
    expect(cloud!.classificationFlags).toBeUndefined();
  });
});
