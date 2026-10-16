/**
 * A source content digest taken at open tells two files apart that agree on
 * every metadata fact the CRS override identity records (name, point count,
 * spans, absolute position) but hold different bytes.
 *
 * The digest is computed from bytes the open already reads or can read
 * cheaply: a local or fetched file hashes its first and last 64 KiB; a COPC
 * stream hashes the 16 KiB head it parsed plus the root hierarchy page; an EPT
 * stream hashes its manifest plus the root hierarchy document. No open reads
 * the whole file for it.
 *
 * Each digest names its scheme (`olvsrc1-file:`, `olvsrc1-copc:`,
 * `olvsrc1-ept:`). Digests of different schemes are not compared, so a record
 * made under one scheme falls back to the position check under another.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CrsService, classifyOverrideMatch, datasetIdentity, OVERRIDE_IDENTITY_VERSION, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import {
  FILE_FINGERPRINT_WINDOW_BYTES,
  FINGERPRINT_PART_MAX_BYTES,
  fileSourceFingerprint,
  fingerprintParts,
} from '../src/io/sourceFingerprint';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { CopcSource } from '../src/io/copc/CopcSource';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { EptStreamingPointCloud, type EptTransport } from '../src/render/streaming/EptStreamingPointCloud';
import { parseEptMetadata } from '../src/io/ept/eptDetect';

function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: Date.now() }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** Deterministic bytes; `flip` changes one byte at the given offset. */
function bytes(size: number, flip?: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  if (flip !== undefined) b[flip] ^= 0xff;
  return b;
}

/** The same metadata facts for both files: same count, spans and position. */
function staticCloud(sourceDigest: string | null) {
  const origin: [number, number, number] = [500_000, 4_000_000, 50];
  return {
    pointCount: 1_000_000,
    sourceOrigin: origin,
    origin,
    bounds: () => ({ min: [0, 0, 0], max: [500, 500, 50] }),
    sourceDigest,
  };
}

describe('fileSourceFingerprint', () => {
  const size = FILE_FINGERPRINT_WINDOW_BYTES * 4;

  it('is stable for identical bytes and names its scheme', async () => {
    const a = await fileSourceFingerprint(new Blob([bytes(size)]));
    const b = await fileSourceFingerprint(new Blob([bytes(size)]));
    expect(a).toMatch(/^olvsrc1-file:[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs when the head or the tail differ', async () => {
    const base = await fileSourceFingerprint(new Blob([bytes(size)]));
    expect(await fileSourceFingerprint(new Blob([bytes(size, 10)]))).not.toBe(base);
    expect(await fileSourceFingerprint(new Blob([bytes(size, size - 10)]))).not.toBe(base);
  });

  it('differs when only the size differs', async () => {
    const a = await fileSourceFingerprint(new Blob([bytes(size)]));
    const b = await fileSourceFingerprint(new Blob([bytes(size + 1)]));
    expect(a).not.toBe(b);
  });

  it('reuses a head the open already read, with the same result', async () => {
    const data = bytes(size);
    const head = data.slice(0, FILE_FINGERPRINT_WINDOW_BYTES).buffer;
    const read = await fileSourceFingerprint(new Blob([data]));
    const reused = await fileSourceFingerprint(new Blob([data]), head);
    expect(reused).toBe(read);
  });

  it('handles a file smaller than one window', async () => {
    const a = await fileSourceFingerprint(new Blob([bytes(100)]));
    const b = await fileSourceFingerprint(new Blob([bytes(100, 99)]));
    expect(a).toMatch(/^olvsrc1-file:/);
    expect(a).not.toBe(b);
  });

  it('reads only the two windows, never the whole file', async () => {
    const data = bytes(FILE_FINGERPRINT_WINDOW_BYTES * 64);
    const reads: number[] = [];
    const blob = new Blob([data]);
    const spy = {
      size: blob.size,
      slice: (start?: number, end?: number) => {
        reads.push((end ?? blob.size) - (start ?? 0));
        return blob.slice(start, end);
      },
    } as unknown as Blob;
    await fileSourceFingerprint(spy);
    expect(reads.length).toBeLessThanOrEqual(2);
    for (const n of reads) expect(n).toBeLessThanOrEqual(FILE_FINGERPRINT_WINDOW_BYTES);
  });
});

describe('fingerprintParts', () => {
  it('keeps the kind in the scheme and separates part boundaries', async () => {
    const ab = await fingerprintParts('copc', 10, [new Uint8Array([1, 2]), new Uint8Array([3])]);
    const a_b = await fingerprintParts('copc', 10, [new Uint8Array([1]), new Uint8Array([2, 3])]);
    const ept = await fingerprintParts('ept', 10, [new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(ab).toMatch(/^olvsrc1-copc:/);
    expect(ept).toMatch(/^olvsrc1-ept:/);
    expect(ab).not.toBe(a_b);
  });

  it('hashes at most the first window of an oversized part, and still keys its length', async () => {
    const big = new Uint8Array(FINGERPRINT_PART_MAX_BYTES * 4);
    const sameHead = big.slice();
    sameHead[sameHead.length - 1] = 7;
    const shorter = big.subarray(0, FINGERPRINT_PART_MAX_BYTES * 2);
    const head = new Uint8Array([1, 2, 3]);
    const a = await fingerprintParts('copc', 10, [head, big]);
    expect(a).toMatch(/^olvsrc1-copc:/);
    expect(await fingerprintParts('copc', 10, [head, sameHead])).toBe(a);
    expect(await fingerprintParts('copc', 10, [head, shorter])).not.toBe(a);
  });
});

describe('the CRS override identity carries the digest', () => {
  it('datasetIdentity reads the cloud digest', () => {
    expect(datasetIdentity(staticCloud('olvsrc1-file:abc'))?.digest).toBe('olvsrc1-file:abc');
    expect(datasetIdentity(staticCloud(null))?.digest).toBeUndefined();
  });

  it('same metadata, different content: the override is not applied or offered', async () => {
    const size = FILE_FINGERPRINT_WINDOW_BYTES * 3;
    const dA = await fileSourceFingerprint(new Blob([bytes(size)]));
    const dB = await fileSourceFingerprint(new Blob([bytes(size, size - 1)]));
    const port = memoryPort();
    const first = new CrsService(port);
    first.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(dA)) });
    first.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    expect(port.entries.get('points.las')?.identity?.digest).toBe(dA);

    const second = new CrsService(port);
    const other = second.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(dB)) });
    expect(other.epsg).toBeUndefined();
    expect(other.userConfirmed).not.toBe(true);
    expect(second.overrideSuggestion()).toBeNull();
  });

  it('the identical file verifies and applies', async () => {
    const size = FILE_FINGERPRINT_WINDOW_BYTES * 3;
    const d = await fileSourceFingerprint(new Blob([bytes(size)]));
    const port = memoryPort();
    const first = new CrsService(port);
    first.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(d)) });
    first.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    const again = await fileSourceFingerprint(new Blob([bytes(size)]));
    const r = new CrsService(port).resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud(again)) });
    expect(r.epsg).toBe(32612);
    expect(r.userConfirmed).toBe(true);
  });

  it('digests of different schemes are not compared; the position check decides', () => {
    const stored: CrsOverride = {
      epsg: 32612, kind: 'projected', updatedAt: 1, detectedEpsgObserved: true,
      identity: { ...datasetIdentity(staticCloud(null))!, digest: 'olvsrc1-copc:aaaa' },
      identityVersion: OVERRIDE_IDENTITY_VERSION,
    };
    const loaded = datasetIdentity(staticCloud('olvsrc1-file:bbbb'));
    expect(classifyOverrideMatch(stored, undefined, loaded).kind).toBe('verified');
    const sameScheme = datasetIdentity(staticCloud('olvsrc1-copc:bbbb'));
    expect(classifyOverrideMatch(stored, undefined, sameScheme).kind).toBe('different');
  });

  it('a legacy record stays a suggestion even when the loaded file has a digest', () => {
    const port = memoryPort();
    port.entries.set('points.las', { epsg: 32612, kind: 'projected', updatedAt: 1 });
    const svc = new CrsService(port);
    const r = svc.resolveForScan({ name: 'points.las', detected: undefined, source: 'las-vlr', identity: datasetIdentity(staticCloud('olvsrc1-file:abc')) });
    expect(r.epsg).toBeUndefined();
    expect(svc.overrideSuggestion()?.reason).toBe('legacy');
  });
});

