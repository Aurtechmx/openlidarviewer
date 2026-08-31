/**
 * fileFingerprint.ts — the pre-decode identity of a heavy local file.
 *
 * The persistent out-of-core cache keys a stored index by two identities, with
 * different jobs:
 *
 *   QUICK LOCATOR ({@link computeFileFingerprint} / {@link fingerprintFromRange}).
 *   A cheap, constant-cost identity: the parsed header facts plus a fixed set of
 *   sampled content windows (head, a few interior positions, tail). It reads a
 *   few kilobytes regardless of file size, so it is what a reopen computes first
 *   to find a CANDIDATE entry. It is deliberately NOT authoritative: a file
 *   edited entirely OUTSIDE the sampled windows, preserving size/mtime/header
 *   facts, produces the same locator. A locator match alone must therefore never
 *   authorise reuse — it only narrows the search to a candidate.
 *
 *   SOURCE-CONTENT DIGEST ({@link sourceContentDigestFromRange}). The
 *   authoritative identity: a SHA-256 over the ENTIRE source byte stream,
 *   computed incrementally in bounded windows so no multi-gigabyte buffer is
 *   materialised. Two files share this digest only if every byte matches, so it
 *   is what actually authorises reuse: a candidate is a verified hit only when
 *   its stored source-content digest equals the one recomputed from the file.
 *
 * Both use SHA-256 (not the 32-bit FNV used for value fingerprints elsewhere):
 * a collision here is a false cache HIT — stale data served as fresh — the one
 * failure this must not have.
 *
 * Pure and layer-free: no filename, no path, no decode. A rename is a HIT (the
 * bytes match) and any content change is a MISS. Reading from an actual file is
 * the caller's job.
 */

import { canonicalJson } from '../../canonicalHash';
import type { RangeSource } from '../range/RangeSource';
import { IncrementalSha256 } from './incrementalSha256';

/** Bumped when the fingerprint's inputs or layout change, so old keys miss. */
export const FINGERPRINT_VERSION = 1;

/** Bytes per sampled window, and the interior sample positions as file fractions. */
const WINDOW_BYTES = 4096;
const INTERIOR_FRACTIONS = [0.25, 0.5, 0.75] as const;

/**
 * Bytes read per window when streaming the whole-file source-content digest. A
 * bounded working-set size, not a correctness parameter — the digest is
 * identical for any chunk size (pinned by the incremental-hasher tests). 4 MiB
 * matches the bridge's existing bounded-read discipline; the browser build can
 * revisit it once real OPFS/file read throughput is measured.
 */
const DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;

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

/** Progress of a whole-file digest, for a "Verifying local cache…" indicator. */
export interface DigestProgress {
  readonly bytesHashed: number;
  readonly totalBytes: number;
}

/**
 * The authoritative source-content digest: SHA-256 over the entire byte stream,
 * read through the range source in bounded {@link DIGEST_CHUNK_BYTES} windows
 * and folded incrementally, so working memory stays bounded whatever the file
 * size. `fileBytes` is the total to read (the caller's parsed header size).
 *
 * Fails closed: any read failure, a zero/negative size, or a source that returns
 * fewer bytes than the file claims (a truncated read) returns null — which the
 * cache reads as "cannot verify, rebuild", never as a match. Honours an abort
 * signal between and within chunks so a cancelled verification yields null
 * rather than a partial digest. `onProgress` is optional and side-effect only.
 */
export async function sourceContentDigestFromRange(
  range: Pick<RangeSource, 'readRange'>,
  fileBytes: number,
  signal?: AbortSignal,
  onProgress?: (p: DigestProgress) => void,
): Promise<string | null> {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return null;
  const hasher = new IncrementalSha256();
  let offset = 0;
  while (offset < fileBytes) {
    if (signal?.aborted) return null;
    const length = Math.min(DIGEST_CHUNK_BYTES, fileBytes - offset);
    let buf: ArrayBuffer;
    try {
      buf = await range.readRange(offset, length, signal);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(buf);
    // A short read means the file is not the size the facts claimed — treat it
    // as unverifiable rather than hashing a truncated stream as if whole.
    if (bytes.byteLength === 0) return null;
    hasher.update(bytes);
    offset += bytes.byteLength;
    onProgress?.({ bytesHashed: offset, totalBytes: fileBytes });
  }
  if (offset !== fileBytes) return null;
  return hasher.digestHex();
}
