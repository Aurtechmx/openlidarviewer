/**
 * artifacts.ts
 *
 * Canonical, machine-independent hashes for the scientific artifacts a suite
 * produces.
 *
 * The hash exists so a reviewer can say "I regenerated this and got the same
 * artifact". That claim only survives if the hash ignores the three things that
 * differ between two honest runs of the same code:
 *
 *   1. wall-clock timestamps — a `generatedAt` field alone makes every run
 *      unique, so the hash would never match and the check becomes decoration;
 *   2. absolute filesystem paths — `/Users/alice/checkout/...` versus
 *      `/home/runner/work/...` is the reviewer's disk, not the science;
 *   3. machine identifiers — hostname, username, pid.
 *
 * Everything else is in. Durations are deliberately NOT stripped: a timing IS
 * the measurement in a benchmark, and a strip list broad enough to swallow it
 * would let a real regression pass as "same artifact".
 *
 * The rules are exported as `VOLATILE_RULES` — each with the category it serves
 * and why it is excluded — so a reviewer can audit the exclusions without
 * reading this file, and `ArtifactRecord.strippedFields` names what was actually
 * removed from the artifact in hand.
 *
 * Hashing itself is reused, never reinvented: `canonicalJson`/`fnv1a` from
 * `src/canonicalHash.ts` and `sha256Hex` from `src/terrain/export/sha256.ts`.
 * Nothing in this path reads a clock or a random source.
 */

import { canonicalJson, fnv1a } from '../../src/canonicalHash';
import { sha256Hex } from '../../src/terrain/export/sha256';
import type { ArtifactRecord } from './types';

/** What a rule protects the hash against. */
export type VolatileKind = 'timestamp' | 'absolute-path' | 'machine-id';

export interface VolatileRule {
  readonly kind: VolatileKind;
  /** 'key' rules DROP the field; 'value' rules REDACT the string in place. */
  readonly appliesTo: 'key' | 'value';
  readonly pattern: RegExp;
  /** Why this is excluded — quoted verbatim when a reviewer asks. */
  readonly why: string;
}

/** What a redacted absolute path becomes before hashing. */
export const VOLATILE_PLACEHOLDER = '<stripped:absolute-path>';

/**
 * The complete strip list. Deliberately narrow and name-anchored: each key
 * pattern is anchored at both ends so a field like `durationMs` or `datasetId`
 * can never be swept up by a substring match.
 */
export const VOLATILE_RULES: readonly VolatileRule[] = [
  {
    kind: 'timestamp',
    appliesTo: 'key',
    pattern:
      /^(timestamps?|generated_?at|created_?at|updated_?at|modified_?at|started_?at|finished_?at|completed_?at|captured_?at|built_?at|ran_?at|run_?at|wall_?clock(_?(ms|time))?|date_?time|iso_?date|epoch_?ms)$/i,
    why: 'A wall-clock reading differs on every run, so leaving it in guarantees two identical artifacts hash differently and the reproducibility check never passes.',
  },
  {
    kind: 'machine-id',
    appliesTo: 'key',
    pattern:
      /^(host|host_?name|machine|machine_?id|node_?name|computer_?name|user|user_?name|user_?info|home_?dir|tmp_?dir|temp_?dir|uid|gid|pid|ppid|process_?id|mac_?address|serial(_?number)?|device_?id|session_?id|ip(_?address)?|network_?interfaces)$/i,
    why: 'Identifies the machine or process that happened to run the suite, which says nothing about the artifact and differs between a laptop and a CI runner.',
  },
  {
    kind: 'absolute-path',
    appliesTo: 'value',
    pattern: /^(\/[^/]|\/$|[A-Za-z]:[\\/]|\\\\|file:\/\/)/,
    why: 'An absolute path encodes the reviewer’s checkout location, so the same dataset hashes differently on every machine. Matched on the VALUE, not the key, so a repo-relative path stays part of the artifact identity.',
  },
];

const KEY_RULES = VOLATILE_RULES.filter((r) => r.appliesTo === 'key');
const VALUE_RULES = VOLATILE_RULES.filter((r) => r.appliesTo === 'value');

export interface StripResult {
  /** A stripped COPY. The input is never mutated. */
  readonly value: unknown;
  /** Dotted paths that were dropped or redacted, de-duplicated and sorted. */
  readonly stripped: readonly string[];
}

/**
 * Return a copy of `input` with every volatile field removed or redacted.
 *
 * Dropping a key rather than nulling it keeps the canonical form identical for
 * an artifact that never had the field and one where it was stripped — which is
 * the point: both describe the same science.
 */
export function stripVolatile(input: unknown): StripResult {
  const stripped = new Set<string>();

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (VALUE_RULES.some((r) => r.pattern.test(value))) {
        stripped.add(path === '' ? '(root)' : path);
        return VOLATILE_PLACEHOLDER;
      }
      return value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const child = path === '' ? key : `${path}.${key}`;
      if (KEY_RULES.some((r) => r.pattern.test(key))) {
        stripped.add(child);
        continue;
      }
      out[key] = walk(v, child);
    }
    return out;
  };

  return { value: walk(input, ''), stripped: [...stripped].sort() };
}

/** Byte artifacts are opaque: nothing inside them can be inspected or stripped. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Hash a named artifact.
 *
 * Byte artifacts hash as-is (SHA-256 over the raw bytes). Everything else is
 * stripped, canonicalised with sorted keys — so a re-ordered but identical
 * object hashes the same — and hashed as UTF-8.
 */
export function hashArtifact(name: string, value: unknown): ArtifactRecord {
  const bytes = asBytes(value);
  if (bytes !== null) {
    const hash = sha256Hex(bytes);
    return {
      name,
      kind: 'bytes',
      algorithm: 'sha256',
      hash,
      // Derived from the digest rather than the payload: a short id for tables,
      // with no second pass over what may be megabytes of raster or point data.
      fingerprint: fnv1a(hash),
      byteLength: bytes.length,
      strippedFields: [],
    };
  }

  const { value: clean, stripped } = stripVolatile(value);
  const json = canonicalJson(clean);
  const encoded = new TextEncoder().encode(json);
  return {
    name,
    kind: 'json',
    algorithm: 'sha256',
    hash: sha256Hex(encoded),
    // Equivalent to `canonicalHash(clean)`, without canonicalising twice.
    fingerprint: fnv1a(json),
    byteLength: encoded.length,
    strippedFields: stripped,
  };
}
