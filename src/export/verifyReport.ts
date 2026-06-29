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
 * Pure: no DOM. The lazy `src/ui/reportVerifier.ts` dialog renders the result.
 */

import { verifyReportManifest, type ReportManifest } from '../render/measure/reportManifest';
import { fnv1a, sha256, type HashFn } from '../render/measure/auditLog';

export interface VerifyReportResult {
  /** The text parsed as JSON and looked like an integrity report. */
  readonly recognised: boolean;
  /** The digest recomputes to the stamped value — the report is intact. */
  readonly valid: boolean;
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
  return {
    recognised: true, valid, algorithm, software, classificationEpoch, findingsCount,
    reason: valid
      ? 'Report is intact — the digest matches its contents.'
      : 'Report has been modified, or the digest does not match its contents.',
  };
}
