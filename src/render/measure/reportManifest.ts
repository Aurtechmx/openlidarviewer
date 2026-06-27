/**
 * reportManifest.ts
 *
 * The offline, signed report — the artifact a surveyor stakes their name on.
 *
 * "Story Mode" in a cloud viewer is a slideshow. Here it is a deterministic,
 * tamper-evident document that carries the things that actually matter forward:
 * every finding WITH its uncertainty band and caveats, the dataset provenance,
 * the classification edit epoch the numbers were computed at, and the edit audit
 * trail. The whole body is hashed into a signature, so anyone who receives the
 * report can {@link verifyReportManifest} it and prove no figure — no value, no
 * ± band, no caveat — was altered after it was signed.
 *
 * Deterministic by construction (canonical, key-sorted serialization), so the
 * same inputs always produce the same signature; two parties can confirm they
 * hold the identical report. The timestamp is supplied by the caller rather than
 * read from the clock, so the core stays pure and testable.
 *
 * Reuses the audit log's canonical hashing; the hash function is injectable
 * (FNV-1a default; inject SHA-256 for cryptographic signatures).
 */

import { canonicalize, fnv1a, type HashFn } from './auditLog';

export const REPORT_MANIFEST_VERSION = 1;

export interface ReportFinding {
  /** Human label, e.g. "Stockpile volume". */
  readonly label: string;
  /** The measured value. */
  readonly value: number;
  /** Unit, e.g. "m³" / "m²" / "m". */
  readonly unit: string;
  /** 1σ uncertainty band, if the measurement carries one. */
  readonly sigma?: number;
  /** Confidence tier, e.g. "high" | "medium" | "low". */
  readonly confidence?: string;
  /** Honesty notes attached to this finding. */
  readonly caveats?: readonly string[];
}

export interface ReportManifestInput {
  readonly dataset: {
    readonly id: string;
    readonly crs?: string;
    readonly pointCount?: number;
  };
  /** ISO timestamp, supplied by the caller (keeps the core deterministic). */
  readonly generatedAt: string;
  /** Every reported number, with its band and caveats. */
  readonly findings: readonly ReportFinding[];
  /**
   * The classification edit epoch the findings were computed at — provenance so
   * a later reader can tell whether the cloud was edited after this report.
   */
  readonly classificationEpoch?: number;
  /** The edit audit trail (hash-chained {@link AuditEntry} list), if any. */
  readonly edits?: readonly unknown[];
}

export interface ReportManifest extends ReportManifestInput {
  readonly version: number;
  /** Tamper-evident signature over the canonical manifest body. */
  readonly signature: string;
}

/** Assemble and sign a report manifest. */
export function buildReportManifest(
  input: ReportManifestInput,
  hashFn: HashFn = fnv1a,
): ReportManifest {
  const body = { version: REPORT_MANIFEST_VERSION, ...input };
  const signature = hashFn(canonicalize(body));
  return { ...body, signature };
}

/** Deterministic, canonical serialization for export / transmission. */
export function serializeReportManifest(manifest: ReportManifest): string {
  return canonicalize(manifest);
}

/**
 * Recompute the signature from the manifest body and confirm it matches —
 * returns false if any field was altered after signing.
 */
export function verifyReportManifest(
  manifest: ReportManifest,
  hashFn: HashFn = fnv1a,
): boolean {
  const { signature, ...body } = manifest;
  return hashFn(canonicalize(body)) === signature;
}
