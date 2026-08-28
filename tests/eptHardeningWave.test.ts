/**
 * eptHardeningWave.test.ts — adversarial, red-first coverage for the EPT
 * hardening wave. Each test pins one hole the audit found:
 *
 *   #2  laszip tile header count vs hierarchy count — mismatch refused.
 *   #4  root hierarchy fetch failure — open() rejects, no empty success.
 *   #5  Σ(node points) vs ept.json.points — mismatch drops isComplete with a
 *       named POINT_COUNT_MISMATCH reason.
 *   #9  narrower-than-declared channel widths — Intensity uint32=70000 refused
 *       (never wrapped to 4464), never truncated.
 *   #10 EPT binary tile with trailing bytes — refused (exact-stride equality).
 *   #13 uint64 beyond 2^53 − 1 — refused (already covered; re-asserted here).
 *   #14 non-power-of-two span refused; non-EPSG authority not read as EPSG.
 *
 * Pure Node — no DOM, no three.js, no live HTTP.
 */

import { test, expect } from 'vitest';
import { decodeEptBinaryTile } from '../src/io/ept/eptBinaryDecode';
import { EptChunkDecoder } from '../src/io/ept/EptChunkDecoder';
import { EptOctree } from '../src/render/streaming/EptOctree';
import { EptStreamingPointCloud } from '../src/render/streaming/EptStreamingPointCloud';
import type { EptTransport } from '../src/render/streaming/EptStreamingPointCloud';
import { parseEptMetadata } from '../src/io/ept/eptDetect';
import { LoadError } from '../src/io/loadErrors';
import type {
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';
import type { EptKey, EptMetadata, EptSchemaField } from '../src/io/ept/eptTypes';

// ── helpers ──────────────────────────────────────────────────────────────────

const XYZ: EptSchemaField[] = [
  { name: 'X', size: 4, type: 'signed', scale: 0.001, offset: 0 },
  { name: 'Y', size: 4, type: 'signed', scale: 0.001, offset: 0 },
  { name: 'Z', size: 4, type: 'signed', scale: 0.001, offset: 0 },
];

function tileFor(
  schema: readonly EptSchemaField[],
  points: number,
  write: (view: DataView, offsetOf: (name: string) => number, i: number) => void,
  extraBytes = 0,
): ArrayBuffer {
  let stride = 0;
  const offsets = new Map<string, number>();
  for (const f of schema) {
    offsets.set(f.name, stride);
    stride += f.size;
  }
  const buffer = new ArrayBuffer(stride * points + extraBytes);
  const view = new DataView(buffer);
  const offOf = (name: string): number => {
    const off = offsets.get(name);
    if (off === undefined) throw new Error(`no attribute ${name}`);
    return off;
  };
  for (let i = 0; i < points; i++) {
    write(view, (n) => i * stride + offOf(n), i);
  }
  return buffer;
}

/** A valid EPT manifest object with the given overrides applied. */
function buildManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.1.0',
    dataType: 'binary',
    hierarchyType: 'json',
    points: 100,
    span: 128,
    schema: [
      { name: 'X', size: 4, type: 'signed', scale: 0.001, offset: 0 },
      { name: 'Y', size: 4, type: 'signed', scale: 0.001, offset: 0 },
      { name: 'Z', size: 4, type: 'signed', scale: 0.001, offset: 0 },
    ],
    bounds: [0, 0, 0, 10, 10, 10],
    ...overrides,
  };
}

function parsedMeta(overrides: Record<string, unknown> = {}): EptMetadata {
  const result = parseEptMetadata(JSON.stringify(buildManifest(overrides)));
  if (!result.isEpt) throw new Error(`fixture manifest failed to parse: ${result.reason}`);
  return result.metadata;
}

// ── #10 exact-stride binary tile ─────────────────────────────────────────────

test('#10 an EPT binary tile with trailing bytes is refused (exact stride)', () => {
  // 1 point × 12-byte stride = 12 bytes; append 4 trailing bytes.
  const tile = tileFor(XYZ, 1, (view, off) => {
    view.setInt32(off('X'), 1000, true);
    view.setInt32(off('Y'), 2000, true);
    view.setInt32(off('Z'), 3000, true);
  }, 4);
  expect(() => decodeEptBinaryTile(tile, 1, XYZ, [0, 0, 0])).toThrow(LoadError);
  expect(() => decodeEptBinaryTile(tile, 1, XYZ, [0, 0, 0])).toThrow(/trailing/);
});

