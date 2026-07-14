/**
 * processingManifest.ts — the VERIFY-ONLY processing-provenance manifest.
 *
 * Every terrain export should carry one ordered, tamper-evident record of the
 * methods and parameters that produced it, so a reviewer holding only the
 * artifact can answer "what was run, in what order, with which settings — and
 * has this record been altered since?". That is the whole claim: a VERIFIABLE
 * manifest (ordering + parameters + tamper-evidence). It is deliberately NOT an
 * execution recipe — no executor exists that consumes it, and nothing here may
 * imply one. Verification proves the record is intact; it does not prove the
 * pipeline could be re-run from it.
 *
 * Mechanism: the same append-only hash-chain discipline as the measurement
 * audit log (whose pure primitives — {@link canonicalize} and {@link sha256} —
 * this module reuses rather than re-implementing). Each op's hash folds in the
 * previous hash plus a canonical (key-sorted, undefined-skipping) serialization
 * of the op's contents, so editing any op, reordering, or truncating the chain
 * breaks every hash from that point on, and {@link verifyProcessingManifest}
 * reports exactly where.
 *
 * The chain is seeded from the manifest ENVELOPE (schema version, build
 * identity, source name) rather than a bare constant: the record of "which
 * build processed which scan" is provenance too, and folding it into the
 * genesis means an edited `build` or `source` breaks verification at op 0 (or
 * at the head, for an op-free manifest) instead of passing silently.
 *
 * Deterministic by construction: no timestamps, no randomness — the same
 * inputs always produce the same chain and head, so two parties can
 * independently confirm they hold the same history.
 *
 * Pure data: no DOM, no three.js, no I/O. Safe to import from any layer.
 */

import { canonicalize, sha256 } from '../render/measure/auditLog';

/** The schema version of {@link ProcessingManifest}. Bump on shape change. */
export const PROCESSING_MANIFEST_SCHEMA = 1;

/**
 * A JSON-safe parameter value. Ops are serialized into export metadata and
 * session files verbatim, so anything that would not survive
 * `JSON.parse(JSON.stringify(...))` (Dates, NaN, functions, undefined array
 * holes) must never enter a params object — it would make the round-tripped
 * hash diverge from the built one.
 */
export type ManifestParamValue =
  | string
  | number
  | boolean
  | null
  | readonly ManifestParamValue[]
  | { readonly [key: string]: ManifestParamValue };

/** One processing step, as supplied by the assembler (no seq/hash yet). */
export interface ProcessingOpInput {
  /** Registered method at its version, e.g. `'olv.ground.smrf@1'`. */
  readonly method: string;
  /**
   * The final parameters the run used, as far as the assembling layer honestly
   * knows them. Empty when none were captured — never fabricated; pair an
   * empty object with a `note` saying so.
   */
  readonly params: Readonly<Record<string, ManifestParamValue>>;
  /** Honest caveat, e.g. `'params not captured in this slice'`. */
  readonly note?: string;
}

/** One chained op inside a built manifest. */
export interface ProcessingManifestOp extends ProcessingOpInput {
  /** Position in the chain, 0-based — the pipeline order. */
  readonly seq: number;
  /** Chain hash: sha256(prevHash + '|' + canonicalize({seq,method,params,note})). */
  readonly hash: string;
}

/** The ordered, hash-chained record of one run's processing steps. */
export interface ProcessingManifest {
  readonly schemaVersion: number;
  /** The build identity string that produced the artifact. */
  readonly build: string;
  /** Source scan basename, or null when not supplied. */
  readonly source: string | null;
  readonly ops: ReadonlyArray<ProcessingManifestOp>;
  /** The chain head — the last op's hash, or the envelope genesis when empty. */
  readonly head: string;
}

/** Inputs for {@link buildProcessingManifest}. */
export interface ProcessingManifestInput {
  readonly build: string;
  readonly source: string | null;
  readonly ops: ReadonlyArray<ProcessingOpInput>;
}

/** Result of {@link verifyProcessingManifest}. */
export interface ProcessingManifestVerification {
  readonly ok: boolean;
  /**
   * Index of the FIRST op whose seq or hash fails to recompute — the first
   * point of tampering or corruption. `ops.length` means every op verified but
   * the recorded `head` (or, equivalently, the envelope it covers on an
   * op-free manifest) does not match: a truncated chain or an edited head.
   * Omitted when `ok`.
   */
  readonly firstInvalid?: number;
}

/**
 * The same genesis sentinel the audit log uses, kept for cross-module
 * familiarity; here it seeds the ENVELOPE hash, which in turn seeds the chain.
 */
const GENESIS_SENTINEL = '0';

/**
 * The chain seed for a manifest envelope. Folding schema + build + source into
 * the seed makes the whole document tamper-evident, not just the op list — see
 * the module comment for why the envelope is provenance too.
 */
function envelopeGenesis(schemaVersion: number, build: string, source: string | null): string {
  return sha256(GENESIS_SENTINEL + '|' + canonicalize({ schemaVersion, build, source }));
}

/**
 * Fold one op onto the chain. `note` is passed through even when undefined:
 * `canonicalize` skips undefined-valued keys (matching `JSON.stringify`), so a
 * note-free op hashes identically before and after the serialize → parse round
 * trip every export performs — without this, a manifest written to a file
 * would fail to verify when read back.
 */
function foldOp(prevHash: string, seq: number, op: ProcessingOpInput): string {
  return sha256(
    prevHash + '|' + canonicalize({ seq, method: op.method, params: op.params, note: op.note }),
  );
}

/**
 * Build the manifest: assign each op its 0-based `seq` in the given order and
 * chain the hashes from the envelope genesis. Deterministic — same inputs,
 * same head.
 */
export function buildProcessingManifest(input: ProcessingManifestInput): ProcessingManifest {
  let prev = envelopeGenesis(PROCESSING_MANIFEST_SCHEMA, input.build, input.source);
  const ops: ProcessingManifestOp[] = input.ops.map((op, seq) => {
    const hash = foldOp(prev, seq, op);
    prev = hash;
    // The optional note is only materialised when present so the built object
    // is byte-shaped exactly like its JSON round trip (no `note: undefined`
    // key to differ on in deep-equality assertions or serialized output).
    return {
      seq,
      method: op.method,
      params: op.params,
      ...(op.note !== undefined ? { note: op.note } : {}),
      hash,
    };
  });
  return {
    schemaVersion: PROCESSING_MANIFEST_SCHEMA,
    build: input.build,
    source: input.source,
    ops,
    head: prev,
  };
}

/**
 * Recompute the whole chain — envelope genesis, every op fold, and the head —
 * and report whether the manifest is intact. On failure, `firstInvalid` is the
 * index of the first op that does not recompute (an edited envelope therefore
 * surfaces at index 0, because the genesis it seeds no longer matches), or
 * `ops.length` when the ops all verify but the recorded head does not.
 */
export function verifyProcessingManifest(
  manifest: ProcessingManifest,
): ProcessingManifestVerification {
  let prev = envelopeGenesis(manifest.schemaVersion, manifest.build, manifest.source);
  for (let i = 0; i < manifest.ops.length; i++) {
    const op = manifest.ops[i];
    if (op.seq !== i) return { ok: false, firstInvalid: i };
    if (foldOp(prev, op.seq, op) !== op.hash) return { ok: false, firstInvalid: i };
    prev = op.hash;
  }
  if (manifest.head !== prev) return { ok: false, firstInvalid: manifest.ops.length };
  return { ok: true };
}
