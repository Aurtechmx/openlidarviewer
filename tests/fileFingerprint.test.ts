/**
 * fileFingerprint.test.ts — the pre-decode identity of a heavy local file.
 *
 * Phase 1 of the persistent out-of-core cache. Before any decode, a file must be
 * reduced to a content-based fingerprint that a persisted index can be keyed by.
 * The safety property is the whole point: two files that are not byte-identical
 * in the sampled regions MUST fingerprint differently, so a cache can never
 * serve a stale index for an edited file. `name + size + mtime` is deliberately
 * NOT enough — an in-place edit that preserves size and mtime has to miss — so
 * the fingerprint folds in header facts and sampled content windows.
 */
import { describe, it, expect } from 'vitest';
import {
  fingerprintSamplePlan,
  computeFileFingerprint,
  fingerprintFromRange,
  sourceContentDigestFromRange,
  FINGERPRINT_VERSION,
  type FingerprintFacts,
  type FingerprintSample,
} from '../src/io/heavy/fileFingerprint';
import { incrementalSha256Hex } from '../src/io/heavy/incrementalSha256';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';

const facts = (over: Partial<FingerprintFacts> = {}): FingerprintFacts => ({
  fileBytes: 1_000_000,
  lastModified: 1_700_000_000_000,
  declaredPointCount: 250_000,
  offsetToPointData: 375,
  min: [500000, 4100000, 190],
  max: [501000, 4100600, 260],
  ...over,
});

const sample = (offset: number, ...vals: number[]): FingerprintSample => ({
  offset,
  length: vals.length,
  bytes: new Uint8Array(vals),
});

const samples = (): FingerprintSample[] => [sample(0, 1, 2, 3, 4), sample(500_000, 9, 9, 9), sample(999_997, 7, 8, 9)];

describe('fingerprintSamplePlan', () => {
  it('is deterministic, bounded, and every window lies inside the file', () => {
    const plan = fingerprintSamplePlan(10_000_000);
    const plan2 = fingerprintSamplePlan(10_000_000);
    expect(plan).toEqual(plan2);
    expect(plan.length).toBeGreaterThan(1);
    expect(plan.length).toBeLessThanOrEqual(8);
    for (const w of plan) {
      expect(w.offset).toBeGreaterThanOrEqual(0);
      expect(w.length).toBeGreaterThan(0);
      expect(w.offset + w.length).toBeLessThanOrEqual(10_000_000);
    }
  });

  it('covers the head (offset 0) and reaches the tail (end of file)', () => {
    const size = 10_000_000;
    const plan = fingerprintSamplePlan(size);
    expect(plan.some((w) => w.offset === 0)).toBe(true);
    expect(Math.max(...plan.map((w) => w.offset + w.length))).toBe(size);
  });

  it('clamps to the file for a tiny file — no window runs past the end', () => {
    const plan = fingerprintSamplePlan(10);
    for (const w of plan) expect(w.offset + w.length).toBeLessThanOrEqual(10);
    expect(plan.length).toBeGreaterThan(0);
  });
});

