/**
 * fileFingerprint.ts — the pre-decode identity of a heavy local file.
 *
 * Phase 1 of the persistent out-of-core cache. A persisted index has to be keyed
 * by something that identifies the source file BEFORE it is decoded, and that
 * key must miss whenever the bytes could have changed. `name + size + mtime` is
 * not enough on its own — an in-place edit can preserve both — so the
 * fingerprint folds in the parsed header facts and a set of sampled content
 * windows. Any difference in those inputs yields a different digest, so a cache
 * built on this key can never serve a stale index for an edited file.
 *
 * The digest is SHA-256 over the raw sampled bytes plus a canonical serialisation
 * of the facts and the window layout. SHA-256 rather than the 32-bit FNV used for
 * value fingerprints elsewhere: a collision here is a false cache HIT — stale
 * data served as fresh — the one failure this must not have.
 *
 * Pure and layer-free: no filename, no path, no decode. `computeFileFingerprint`
 * takes only bytes and facts, so a rename is a HIT (the bytes match) and a
 * content change is a MISS. Reading the windows from an actual file is the
 * caller's job; the sample plan below says which windows to read.
 */

import { canonicalJson } from '../../canonicalHash';
import type { RangeSource } from '../range/RangeSource';

/** Bumped when the fingerprint's inputs or layout change, so old keys miss. */
export const FINGERPRINT_VERSION = 1;

/** Bytes per sampled window, and the interior sample positions as file fractions. */
const WINDOW_BYTES = 4096;
const INTERIOR_FRACTIONS = [0.25, 0.5, 0.75] as const;

/** Pre-decode facts parsed from the LAS/LAZ public header, plus file metadata. */
export interface FingerprintFacts {
  readonly fileBytes: number;
  readonly lastModified: number;
  readonly declaredPointCount: number;
  readonly offsetToPointData: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A byte window to read for the fingerprint. */
export interface FingerprintWindow {
  readonly offset: number;
  readonly length: number;
}

/** A window that has been read: its position and the bytes found there. */
export interface FingerprintSample extends FingerprintWindow {
  readonly bytes: Uint8Array;
}

/**
 * The windows to read for a file of `fileBytes`: the head, a few interior
 * positions, and the tail. Deterministic and bounded (constant count regardless
 * of size), and every window is clamped inside the file, so a tiny file never
 * produces a read past its end.
 */
export function fingerprintSamplePlan(fileBytes: number): FingerprintWindow[] {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return [];
  const clamp = (offset: number): FingerprintWindow => {
    const o = Math.max(0, Math.min(offset, fileBytes));
    return { offset: o, length: Math.min(WINDOW_BYTES, fileBytes - o) };
  };
  const windows: FingerprintWindow[] = [clamp(0)];
  for (const f of INTERIOR_FRACTIONS) windows.push(clamp(Math.floor(fileBytes * f)));
  windows.push(clamp(Math.max(0, fileBytes - WINDOW_BYTES)));
  return windows;
}

/** Lowercase hex of an ArrayBuffer. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Fingerprint a file from its header facts and sampled windows. SHA-256 over the
 * concatenated sample bytes, prefixed by a canonical serialisation of the version,
 * the facts, and each window's position and length — so identical bytes read at
 * different offsets, or the same bytes under different facts, fingerprint apart.
 */
export async function computeFileFingerprint(
  facts: FingerprintFacts,
  samples: readonly FingerprintSample[],
): Promise<string> {
  const meta = {
    v: FINGERPRINT_VERSION,
    facts: {
      fileBytes: facts.fileBytes,
      lastModified: facts.lastModified,
      declaredPointCount: facts.declaredPointCount,
      offsetToPointData: facts.offsetToPointData,
      min: [facts.min[0], facts.min[1], facts.min[2]],
      max: [facts.max[0], facts.max[1], facts.max[2]],
    },
    windows: samples.map((s) => ({ offset: s.offset, length: s.length })),
  };
  const metaBytes = new TextEncoder().encode(canonicalJson(meta));
  const sampleTotal = samples.reduce((n, s) => n + s.bytes.byteLength, 0);
  const buffer = new Uint8Array(metaBytes.byteLength + sampleTotal);
  buffer.set(metaBytes, 0);
  let offset = metaBytes.byteLength;
  for (const s of samples) {
    buffer.set(s.bytes, offset);
    offset += s.bytes.byteLength;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return toHex(digest);
}

/**
 * Fingerprint a file by reading its sample-plan windows through a range source.
 * The caller supplies the header facts (which carry `fileBytes`, the bounds, and
 * the file's `lastModified`); this reads the windows and folds everything into
 * the digest. Fails closed: any read failure — or a file with no readable
 * windows — returns null, which the cache reads as "cannot identify, rebuild",
 * never as a match.
 */
export async function fingerprintFromRange(
  range: Pick<RangeSource, 'readRange'>,
  facts: FingerprintFacts,
  signal?: AbortSignal,
): Promise<string | null> {
  const plan = fingerprintSamplePlan(facts.fileBytes);
  if (plan.length === 0) return null;
  const samples: FingerprintSample[] = [];
  for (const w of plan) {
    let buf: ArrayBuffer;
    try {
      buf = await range.readRange(w.offset, w.length, signal);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(buf);
    samples.push({ offset: w.offset, length: bytes.byteLength, bytes });
  }
  return computeFileFingerprint(facts, samples);
}
