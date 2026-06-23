/**
 * exportMemoryGuard.ts
 *
 * Full-resolution export re-decodes the original file from scratch: the whole
 * file is materialised as one ArrayBuffer AND expanded into typed attribute
 * arrays, so peak RAM is several times the file size. A user can load a strided
 * PREVIEW of a multi-GB scan fine, then crash the tab the instant they ask for
 * a full-resolution export. This pure assessor lets the UI confirm first.
 *
 * No DOM, no I/O — unit-tested in Node.
 */

/** File size above which a full-resolution re-decode warrants a confirm. */
export const FULL_EXPORT_CONFIRM_BYTES = 750 * 1024 * 1024; // 750 MiB

/**
 * Rough peak-RAM multiplier. The file buffer and the decoded float positions
 * plus per-point attributes coexist before the buffer is released, so ~3× the
 * file size is a conservative floor for the warning copy.
 */
const PEAK_MULTIPLIER = 3;

export interface FullExportMemoryAssessment {
  /** True when the export should confirm with the user before decoding. */
  readonly needsConfirm: boolean;
  /** Source file size in bytes (clamped to ≥ 0). */
  readonly fileBytes: number;
  /** Conservative lower-bound peak RAM for the decode (buffer + attributes). */
  readonly estimatedPeakBytes: number;
}

/** Assess whether a full-resolution re-decode of a file this size should ask
 *  the user to confirm first. */
export function assessFullExportMemory(fileBytes: number): FullExportMemoryAssessment {
  const bytes = Number.isFinite(fileBytes) && fileBytes > 0 ? fileBytes : 0;
  return {
    needsConfirm: bytes > FULL_EXPORT_CONFIRM_BYTES,
    fileBytes: bytes,
    estimatedPeakBytes: bytes * PEAK_MULTIPLIER,
  };
}
