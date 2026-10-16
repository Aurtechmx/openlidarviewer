/**
 * layerFingerprintKey.ts — the canonical key built from a layer's source
 * fingerprint, apart from the identity registry in `layerIdentity.ts`.
 *
 * Pure functions with no state. They live in their own module so the lazily
 * loaded session code (`io/sessionOwnership.ts`) can build the same key without
 * a static edge into the registry module the startup shell owns; that edge made
 * the bundler fold the shared lazy-feature chunks into the entry chunk.
 */

import type { LayerFingerprint } from './layerIdentity';

/** Round an extent span so trivial float formatting never splits one fingerprint. */
function normSpan(v: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  // 6 decimals is finer than any real survey extent needs and coarse enough to
  // absorb the last-bit noise of a recomputed bound.
  return v.toFixed(6);
}

/**
 * Build the canonical, order-stable key for a fingerprint. Filename is included
 * as a source fact — but because it rides alongside the content-distinguishing
 * fields (point count and extent spans), two different scans sharing a name
 * still key apart, and only genuinely identical source facts collide (which is
 * exactly the reopen-stability case).
 */
export function fingerprintKey(f: LayerFingerprint): string {
  const key = legacyFingerprintKey(f);
  const o = f.origin;
  const pos = o && o.every((c) => Number.isFinite(c)) ? o.map((c) => c.toFixed(3)).join(',') : '';
  const sha = (f.sha256 ?? '').trim().toLowerCase();
  if (!pos && !sha) return key;
  return [key, 'o', pos, sha].join('\0');
}

/** True when the fingerprint carries a position or a content digest. */
export function hasPlacementFacts(f: LayerFingerprint): boolean {
  return fingerprintKey(f) !== legacyFingerprintKey(f);
}

/**
 * The key built from the facts older session files stored: name, count, spans
 * and CRS, without position or digest. Used to match such a file, and only
 * where the match is unambiguous.
 */
export function legacyFingerprintKey(f: LayerFingerprint): string {
  return [
    'f',
    (f.fileName ?? '').trim(),
    typeof f.sourcePoints === 'number' && Number.isFinite(f.sourcePoints)
      ? String(f.sourcePoints)
      : '',
    normSpan(f.width),
    normSpan(f.depth),
    normSpan(f.height),
    typeof f.epsg === 'number' && Number.isFinite(f.epsg) ? String(f.epsg) : '',
    (f.crs ?? '').trim(),
  ].join('\0');
}