describe('streaming sources state a digest at open', () => {
  it('COPC: same bytes give the same digest; a different hierarchy gives another', async () => {
    const a = buildSyntheticCopc({ nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }] }).buffer;
    const b = buildSyntheticCopc({ nodes: [{ key: [0, 0, 0, 0], pointCount: 101 }] }).buffer;
    const sa = await CopcSource.open(new ArrayBufferRangeSource(a));
    const sa2 = await CopcSource.open(new ArrayBufferRangeSource(a.slice(0)));
    const sb = await CopcSource.open(new ArrayBufferRangeSource(b));
    expect(sa.sourceDigest).toMatch(/^olvsrc1-copc:[0-9a-f]{64}$/);
    expect(sa2.sourceDigest).toBe(sa.sourceDigest);
    expect(sb.sourceDigest).not.toBe(sa.sourceDigest);
    const cloud = await StreamingPointCloud.open(new ArrayBufferRangeSource(a), 'x.copc.laz');
    expect(cloud.sourceDigest).toBe(sa.sourceDigest);
    expect(datasetIdentity(cloud)?.digest).toBe(sa.sourceDigest);
  });

  it('EPT: the manifest and root hierarchy are hashed', async () => {
    const dir = join(__dirname, 'fixtures', 'ept-tiny');
    const text = readFileSync(join(dir, 'ept.json'), 'utf8');
    const parsed = parseEptMetadata(text);
    if (!parsed.isEpt) throw new Error('fixture failed to parse');
    const transport = (rootOverride?: string): EptTransport => ({
      fetchText: async (url) => {
        const rel = url.replace(/^fixture:\/\/ept-tiny\//, '');
        if (rootOverride && rel.endsWith('0-0-0-0.json')) return rootOverride;
        return readFileSync(join(dir, rel), 'utf8');
      },
      fetchBytes: async (url) => {
        const buf = readFileSync(join(dir, url.replace(/^fixture:\/\/ept-tiny\//, '')));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    });
    const a = await EptStreamingPointCloud.open(parsed.metadata, 'fixture://ept-tiny/', 'ept-tiny', transport());
    const a2 = await EptStreamingPointCloud.open(parsed.metadata, 'fixture://ept-tiny/', 'ept-tiny', transport());
    expect(a.sourceDigest).toMatch(/^olvsrc1-ept:[0-9a-f]{64}$/);
    expect(a2.sourceDigest).toBe(a.sourceDigest);
    const edited = JSON.stringify({ '0-0-0-0': 99 });
    const b = await EptStreamingPointCloud.open(parsed.metadata, 'fixture://ept-tiny/', 'ept-tiny', transport(edited));
    expect(b.sourceDigest).not.toBe(a.sourceDigest);
    expect(datasetIdentity(a)?.digest).toBe(a.sourceDigest);
  });
});
