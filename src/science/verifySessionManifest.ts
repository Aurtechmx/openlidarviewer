/**
 * verifySessionManifest.ts — turn a session's opaque processing manifest into a
 * user-facing integrity verdict on IMPORT.
 *
 * The session layer carries `processingManifest` as an opaque passthrough: it is
 * size-bounded and copied verbatim, never interpreted. On import we want to tell
 * the reader whether that embedded provenance record is intact, WITHOUT ever
 * letting the answer reject the session. A hand-edited, legacy, or corrupt
 * manifest must never block restoring measurements — it only changes one line of
 * disclosure. So this function is pure, total, and defensive: it shape-checks the
 * unknown value, only runs {@link verifyProcessingManifest} against a manifest
 * that matches the recognized schema, and treats anything it does not recognize
 * (or any thrown error) as `legacy` rather than a failure.
 *
 * Verdicts:
 *  - `absent`   — no manifest present (nothing to say).
 *  - `verified` — recognized schema and the hash chain recomputes (ok).
 *  - `failed`   — recognized schema but the chain does not verify (tampering or
 *                 corruption); `firstInvalidSeq` locates the first bad op.
 *  - `legacy`   — a manifest is present but does not match the recognized schema
 *                 (an older/foreign shape we can neither verify nor trust).
 */

import {
  PROCESSING_MANIFEST_SCHEMA,
  verifyProcessingManifest,
  type ProcessingManifest,
  type ProcessingManifestOp,
} from './processingManifest';

/** The integrity verdict for a session's embedded processing manifest. */
export type SessionManifestVerdict =
  | { readonly status: 'absent' }
  | { readonly status: 'verified'; readonly ops: number; readonly head: string }
  | { readonly status: 'failed'; readonly firstInvalidSeq?: number }
  | { readonly status: 'legacy' };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Defensive shape check: does the unknown value match the manifest schema this
 * build recognizes closely enough to hand to {@link verifyProcessingManifest}?
 * Only structure and the schema version are checked here — the hash chain (the
 * real integrity claim) is left to the verifier. A `false` here means `legacy`,
 * never `failed`: we make no accusation about a shape we do not recognize.
 */
function matchesRecognizedSchema(v: unknown): v is ProcessingManifest {
  if (!isPlainObject(v)) return false;
  if (v.schemaVersion !== PROCESSING_MANIFEST_SCHEMA) return false;
  if (typeof v.build !== 'string') return false;
  if (!(v.source === null || typeof v.source === 'string')) return false;
  if (typeof v.head !== 'string') return false;
  if (!Array.isArray(v.ops)) return false;
  return v.ops.every((op: unknown) => {
    if (!isPlainObject(op)) return false;
    const o = op as Partial<ProcessingManifestOp>;
    if (typeof o.seq !== 'number') return false;
    if (typeof o.method !== 'string') return false;
    if (!isPlainObject(o.params)) return false;
    if (typeof o.hash !== 'string') return false;
    if (o.note !== undefined && typeof o.note !== 'string') return false;
    return true;
  });
}

/**
 * Compute the import-time integrity verdict for a parsed session's
 * `processingManifest`. NEVER throws; NEVER used to reject a session — the
 * caller only turns this into one line of disclosure.
 */
export function verifySessionManifest(manifest: unknown): SessionManifestVerdict {
  try {
    if (manifest == null) return { status: 'absent' };
    if (!matchesRecognizedSchema(manifest)) return { status: 'legacy' };
    const result = verifyProcessingManifest(manifest);
    if (result.ok) return { status: 'verified', ops: manifest.ops.length, head: manifest.head };
    return result.firstInvalid !== undefined
      ? { status: 'failed', firstInvalidSeq: result.firstInvalid }
      : { status: 'failed' };
  } catch {
    return { status: 'legacy' };
  }
}

/**
 * The short disclosure line for a verdict, or null when there is nothing to say
 * (an absent manifest). Kept beside the verdict so the import path stays a thin
 * call.
 */
export function sessionManifestNote(verdict: SessionManifestVerdict): string | null {
  switch (verdict.status) {
    case 'absent':
      return null;
    case 'verified':
      return `Analysis history: integrity verified (${verdict.ops} operation${verdict.ops === 1 ? '' : 's'}).`;
    case 'failed':
      return '⚠ Analysis history integrity check failed.';
    case 'legacy':
      return 'Analysis history: legacy manifest (not verified).';
  }
}
