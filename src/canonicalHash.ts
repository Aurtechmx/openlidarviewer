/**
 * canonicalHash.ts
 *
 * Deterministic JSON canonicalisation + a stable 32-bit FNV-1a string hash.
 * Shared by the scientific-analysis record fingerprint and the Contour Studio
 * state hash so both produce identical, reproducible digests from the same
 * logical content. Zero dependencies — safe to import from any layer.
 */

/** Deterministic JSON with sorted object keys, so a fingerprint is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit over a UTF-16 code-unit stream, as an 8-hex-digit string. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids Math.imul overflow concerns).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Canonicalise then hash — the stable content fingerprint of a value. */
export function canonicalHash(value: unknown): string {
  return fnv1a(canonicalJson(value));
}
