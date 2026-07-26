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
 * An ISO-8601 date-TIME, with or without seconds, milliseconds or an offset.
 *
 * A time component is REQUIRED. A bare `2026-07-25` is as likely to be a dataset
 * epoch label or a survey date — part of the artifact's identity — as it is a
 * run timestamp, and stripping it would make two different datasets hash the
 * same. A field that really does hold a wall-clock date should be named one
 * (`date`, `buildDate`), which the key rule then catches.
 */
const ISO_8601_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The complete strip list. Deliberately narrow and name-anchored: each key
 * pattern is anchored at both ends so a field like `durationMs` or `datasetId`
 * can never be swept up by a substring match.
 *
 * The principle that governs every edit to this list: the two mistakes are not
 * symmetric. An UNDER-strip fails safely — two honest runs hash differently, the
 * check goes red, a human looks. An OVER-strip fails dangerously — two genuinely
 * different artifacts hash the same, the framework asserts a reproducibility
 * that does not hold, and once that number is a figure in a paper it cannot be
 * taken back. So when a name is ambiguous, prefer to keep it in the hash; and
 * when it is ambiguous enough that neither choice is defensible, refuse it
 * outright (see AMBIGUOUS_CLOCK_KEYS) rather than decide silently.
 */
export const VOLATILE_RULES: readonly VolatileRule[] = [
  {
    kind: 'timestamp',
    appliesTo: 'key',
    pattern:
      /^(timestamps?|generated_?at|created_?at|updated_?at|modified_?at|started_?at|finished_?at|completed_?at|captured_?at|built_?at|ran_?at|run_?at|wall_?clock(_?(ms|time))?|dates?|date_?stamp|date_?time|iso_?date|build_?date|run_?date|create_?date|time|now|when|start_?time|end_?time|stop_?time|finish_?time|create_?time|modify_?time|[acm]time|birth_?time|epoch_?ms|epoch_(s|sec|secs|seconds)|epoch_?sec(onds)?|unix_?time|utc|local_?time|clock_?time)$/i,
    why: 'A wall-clock reading differs on every run, so leaving it in guarantees two identical artifacts hash differently and the reproducibility check never passes. Three names are pointedly NOT here: bare `epoch` and plural `epochs` (a survey campaign in this codebase — see alignEpochs/EpochCloud — not a clock), and plural `times` (most often an array of durations). The unit-suffixed forms `epochMs`/`epoch_seconds` ARE matched, which is why the alternation spells them out instead of writing `epoch_?(ms|s)` — that shorthand also swallowed `epochs`. A duration must be named with its unit: `durationMs`, `elapsedMs`.',
  },
  {
    kind: 'timestamp',
    appliesTo: 'value',
    pattern: ISO_8601_DATETIME,
    why: 'Symmetric with the absolute-path rule: an ISO-8601 date-time is a wall-clock reading because of what it IS, not because of the name it was given, so it is caught under any key. Bare calendar dates are excluded (see ISO_8601_DATETIME), on the asymmetry above: missing one costs a loud, investigable hash mismatch, while stripping a survey date would make two different datasets hash the same.',
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
    why: 'An absolute path encodes the reviewer’s checkout location, so the same dataset hashes differently on every machine. Matched on the VALUE, not the key, so a repo-relative path stays part of the artifact identity. Only the DIRECTORY PREFIX is redacted: the basename is retained, because machine-specificity never lives in the filename and collapsing every path to one placeholder made a run over tileA.laz and a run over tileB.laz hash identically.',
  },
];

/**
 * How deep an artifact may nest before the guard gives up.
 *
 * A stated limit beats a stack overflow: 512 is far past any real metrics
 * document, and a structure deeper than that is a bug the author needs told
 * about in words rather than a `RangeError` with no path in it.
 */
export const MAX_ARTIFACT_DEPTH = 512;

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
/**
 * Redact the machine-specific part of an absolute path, keeping the filename.
 *
 * The directory prefix is the reviewer's disk; the basename is the artifact's
 * identity. Retaining it is what keeps two runs over different tiles in the same
 * folder from collapsing onto one hash.
 */
function redactPath(value: string): string {
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return `${VOLATILE_PLACEHOLDER}/${cut < 0 ? value : value.slice(cut + 1)}`;
}

