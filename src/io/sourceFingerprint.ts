/**
 * sourceFingerprint.ts — a cheap, versioned content fingerprint of a source,
 * taken at open from bytes the open already holds or can read in two small
 * slices. It is what the CRS override identity uses to tell two files apart
 * that agree on name, point count, spans and position but hold different
 * bytes.
 *
 * It is not a whole-file digest: an edit confined to the unsampled interior of
 * a static file keeps the fingerprint. That is the trade for never reading the
 * whole file at open. The out-of-core cache, which must never serve stale data,
 * keeps its own whole-file digest (`io/heavy/fileFingerprint.ts`).
 *
 * The result names its scheme, `olvsrc<version>-<kind>:<sha256 hex>`, so a
 * fingerprint taken one way is never compared with one taken another way:
 *
 *   - `file`: the first and last {@link FILE_FINGERPRINT_WINDOW_BYTES} of a
 *     local or fetched file, plus its size.
 *   - `copc`: the head a COPC open parses (header and VLRs) plus the root
 *     hierarchy page, plus the file size.
 *   - `ept`: the canonical manifest plus the root hierarchy document.
 *
 * Fails soft: where Web Crypto is unavailable (an insecure context) or a read
 * fails, the fingerprint is null and the identity falls back to its metadata
 * facts.
 */

/** Bumped when any scheme's inputs or layout change. */
export const SOURCE_FINGERPRINT_VERSION = 1;

/** Bytes hashed from each end of a file for the `file` scheme. */
export const FILE_FINGERPRINT_WINDOW_BYTES = 64 * 1024;

/** How the fingerprinted bytes were chosen. */
export type SourceFingerprintKind = 'file' | 'copc' | 'ept';

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Fingerprint an ordered list of byte parts. The hashed stream starts with a
 * line naming the scheme, the total source size and each part's length, so the
 * same bytes split differently, or the same bytes from a source of another
 * size, fingerprint apart.
 */
export async function fingerprintParts(
  kind: SourceFingerprintKind,
  totalBytes: number,
  parts: readonly Uint8Array[],
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const scheme = `olvsrc${SOURCE_FINGERPRINT_VERSION}-${kind}`;
  const head = new TextEncoder().encode(`${scheme}|${totalBytes}|${parts.map((p) => p.byteLength).join(',')}\n`);
  const total = head.byteLength + parts.reduce((n, p) => n + p.byteLength, 0);
  const buffer = new Uint8Array(total);
  buffer.set(head, 0);
  let offset = head.byteLength;
  for (const p of parts) {
    buffer.set(p, offset);
    offset += p.byteLength;
  }
  try {
    return `${scheme}:${toHex(await subtle.digest('SHA-256', buffer))}`;
  } catch {
    return null;
  }
}

/**
 * The `file` fingerprint of a Blob: its first and last window and its size.
 * `head`, when given, is a prefix the open already read; it is reused when it
 * covers the first window, so the only extra read is the tail slice.
 */
export async function fileSourceFingerprint(blob: Blob, head?: ArrayBuffer): Promise<string | null> {
  try {
    const size = blob.size;
    const headLen = Math.min(FILE_FINGERPRINT_WINDOW_BYTES, size);
    const first = head && head.byteLength >= headLen
      ? new Uint8Array(head, 0, headLen)
      : new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    const tailStart = Math.max(headLen, size - FILE_FINGERPRINT_WINDOW_BYTES);
    const last = tailStart < size
      ? new Uint8Array(await blob.slice(tailStart, size).arrayBuffer())
      : new Uint8Array(0);
    return await fingerprintParts('file', size, [first, last]);
  } catch {
    return null;
  }
}