test('#10 an exact-length binary tile still decodes', () => {
  const tile = tileFor(XYZ, 1, (view, off) => {
    view.setInt32(off('X'), 1000, true);
    view.setInt32(off('Y'), 2000, true);
    view.setInt32(off('Z'), 3000, true);
  });
  const decoded = decodeEptBinaryTile(tile, 1, XYZ, [0, 0, 0]);
  expect(decoded.positions[0]).toBeCloseTo(1, 6);
});

// ── #9 channel width fits losslessly ─────────────────────────────────────────

test('#9 Intensity declared uint32=70000 is refused, never wrapped to 4464', () => {
  const schema: EptSchemaField[] = [
    ...XYZ,
    { name: 'Intensity', size: 4, type: 'unsigned' },
  ];
  const tile = tileFor(schema, 1, (view, off) => {
    view.setInt32(off('X'), 0, true);
    view.setInt32(off('Y'), 0, true);
    view.setInt32(off('Z'), 0, true);
    view.setUint32(off('Intensity'), 70000, true);
  });
  let thrown: unknown;
  try {
    decodeEptBinaryTile(tile, 1, schema, [0, 0, 0]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LoadError);
  expect((thrown as Error).message).toMatch(/unsupported EPT schema/);
  // The wrapped value must never appear anywhere in the error text.
  expect((thrown as Error).message).not.toMatch(/4464/);
});

test('#9 Classification declared size 2 is refused (would wrap 300 to 44)', () => {
  const schema: EptSchemaField[] = [
    ...XYZ,
    { name: 'Classification', size: 2, type: 'unsigned' },
  ];
  const tile = tileFor(schema, 1, (view, off) => {
    view.setInt32(off('X'), 0, true);
    view.setInt32(off('Y'), 0, true);
    view.setInt32(off('Z'), 0, true);
    view.setUint16(off('Classification'), 300, true);
  });
  expect(() => decodeEptBinaryTile(tile, 1, schema, [0, 0, 0])).toThrow(/unsupported EPT schema/);
});

test('#9 standard-width channels (Intensity u16, Classification u8) still decode', () => {
  const schema: EptSchemaField[] = [
    ...XYZ,
    { name: 'Intensity', size: 2, type: 'unsigned' },
    { name: 'Classification', size: 1, type: 'unsigned' },
  ];
  const tile = tileFor(schema, 1, (view, off) => {
    view.setInt32(off('X'), 0, true);
    view.setInt32(off('Y'), 0, true);
    view.setInt32(off('Z'), 0, true);
    view.setUint16(off('Intensity'), 40000, true);
    view.setUint8(off('Classification'), 12);
  });
  const decoded = decodeEptBinaryTile(tile, 1, schema, [0, 0, 0]);
  expect(decoded.intensity?.[0]).toBe(40000);
  expect(decoded.classification?.[0]).toBe(12);
});

// ── #13 uint64 beyond safe integer ───────────────────────────────────────────

test('#13 a uint64 X beyond 2^53 − 1 is refused (not silently rounded)', () => {
  const schema: EptSchemaField[] = [
    { name: 'X', size: 8, type: 'unsigned', scale: 1, offset: 0 },
    { name: 'Y', size: 8, type: 'unsigned', scale: 1, offset: 0 },
    { name: 'Z', size: 8, type: 'unsigned', scale: 1, offset: 0 },
  ];
  const tile = tileFor(schema, 1, (view, off) => {
    view.setBigUint64(off('X'), (1n << 53n) + 1n, true);
    view.setBigUint64(off('Y'), 0n, true);
    view.setBigUint64(off('Z'), 0n, true);
  });
  expect(() => decodeEptBinaryTile(tile, 1, schema, [0, 0, 0])).toThrow(LoadError);
});

// ── #14 metadata validation ──────────────────────────────────────────────────

test('#14 a non-power-of-two span is refused', () => {
  const result = parseEptMetadata(JSON.stringify(buildManifest({ span: 100 })));
  expect(result.isEpt).toBe(false);
  if (!result.isEpt) expect(result.reason).toMatch(/power of two/);
});

test('#14 a power-of-two span is accepted', () => {
  const result = parseEptMetadata(JSON.stringify(buildManifest({ span: 256 })));
  expect(result.isEpt).toBe(true);
});

test('#14 a numeric horizontal code under a NON-EPSG authority is not read as EPSG', () => {
  const meta = parsedMeta({
    srs: { authority: 'IAU', horizontal: '30100', vertical: '30101' },
  });
  // The code is preserved on `authority`, but never surfaced as an EPSG code.
  expect(meta.srsCodes?.authority).toBe('IAU');
  expect(meta.srsCodes?.horizontalEpsg).toBeUndefined();
  expect(meta.srsCodes?.verticalEpsg).toBeUndefined();
});

test('#14 a numeric horizontal code under EPSG authority is read as EPSG', () => {
  const meta = parsedMeta({
    srs: { authority: 'EPSG', horizontal: '32612', vertical: '5703' },
  });
  expect(meta.srsCodes?.horizontalEpsg).toBe(32612);
  expect(meta.srsCodes?.verticalEpsg).toBe(5703);
});

// ── #5 point-count reconciliation ────────────────────────────────────────────

function rootOnlyFetcher(nodePoints: number): (key: EptKey) => Promise<string> {
  return async (key) => {
    if (key.d === 0) return JSON.stringify({ '0-0-0-0': nodePoints });
    throw new Error(`no such hierarchy file ${key.d}-${key.x}-${key.y}-${key.z}`);
  };
}

test('#5 a hierarchy whose node counts sum below ept.json.points is not isComplete', async () => {
  const meta = parsedMeta({ points: 150 });
  const octree = new EptOctree(meta, rootOnlyFetcher(100));
  await octree.loadFullHierarchy();
  expect(octree.fullyLoaded).toBe(true);
  expect(octree.isComplete).toBe(false);
  expect(octree.errors.some((e) => e.includes('POINT_COUNT_MISMATCH'))).toBe(true);
  // The named reason carries both totals.
  const reason = octree.errors.find((e) => e.includes('POINT_COUNT_MISMATCH'))!;
  expect(reason).toMatch(/150/);
  expect(reason).toMatch(/100/);
});

test('#5 a hierarchy whose node counts sum exactly to ept.json.points is isComplete', async () => {
  const meta = parsedMeta({ points: 100 });
  const octree = new EptOctree(meta, rootOnlyFetcher(100));
  await octree.loadFullHierarchy();
  expect(octree.isComplete).toBe(true);
  expect(octree.errors).toHaveLength(0);
});

// ── #4 root hierarchy failure → open() rejects ───────────────────────────────

test('#4 a failed root hierarchy fetch rejects open() instead of an empty success', async () => {
  const meta = parsedMeta({ points: 100 });
  const transport: EptTransport = {
    fetchText: async () => {
      throw new Error('503 from CDN');
    },
    fetchBytes: async () => new ArrayBuffer(0),
  };
  await expect(
    EptStreamingPointCloud.open(meta, 'https://host/ept.json', 'test', transport),
  ).rejects.toThrow(/unable to open EPT hierarchy/);
});

test('#4 a healthy root hierarchy opens with at least one node', async () => {
  const meta = parsedMeta({ points: 100 });
  const transport: EptTransport = {
    fetchText: async () => JSON.stringify({ '0-0-0-0': 100 }),
    fetchBytes: async () => new ArrayBuffer(0),
  };
  const cloud = await EptStreamingPointCloud.open(meta, 'https://host/ept.json', 'test', transport);
  expect(cloud.octree.nodes().length).toBeGreaterThan(0);
  await cloud.close();
});

// ── #2 laszip header count vs hierarchy count ────────────────────────────────

/** A minimal laszip cloud stub the decoder can dispatch against. */
function laszipCloudStub(): EptStreamingPointCloud {
  return {
    dataType: 'laszip',
    renderOrigin: [0, 0, 0],
  } as unknown as EptStreamingPointCloud;
}

const META_100: ChunkDecodeMetadata = {
  pointDataRecordFormat: -1,
  pointRecordLength: 0,
  pointCount: 100,
  scale: [1, 1, 1],
  offset: [0, 0, 0],
  renderOrigin: [0, 0, 0],
  rgbEightBit: undefined,
};

function chunkWith(pointCount: number): DecodedChunk {
  return {
    pointCount,
    positions: new Float32Array(pointCount * 3),
  } as DecodedChunk;
}

test('#2 a laszip tile whose header count disagrees with the hierarchy count is refused', async () => {
  // The injected worker returns a chunk claiming 10M points against a hierarchy
  // entry of 100 — the memory-admission bypass the audit flagged.
  const worker = {
    decodeTile: async (): Promise<DecodedChunk> => chunkWith(10_000_000),
  };
  const decoder = new EptChunkDecoder(laszipCloudStub(), worker as never);
  await expect(decoder.decode(new ArrayBuffer(0), META_100)).rejects.toThrow(LoadError);
  await expect(decoder.decode(new ArrayBuffer(0), META_100)).rejects.toThrow(
    /hierarchy entry declares 100/,
  );
});

test('#2 a laszip tile whose header count matches the hierarchy count passes', async () => {
  const worker = {
    decodeTile: async (): Promise<DecodedChunk> => chunkWith(100),
  };
  const decoder = new EptChunkDecoder(laszipCloudStub(), worker as never);
  const decoded = await decoder.decode(new ArrayBuffer(0), META_100);
  expect(decoded.pointCount).toBe(100);
});