/** Shared by both traversals so a cycle reads the same wherever it is found. */
function cycleError(path: string, seenAt: string): TypeError {
  const where = path === '' ? 'the artifact root' : path;
  return new TypeError(
    `benchmark artifact: ${where} is part of a reference cycle (already seen at ${seenAt}). ` +
      'A hash needs a finite document; break the cycle or omit the back-reference.',
  );
}

function depthError(path: string): TypeError {
  return new TypeError(
    `benchmark artifact: ${path} is nested deeper than ${MAX_ARTIFACT_DEPTH} levels, ` +
      'which is past anything a metrics document should need.',
  );
}

export function stripVolatile(input: unknown): StripResult {
  const stripped = new Set<string>();
  // Ancestors only, not everything seen: a sub-object referenced twice in
  // different branches is legal JSON input, and only a repeat on the path from
  // the root is an actual cycle.
  const ancestors = new Map<object, string>();

  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value === 'string') {
      const rule = VALUE_RULES.find((r) => r.pattern.test(value));
      if (rule === undefined) return value;
      stripped.add(path === '' ? '(root)' : path);
      return rule.kind === 'absolute-path' ? redactPath(value) : VOLATILE_PLACEHOLDER;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_ARTIFACT_DEPTH) throw depthError(path === '' ? 'the artifact root' : path);
    const seenAt = ancestors.get(value);
    if (seenAt !== undefined) throw cycleError(path, seenAt === '' ? 'the artifact root' : seenAt);
    ancestors.set(value, path);

    let out: unknown;
    if (Array.isArray(value)) {
      // `Array.from`, not `.map`: map SKIPS holes, so a sparse array kept its
      // holes and canonicalised to `[,,1]` — not parseable JSON, and a
      // different hash from the identical document `[null,null,1]`.
      out = Array.from(value, (v, i) => (v === undefined ? null : walk(v, `${path}[${i}]`, depth + 1)));
    } else {
      // `Object.create(null)`, not `{}`: assigning to `out['__proto__']` on a
      // plain literal hits Object.prototype's setter and RE-PARENTS the object
      // instead of creating an own property, so the key silently vanished from
      // the hash. canonicalJson reads own keys only, so a null-prototype bag
      // flows through it unchanged.
      const bag = Object.create(null) as Record<string, unknown>;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const child = path === '' ? key : `${path}.${key}`;
        if (KEY_RULES.some((r) => r.pattern.test(key))) {
          stripped.add(child);
          continue;
        }
        // An undefined property is dropped rather than emitted, again matching
        // JSON.stringify: `{ error: undefined }` is what spreading an optional
        // field produces, so it must not be an error, and it must not corrupt
        // the canonical form. Not recorded as a stripped field — nothing was
        // excluded that JSON would have carried.
        if (v === undefined) continue;
        bag[key] = walk(v, child, depth + 1);
      }
      out = bag;
    }

    ancestors.delete(value);
    return out;
  };

  return { value: walk(input, '', 0), stripped: [...stripped].sort() };
}

/** Byte artifacts are opaque: nothing inside them can be inspected or stripped. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Recorded on every byte artifact, because the strip genuinely cannot run there
 * and an empty exclusion list would otherwise read as "nothing volatile here".
 */
export const RAW_BYTES_NO_STRIP_REASON =
  'hashed raw: a byte artifact is opaque, so embedded timestamps (PNG tEXt, GeoTIFF tags, zip entry mtimes) cannot be detected or removed and may change the hash between otherwise identical runs';

/**
 * Measured throughput of the bundled portable digest: ~40 MiB/s (8 MiB in
 * ~184 ms), plus one full padded copy of the payload. That is fine for the
 * KB-to-MB documents this framework was written for and a cliff for a 500 MB
 * raster, which is why `hashArtifact` takes an injectable digest and the Node
 * entry point supplies `node:crypto`. See `HashArtifactOptions.digest`.
 */
export const PORTABLE_DIGEST_MIB_PER_SEC = 40;

/**
 * Field names that could equally hold a measurement or a clock reading.
 *
 * Both possible answers are wrong in a way the author cannot see: strip them and
 * a duration named `time` silently leaves the hash; keep them and a wall-clock
 * reading silently defeats reproducibility. The framework does not get to pick,
 * so `assertHashable` refuses the name and asks for one that says which it is.
 *
 * They stay on the strip list above as well, so `stripVolatile` used on its own
 * still removes them — the guard is the loud path, the rule is the backstop.
 */
