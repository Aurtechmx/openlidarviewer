/**
 * verifyReport.ts
 *
 * The read side of the integrity report: take a report JSON (the artifact a
 * surveyor hands over) and check that its digest still matches its contents.
 *
 * The manifest is self-describing — it names its own digest algorithm — so this
 * verifier picks the matching hash function (SHA-256 for v3+, the legacy FNV-1a
 * for older files) and recomputes the digest over the canonical body. A mismatch
 * means a value, a ± band, a caveat, or the classification epoch was changed
 * without recomputing the digest.
 *
 * What a match means: neither digest is keyed, so anyone who edits the body
 * can recompute a matching digest. A match catches accidental edits only; it
 * does not show who made the report, and `sourceSha256` is never compared
 * against a source file. `cryptographic` records whether the digest is SHA-256
 * or the legacy FNV-1a checksum, and an FNV-1a match is reported as a checksum
 * match, so the file-named algorithm cannot upgrade the wording.
 *
 * Pure: no DOM. The lazy `src/ui/reportVerifier.ts` dialog renders the result.
 */

import { verifyReportManifest, type ReportManifest } from '../render/measure/reportManifest';
import { canonicalize, fnv1a, sha256, type HashFn } from '../render/measure/auditLog';
import { REPORT_SIGNATURE_FIELD, trustedKeyIdFrom, verifyReportSignature, type SignatureVerdict } from './reportSignature';

export interface VerifyReportResult {
  /** The text parsed as JSON and looked like an integrity report. */
  readonly recognised: boolean;
  /** The digest recomputes to the stamped value: it matches the contents. */
  readonly valid: boolean;
  /**
   * The digest is SHA-256. When false, a `valid` match is a fast FNV-1a
   * checksum. Neither is keyed: a match means the digest agrees with the
   * contents, not that nobody edited them and recomputed it.
   */
  readonly cryptographic?: boolean;
  /** Named digest algorithm from the file, if present. */
  readonly algorithm?: string;
  /** Producing app version, if the file carries one (v0.5.2+). */
  readonly software?: string;
  /** Classification edit epoch the findings were computed at, if present. */
  readonly classificationEpoch?: number;
  /** Number of findings in the report. */
  readonly findingsCount?: number;
  /**
   * The signature check, present only when the report carries a signature
   * field. Unsigned reports leave it undefined and read as before.
   */
  readonly signature?: SignatureVerdict;
  /** A short, user-facing summary line. */
  readonly reason: string;
}

/** Map a self-described algorithm name to its hash function. */
function hashFnFor(algorithm: string): HashFn | null {
  if (algorithm === 'SHA-256') return sha256;
  if (algorithm === 'FNV-1a-32') return fnv1a;
  return null;
}

/**
 * Verify a report JSON string. Never throws — a malformed file returns a result
 * with `recognised: false` and a reason, so the caller can render it directly.
 */
export function verifyReportFile(jsonText: string): VerifyReportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { recognised: false, valid: false, reason: 'This file is not valid JSON.' };
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { digest?: unknown }).digest !== 'string' ||
    !Array.isArray((raw as { findings?: unknown }).findings)
  ) {
    return { recognised: false, valid: false, reason: 'This is not an OpenLiDARViewer integrity report.' };
  }
  const m = raw as ReportManifest & { software?: unknown; classificationEpoch?: unknown };
  const algorithm = typeof m.digestAlgorithm === 'string' ? m.digestAlgorithm : '';
  const software = typeof m.software === 'string' ? m.software : undefined;
  const classificationEpoch = typeof m.classificationEpoch === 'number' ? m.classificationEpoch : undefined;
  const findingsCount = m.findings.length;

  const hashFn = hashFnFor(algorithm);
  if (!hashFn) {
    return {
      recognised: true, valid: false, algorithm, software, classificationEpoch, findingsCount,
      reason: `Cannot verify: unknown digest algorithm "${algorithm || '(none)'}".`,
    };
  }

  const valid = verifyReportManifest(m, hashFn);
  // SHA-256 or FNV-1a, the digest is unkeyed: a match is a self-consistency
  // check, never proof of who made the report or which file it came from.
  const cryptographic = algorithm === 'SHA-256';
  let reason: string;
  if (!valid) {
    reason = 'Report has been modified, or the digest does not match its contents.';
  } else if (cryptographic) {
    reason = 'The SHA-256 digest matches the contents. This catches accidental edits, but anyone can recompute the digest after an edit, so it does not show who made the report or that it came from the named source file.';
  } else {
    reason = `The ${algorithm} checksum matches the contents. It is a weaker accidental-edit check than SHA-256: its 32-bit digest gives a much higher chance that a different body has the same checksum. Like any unkeyed digest, anyone can recompute it after an edit.`;
  }
  return {
    recognised: true, valid, cryptographic, algorithm, software, classificationEpoch, findingsCount,
    reason,
  };
}

/**
 * Verify a report, including its optional signature. An unsigned report returns
 * exactly what {@link verifyReportFile} returns. A report with a signature
 * field also gets a {@link SignatureVerdict}; a signature that does not verify,
 * is malformed or is unsupported makes the result invalid. `trustedKeyText` is
 * a public key (JSON) or key id the reader trusts, compared to the signer's.
 * Never throws.
 */
export async function verifyReportFileWithSignature(
  jsonText: string,
  trustedKeyText?: string,
): Promise<VerifyReportResult> {
  const base = verifyReportFile(jsonText);
  if (!base.recognised) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return base;
  }
  if (typeof raw !== 'object' || raw === null || !(REPORT_SIGNATURE_FIELD in raw)) return base;

  const wanted = trustedKeyText?.trim() ? trustedKeyText : undefined;
  const trustedId = wanted === undefined ? undefined : await trustedKeyIdFrom(wanted);
  let signature = await verifyReportSignature(raw, canonicalize, trustedId);
  if (wanted !== undefined && trustedId === null && signature.signatureValid) {
    signature = {
      ...signature,
      status: 'valid-unknown-signer',
      reason: 'The text you supplied is not a P-256 public key or key id, so the signer is still unverified.',
    };
  }
  if (!signature.signatureValid) {
    return {
      ...base,
      valid: false,
      signature,
      reason: base.valid
        ? `The report carries a signature that does not verify. ${signature.reason}`
        : base.reason,
    };
  }
  return { ...base, signature };
}
