/**
 * canonicalHash.ts
 *
 * Deterministic JSON canonicalisation + a stable 32-bit FNV-1a string hash.
 * Shared by the scientific-analysis record fingerprint and the Contour Studio
 * state hash so both produce identical, reproducible digests from the same
 * logical content. Zero dependencies — safe to import from any layer.
 *
 * `compareCodeUnits` lives here because ordering is half of canonicalisation:
 * a digest is only reproducible if the keys that feed it are ordered the same
 * way on every host. It is the TypeScript counterpart of
 * `scripts/lib/codeUnitOrder.mjs`, which serves the build and verification
 * scripts.
 */

/**
 * UTF-16 code-unit order. Locale-independent, so a committed order is stable.
 *
 * Static analysis flags `.sort()` without a comparator and suggests
 * `String.localeCompare`. That advice is wrong for every ordering that reaches
 * a digest or a committed record. `localeCompare` orders by collation, which
 * depends on the runtime locale and on the ICU build behind it, so
 * darwin-arm64 and linux-x64 can order the same keys differently and the same
 * content then hashes to two values. Code-unit order is fixed by the language
 * spec and identical on every host. It is the order a default `.sort()` on
 * strings already produces, written out so the ordering is stated in the code.
 *
 * This comparator is for strings. Numeric arrays need `(a, b) => a - b`.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Deterministic JSON with sorted object keys, so a fingerprint is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
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