export const AMBIGUOUS_CLOCK_KEYS = ['time', 'now', 'when', 'utc'] as const;

const AMBIGUOUS_KEY_SET: ReadonlySet<string> = new Set(AMBIGUOUS_CLOCK_KEYS);

/** Name the type of a value in an error a suite author can act on. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? 'object with an unexpected prototype';
}

/** A plain `{}` or an `Object.create(null)` bag — the only objects JSON preserves. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Reject anything `canonicalJson` cannot represent faithfully, naming the path.
 *
 * Without this the hash silently stops discriminating: `canonicalJson` walks own
 * enumerable keys, so `new Date(0)` and `new Date(999)` both canonicalise to
 * `{}`, `new Map([['a',1]])` and `new Map([['a',2]])` likewise, and `NaN`,
 * `Infinity` and `-Infinity` all become `null`. Each of those is a real value
 * change that leaves the digest untouched — the exact failure the sensitivity
 * requirement exists to catch, and one that is invisible at the call site.
 *
 * Throwing beats coercing: a suite author who wrote a Date meant something by
 * it, and the framework does not get to decide which of its fields survived.
 */
export function assertHashable(
  artifactName: string,
  value: unknown,
  path = '',
  ancestors: Map<object, string> = new Map(),
  depth = 0,
): void {
  const where = path === '' ? 'the artifact root' : path;
  const fail = (problem: string): never => {
    throw new TypeError(
      `benchmark artifact "${artifactName}": ${where} ${problem}. ` +
        'Convert it to a JSON primitive (a number, a string, or a plain object) before hashing.',
    );
  };

  if (value === undefined) {
    // Only at the root. A nested `{ error: undefined }` is what spreading an
    // optional field produces and is dropped later, exactly as JSON does — but
    // an undefined ROOT has no JSON form at all, and used to reach fnv1a and
    // die there on `s.length` instead of saying anything useful.
    if (path === '') fail('is undefined, which has no JSON representation');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`is ${String(value)}, which is not finite and canonicalises to null`);
    return;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    fail(`is a ${typeof value}, which canonicalJson cannot represent`);
  }
  if (value === null || typeof value !== 'object') return;

  if (depth > MAX_ARTIFACT_DEPTH) throw depthError(where);
  const seenAt = ancestors.get(value);
  if (seenAt !== undefined) throw cycleError(path, seenAt === '' ? 'the artifact root' : seenAt);
  ancestors.set(value, path);

  if (Array.isArray(value)) {
    // An index loop, not `forEach`: forEach skips holes, so a sparse array's
    // elements were never checked at all.
    for (let i = 0; i < value.length; i++) {
      assertHashable(artifactName, value[i], `${path}[${i}]`, ancestors, depth + 1);
    }
    ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    fail(
      `is a ${describeType(value)}: canonicalJson keeps own enumerable keys only, so a Date or ` +
        'a Map becomes {} while a typed array becomes an index-keyed object — use Array.from(…) ' +
        'for a typed array, or pass the bytes themselves as a Uint8Array artifact',
    );
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const child = path === '' ? key : `${path}.${key}`;
    if (AMBIGUOUS_KEY_SET.has(key.toLowerCase())) {
      throw new TypeError(
        `benchmark artifact "${artifactName}": ${child} is named "${key}", which could be a ` +
          'measurement or a clock reading, and the framework will not guess. Rename it: ' +
          '`durationMs` (or another unit-suffixed name) if it is a measurement that must ' +
          'affect the hash, `capturedAt` if it is a wall-clock reading that must not. ' +
          'If the key comes from data you do not control, map it before hashing.',
      );
    }
    assertHashable(artifactName, v, child, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** A SHA-256 implementation, injectable so the fast Node one stays optional. */
export type DigestFn = (bytes: Uint8Array) => string;

export interface HashArtifactOptions {
  /**
   * SHA-256 over raw bytes. Defaults to the project's portable implementation.
   *
   * The bundled `sha256Hex` runs at roughly 40 MiB/s and copies the payload into
   * a padded buffer, so a 500 MB raster costs about twelve seconds and half a
   * gigabyte of transient memory — and inside a stage, that copy lands in the
   * stage's own `peakMemory`. Node callers should pass `nodeSha256Hex` from the
   * Node entry point; the digest is bit-identical, so nothing about
   * reproducibility depends on which one ran.
   */
  readonly digest?: DigestFn;
}

/**
 * Hash a named artifact.
 *
 * Byte artifacts hash as-is (SHA-256 over the raw bytes). Everything else is
 * stripped, canonicalised with sorted keys — so a re-ordered but identical
 * object hashes the same — and hashed as UTF-8.
 */
export function hashArtifact(
  name: string,
  value: unknown,
  options: HashArtifactOptions = {},
): ArtifactRecord {
  // An unnamed artifact cannot be found again in a report, matching the same
  // refusal `measured`, `unavailable` and `capturedEnv` already make.
  if (name.trim() === '') throw new Error('benchmark artifact: name must not be empty');
  const digest = options.digest ?? sha256Hex;

  const bytes = asBytes(value);
  if (bytes !== null) {
    const hash = digest(bytes);
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
      // Stated on the RECORD, not just in a comment: a reader comparing two
      // byte-artifact hashes has to know the strip never ran on them.
      volatilityStripped: false,
      unstrippedReason: RAW_BYTES_NO_STRIP_REASON,
    };
  }

  // Before the strip, not after: a Date survives `stripVolatile` as an empty
  // object, so a guard on the stripped copy would never see it.
  assertHashable(name, value);
  const { value: clean, stripped } = stripVolatile(value);
  const json = canonicalJson(clean);
  const encoded = new TextEncoder().encode(json);
  return {
    name,
    kind: 'json',
    algorithm: 'sha256',
    hash: digest(encoded),
    // Equivalent to `canonicalHash(clean)`, without canonicalising twice.
    fingerprint: fnv1a(json),
    byteLength: encoded.length,
    strippedFields: stripped,
    volatilityStripped: true,
  };
}

/** What a non-finite number becomes when an artifact is converted for hashing. */
export type NonFiniteLabel = 'NaN' | 'Infinity' | '-Infinity';

/** Anything `canonicalJson` can represent faithfully. */
export type Hashable = string | number | boolean | null | Hashable[] | { [key: string]: Hashable };

/**
 * Convert a producer's output into something `hashArtifact` accepts.
 *
 * `assertHashable` states what a hashable artifact may contain; this is the
 * companion that gets a real pipeline product there, and it lives beside those
 * rules so the two cannot drift. Two deliberate conversions:
 *
 *   - TYPED ARRAYS become plain arrays. `canonicalJson` keeps own enumerable
 *     keys, so a Float32Array would canonicalise to an index-keyed object that
 *     still hashes but no longer reads as data. (For a large grid, prefer
 *     hashing the raw bytes: this path costs three full copies of the values.)
 *   - NON-FINITE NUMBERS become their name as a string. NaN is how a raster
 *     says "no data here", and `JSON.stringify(NaN)` is `null` — which is
 *     indistinguishable from a field that genuinely held null, and makes NaN,
 *     +Infinity and -Infinity all hash the same. Naming them keeps the three
 *     apart and keeps the absence explicit.
 *
 * Anything else JSON cannot carry (a Date, a Map, a class instance) throws
 * rather than being flattened, for the same reason `assertHashable` throws: a
 * silent flattening is a hash that quietly stopped discriminating.
 */
export function toHashable(value: unknown, path = 'artifact'): Hashable {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as string | boolean;
  if (t === 'number') return finiteOrLabel(value as number);
  if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
    throw new TypeError(`benchmark artifact: ${path} is a ${t}, which has no JSON form`);
  }
  if (Array.isArray(value)) return value.map((v, i) => toHashable(v, `${path}[${i}]`));
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as unknown as ArrayLike<number>;
    const out: Hashable[] = new Array<Hashable>(view.length);
    for (let i = 0; i < view.length; i++) out[i] = finiteOrLabel(view[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(value as object) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `benchmark artifact: ${path} is a ${describeType(value)}, which JSON cannot carry faithfully`,
    );
  }
  const out: Record<string, Hashable> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // An absent optional field and one explicitly set to undefined describe the
    // same thing, and JSON drops both — mirroring that here keeps the two from
    // hashing differently.
    if (v === undefined) continue;
    out[key] = toHashable(v, `${path}.${key}`);
  }
  return out;
}

function finiteOrLabel(n: number): number | NonFiniteLabel {
  if (Number.isFinite(n)) return n;
  if (Number.isNaN(n)) return 'NaN';
  return n > 0 ? 'Infinity' : '-Infinity';
}