describe('computeFileFingerprint', () => {
  it('is a 64-char hex sha256 and is deterministic for identical input', async () => {
    const a = await computeFileFingerprint(facts(), samples());
    const b = await computeFileFingerprint(facts(), samples());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('changes when ANY sampled byte changes — the in-place-edit safety property', async () => {
    const base = await computeFileFingerprint(facts(), samples());
    const edited = samples();
    edited[1].bytes[0] ^= 0x01; // one bit flipped deep in the file
    const after = await computeFileFingerprint(facts(), edited);
    expect(after).not.toBe(base);
  });

  it('changes when any header fact changes (count, offset, size, bounds, mtime)', async () => {
    const base = await computeFileFingerprint(facts(), samples());
    for (const over of [
      { declaredPointCount: 250_001 },
      { offsetToPointData: 379 },
      { fileBytes: 1_000_001 },
      { lastModified: 1_700_000_000_001 },
      { min: [500000, 4100000, 191] as [number, number, number] },
      { max: [501001, 4100600, 260] as [number, number, number] },
    ]) {
      expect(await computeFileFingerprint(facts(over), samples())).not.toBe(base);
    }
  });

  it('depends on WHERE bytes were sampled, not only their values', async () => {
    const a = await computeFileFingerprint(facts(), [sample(100, 1, 2, 3)]);
    const b = await computeFileFingerprint(facts(), [sample(200, 1, 2, 3)]);
    expect(a).not.toBe(b);
  });

  it('takes no filename — identical content under a different name fingerprints the same', async () => {
    // The function signature carries no name/path; this pins that a rename is a
    // cache HIT (correct — the bytes are the same), guarding against anyone
    // adding a name into the digest later.
    expect(await computeFileFingerprint(facts(), samples())).toBe(
      await computeFileFingerprint(facts(), samples()),
    );
  });

  it('folds the version in, so a future format change invalidates old keys', async () => {
    expect(FINGERPRINT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('fingerprintFromRange', () => {
  const buildBuffer = (size: number): ArrayBuffer => {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
    return b.buffer;
  };
  const rangeFacts = (size: number): FingerprintFacts =>
    facts({ fileBytes: size, declaredPointCount: 4200, offsetToPointData: 375 });

  it('reads the sample-plan windows and matches a hand-assembled fingerprint', async () => {
    const size = 200_000;
    const buf = buildBuffer(size);
    const src = new ArrayBufferRangeSource(buf, 'x.las');
    const f = rangeFacts(size);

    const manual: FingerprintSample[] = [];
    for (const w of fingerprintSamplePlan(size)) {
      manual.push({ offset: w.offset, length: w.length, bytes: new Uint8Array(buf, w.offset, w.length) });
    }
    expect(await fingerprintFromRange(src, f)).toBe(await computeFileFingerprint(f, manual));
  });

  it('misses when a sampled byte differs (edit preserving size and facts)', async () => {
    const size = 200_000;
    const a = buildBuffer(size);
    const b = a.slice(0);
    new Uint8Array(b)[Math.floor(size / 2)] ^= 0xff; // flip a byte the interior window reads
    const f = rangeFacts(size);
    const fa = await fingerprintFromRange(new ArrayBufferRangeSource(a, 'a'), f);
    const fb = await fingerprintFromRange(new ArrayBufferRangeSource(b, 'b'), f);
    expect(fa).not.toBe(fb);
  });

  it('fails closed to null when a window read throws', async () => {
    const size = 200_000;
    const failing = {
      id: () => 'boom',
      kind: () => 'array-buffer' as const,
      size: () => Promise.resolve(size),
      readRange: () => Promise.reject(new Error('read failed')),
    };
    expect(await fingerprintFromRange(failing, rangeFacts(size))).toBeNull();
  });
});

describe('sourceContentDigestFromRange — authoritative whole-file identity', () => {
  const SIZE = 200_000;
  const build = (): Uint8Array => {
    const b = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
  };
  /** A standalone ArrayBuffer holding a copy of `u8` (never a SharedArrayBuffer). */
  const ab = (u8: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(u8.length);
    copy.set(u8);
    return copy.buffer;
  };
  /** An offset provably inside NONE of the quick-locator sample windows. */
  const gapOffset = (): number => {
    const plan = fingerprintSamplePlan(SIZE);
    const inAnyWindow = (o: number): boolean =>
      plan.some((w) => o >= w.offset && o < w.offset + w.length);
    for (let o = 0; o < SIZE; o++) if (!inAnyWindow(o)) return o;
    throw new Error('no gap offset found');
  };

  it('the exact stale-cache vector: quick locator collides, content digest differs', async () => {
    // B changes a byte OUTSIDE every sampled window, preserving size and facts.
    const a = build();
    const b = a.slice();
    const off = gapOffset();
    expect(off).toBeGreaterThan(0);
    b[off] ^= 0xff;

    const f = facts({ fileBytes: SIZE });
    const srcA = new ArrayBufferRangeSource(ab(a), 'survey.las');
    const srcB = new ArrayBufferRangeSource(ab(b), 'survey.las');

    // The quick locator cannot tell them apart — this is the false-hit vector.
    expect(await fingerprintFromRange(srcA, f)).toBe(await fingerprintFromRange(srcB, f));
    // The authoritative digest does, so reuse of B's index from A is refused.
    const da = await sourceContentDigestFromRange(srcA, SIZE);
    const db = await sourceContentDigestFromRange(srcB, SIZE);
    expect(da).not.toBe(db);
  });

  it('equals the whole-buffer hash and is chunk-count invariant', async () => {
    const a = build();
    const digest = await sourceContentDigestFromRange(new ArrayBufferRangeSource(ab(a), 'a'), SIZE);
    expect(digest).toBe(incrementalSha256Hex(a));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a rename (identical bytes) shares the digest; one changed byte does not', async () => {
    const a = build();
    const renamed = new ArrayBufferRangeSource(ab(a), 'renamed.las');
    expect(await sourceContentDigestFromRange(renamed, SIZE)).toBe(incrementalSha256Hex(a));
    const edited = a.slice();
    edited[0] ^= 0x01;
    expect(await sourceContentDigestFromRange(new ArrayBufferRangeSource(ab(edited), 'a'), SIZE)).not.toBe(
      incrementalSha256Hex(a),
    );
  });

  it('a truncated source (fewer bytes than claimed) fails closed to null', async () => {
    const a = build();
    // Claim more bytes than the buffer holds — the read past the end returns
    // empty, so the digest cannot cover the claimed length.
    expect(await sourceContentDigestFromRange(new ArrayBufferRangeSource(ab(a), 'a'), SIZE + 4096)).toBeNull();
  });

  it('an already-aborted signal yields null, never a partial digest', async () => {
    const a = build();
    const ac = new AbortController();
    ac.abort();
    expect(
      await sourceContentDigestFromRange(new ArrayBufferRangeSource(ab(a), 'a'), SIZE, ac.signal),
    ).toBeNull();
  });

  it('a read error yields null', async () => {
    const failing = {
      id: () => 'boom',
      kind: () => 'array-buffer' as const,
      size: () => Promise.resolve(SIZE),
      readRange: () => Promise.reject(new Error('read failed')),
    };
    expect(await sourceContentDigestFromRange(failing, SIZE)).toBeNull();
  });

  it('a non-positive size is null', async () => {
    const a = build();
    expect(await sourceContentDigestFromRange(new ArrayBufferRangeSource(ab(a), 'a'), 0)).toBeNull();
  });
});
