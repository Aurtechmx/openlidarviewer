/**
 * verifyReport.ts
 *
 * The read side of the integrity report: take a report JSON (the artifact a
 * surveyor hands over) and confirm nobody altered a figure after it was stamped.
 *
 * The manifest is self-describing — it names its own digest algorithm — so this
 * verifier picks the matching hash function (SHA-256 for v3+, the legacy FNV-1a
 * for older files) and recomputes the digest over the canonical body. A mismatch
 * means a value, a ± band, a caveat, or the classification epoch was changed
 * without recomputing the digest.
 *
 * Tamper-evidence caveat: only the SHA-256 digest is CRYPTOGRAPHIC. The legacy
 * FNV-1a is a fast, forgeable checksum — an attacker who alters the body can set
 * `digestAlgorithm: "FNV-1a-32"` and recompute a matching FNV-1a digest, so an
 * FNV-1a match cannot prove tamper-evidence. `cryptographic` records which case
 * this is, and an FNV-1a match is reported as "matches but NOT tamper-proof"
 * rather than "intact", so the file-named algorithm can never silently downgrade
 * the integrity guarantee.
 *
 * Pure: no DOM. The lazy `src/ui/reportVerifier.ts` dialog renders the result.
 */

import { verifyReportManifest, type ReportManifest } from '../render/measure/reportManifest';
import { fnv1a, sha256, type HashFn } from '../render/measure/auditLog';

export interface VerifyReportResult {
  /** The text parsed as JSON and looked like an integrity report. */
  readonly recognised: boolean;
  /** The digest recomputes to the stamped value — the report is intact. */
  readonly valid: boolean;
  /**
   * The digest is a CRYPTOGRAPHIC hash (SHA-256). When false, a `valid` match is
   * a fast non-cryptographic checksum (FNV-1a) that an attacker can forge — it is
   * NOT tamper-evident. Only `valid && cryptographic` proves the report intact.
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
  // Only SHA-256 is cryptographic. An FNV-1a digest is a forgeable checksum, so
  // a match is NOT proof of tamper-evidence — never report it as "intact".
  const cryptographic = algorithm === 'SHA-256';
  return {
    recognised: true, valid, cryptographic, algorithm, software, classificationEpoch, findingsCount,
    reason: !valid
      ? 'Report has been modified, or the digest does not match its contents.'
      : cryptographic
        ? 'Report is intact — the SHA-256 digest matches its contents.'
        : `The ${algorithm} checksum matches, but it is a fast non-cryptographic checksum an editor can forge — this does NOT prove the report was not altered. Treat it as unverified for tamper-evidence.`,
  };
}
