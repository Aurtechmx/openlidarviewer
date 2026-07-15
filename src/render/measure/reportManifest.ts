/**
 * reportManifest.ts
 *
 * The offline integrity report — the artifact a surveyor hands over.
 *
 * "Story Mode" in a cloud viewer is a slideshow. Here it is a deterministic
 * document that carries the things that actually matter forward: every finding
 * WITH its uncertainty band and caveats, the dataset provenance, the
 * classification edit epoch the numbers were computed at, and the edit audit
 * trail. The whole body is hashed into a content DIGEST, so anyone who receives
 * the report can {@link verifyReportManifest} it and detect a figure — a value,
 * a ± band, a caveat — that was changed without recomputing the digest.
 *
 * Honesty note: the default digest is SHA-256 (v3) — a cryptographic-strength
 * content hash, computed synchronously (see `sha256` in auditLog.ts). It is
 * tamper-EVIDENT: change a number but not the digest and verification fails, and
 * forging a matching SHA-256 digest for altered content is computationally
 * infeasible. This holds ONLY for SHA-256 — the legacy FNV-1a digest is a fast,
 * forgeable checksum, so `verifyReport` never trusts the file-named algorithm to
 * downgrade the guarantee: an FNV-1a match is reported as "matches but not
 * tamper-proof", not "intact".
 * It is still NOT a secret-keyed signature — it proves integrity, not identity,
 * so it can't tell you WHO produced the report. The `digestAlgorithm` field
 * names the algorithm so the output is self-describing; a caller may inject the
 * older `fnv1a` checksum for a fast, non-cryptographic digest.
 *
 * Deterministic by construction (canonical, key-sorted serialization), so the
 * same inputs always produce the same digest; two parties can confirm they hold
 * the identical report. The timestamp is supplied by the caller rather than read
 * from the clock, so the core stays pure and testable.
 */

import { canonicalize, sha256, type HashFn } from './auditLog';

export const REPORT_MANIFEST_VERSION = 3;

/**
 * Default digest algorithm name stamped into the manifest (self-describing).
 * v3 promotes the default from FNV-1a to SHA-256 — a cryptographic-strength
 * content hash, still synchronous (see `sha256` in auditLog.ts). The digest is
 * deterministic, so verification is unchanged in shape; only the algorithm name
 * and the hash width differ. A caller may still inject `fnv1a` for the old
 * fast checksum.
 */
export const DEFAULT_DIGEST_ALGORITHM = 'SHA-256';

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
  /**
   * The producing app version (e.g. "0.5.2"), so a later reader can tell whether
   * a newer build would regenerate the report differently (see
   * `exportStaleness.ts`). Optional + additive: a manifest built without it
   * still verifies against its own digest. Covered by the digest once present.
   */
  readonly software?: string;
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
  /** Name of the digest algorithm (e.g. "FNV-1a-32"). Covered by the digest. */
  readonly digestAlgorithm: string;
  /**
   * Content digest over the canonical manifest body. Catches a figure changed
   * without recomputing the digest (accidental or casual edits). NOT a
   * secret-keyed signature — see the file header.
   */
  readonly digest: string;
}

/** Assemble a report manifest and stamp it with a content digest. */
export function buildReportManifest(
  input: ReportManifestInput,
  hashFn: HashFn = sha256,
  digestAlgorithm: string = DEFAULT_DIGEST_ALGORITHM,
): ReportManifest {
  // `digestAlgorithm` is inside the hashed body, so the named algorithm can't be
  // swapped without breaking verification.
  const body = { version: REPORT_MANIFEST_VERSION, digestAlgorithm, ...input };
  const digest = hashFn(canonicalize(body));
  return { ...body, digest };
}

/** Deterministic, canonical serialization for export / transmission. */
export function serializeReportManifest(manifest: ReportManifest): string {
  return canonicalize(manifest);
}

/**
 * Recompute the digest from the manifest body and confirm it matches — returns
 * false if any field was altered after the digest was stamped. Pass the same
 * hashFn that built the manifest (the default matches `DEFAULT_DIGEST_ALGORITHM`).
 */
export function verifyReportManifest(
  manifest: ReportManifest,
  hashFn: HashFn = sha256,
): boolean {
  const { digest, ...body } = manifest;
  return hashFn(canonicalize(body)) === digest;
}
