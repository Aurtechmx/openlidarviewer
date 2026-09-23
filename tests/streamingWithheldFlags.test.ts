/**
 * streamingWithheldFlags.test.ts
 *
 * Checks that classification flags survive the streaming (COPC and EPT)
 * decode paths, using the `withheld-flags.las` fixture (PDRF 6, 12 points:
 * 3 Withheld, 2 Overlap — one also Withheld, 1 Synthetic, 1 Key-point). The
 * COPC and EPT laszip decoders are compared per-index against the static
 * `.las` decode of the same fixture, not just by aggregate counts. The EPT
 * binary decoder is checked against a hand-built schema, since it has no
 * whole-file LAS/LAZ input to compare against.
 *
 * Also checks the negative: a source with no flags channel (an EPT binary
 * schema that omits `ClassFlags`, or a resident chunk missing the field)
 * leaves `classificationFlags` `undefined`, never a zero-filled array —
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
import { normalizeClassificationFlagsByte } from '../src/io/lasDecodeShared';
import { parseBuffer } from '../src/io/parseBuffer';

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

/** The fixture decoded through the real static-file reader — the reference. */
async function staticFlags(): Promise<Uint8Array> {
  const { cloud } = await parseBuffer(FIXTURE_BUF.slice(0), 'las', 'withheld-flags.las');
  const flags = cloud.classificationFlags;
  expect(flags, 'static .las decode produced no classification flags').toBeTruthy();
  return flags as Uint8Array;
}

describe('normalizeClassificationFlagsByte', () => {
  it('unpacks the legacy layout: Synthetic, Key-point and Withheld from bits 5-7, no Overlap flag', () => {
    // 0xE0 = 0b1110_0000: bits 5, 6 and 7 set.
    expect(normalizeClassificationFlagsByte(0xe0, false)).toBe(0x7);
    // Legacy has no overlap flag bit — only class 12 means overlap, decoded
    // elsewhere — so bit 3 of the normalised nibble is always 0 here.
    expect(normalizeClassificationFlagsByte(0xe0, false) & 0x8).toBe(0);
  });

  it('ignores the low 5 class bits packed into the same legacy byte', () => {
    // Class 31 (0x1f) in bits 0-4, no flags set in bits 5-7.
    expect(normalizeClassificationFlagsByte(0x1f, false)).toBe(0);
    // Class 31 plus all three legacy flags: the class bits contribute nothing.
    expect(normalizeClassificationFlagsByte(0xff, false)).toBe(0x7);
  });

  it('reads the extended layout as the low nibble, unmasked by anything else', () => {
    expect(normalizeClassificationFlagsByte(0x0f, true)).toBe(0xf);
    expect(normalizeClassificationFlagsByte(0xf0, true)).toBe(0);
  });
});

describe('COPC streaming: classification flags survive decodeRecords', () => {
  it('matches the static .las decode index-for-index, and the fixture counts', async () => {
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
    expect([...flags]).toEqual([...(await staticFlags())]);
  });
});

describe('EPT laszip streaming: classification flags survive decodeEptLaszipTile', () => {
  it('matches the static .las decode index-for-index, and the fixture counts', async () => {
    const decoded = await decodeEptLaszipTile(FIXTURE_BUF, [0, 0, 0]);
    expect(decoded.pointCount).toBe(12);
    expect(decoded.classificationFlags, 'EPT laszip decode produced no classification flags').toBeTruthy();
    const flags = decoded.classificationFlags as Uint8Array;
    expect(flags.length).toBe(12);
    assertFixtureCounts(flags);
    expect([...flags]).toEqual([...(await staticFlags())]);
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
