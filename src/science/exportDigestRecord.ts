/**
 * exportDigestRecord.ts: the three digest-and-origin fields every provenance-
 * carrying export records:
 *
 *   sourceSha256         SHA-256 of the original source file bytes, or null
 *                        with the reason in sourceSha256Note. A streamed
 *                        source records "not available for streamed sources".
 *                        Never a stand-in value.
 *   analysisInputSha256  SHA-256 over the exact points an analysis read
 *                        (`pointsSha256`), for exports that come from one.
 *   crsOrigin            where the CRS came from (`crsOrigin.ts`).
 *
 * Pure data: no DOM, no I/O. `export/exportDigests.ts` resolves the source
 * digest.
 */
import { crsOriginLine, crsOriginOf, type CrsOriginInput, type CrsOriginRecord } from './crsOrigin';

export const STREAMED_SOURCE_NOTE = 'not available for streamed sources';
export const SOURCE_NOT_HELD_NOTE = 'not available: the original file bytes are not held';
export const SOURCE_NOT_COMPUTED_NOTE = 'not computed: the source file could not be read in full';
export const SOURCE_NOT_SUPPLIED_NOTE = 'not recorded by this export path';
export const NO_ANALYSIS_NOTE = 'not applicable: this export does not come from an analysis';
export const INPUT_NOT_RECORDED_NOTE = 'not recorded for this analysis';

export interface SourceDigest {
  readonly sha256: string | null;
  /** Why `sha256` is null; null when it is present. */
  readonly note: string | null;
}

export interface ExportDigests {
  readonly sourceSha256: string | null;
  readonly sourceSha256Note: string | null;
  /** Omitted for exports that do not come from an analysis. */
  readonly analysisInputSha256?: string | null;
  readonly crsOrigin: CrsOriginRecord;
}

export function exportDigests(
  source: SourceDigest | null | undefined,
  crs: CrsOriginInput | null | undefined,
  analysisInputSha256?: string | null,
): ExportDigests {
  return {
    sourceSha256: source?.sha256 ?? null,
    sourceSha256Note: source ? source.note : SOURCE_NOT_SUPPLIED_NOTE,
    ...(analysisInputSha256 !== undefined ? { analysisInputSha256 } : {}),
    crsOrigin: crsOriginOf(crs),
  };
}

/** The digest or the reason it is absent. */
export function sourceSha256Text(d: Pick<ExportDigests, 'sourceSha256' | 'sourceSha256Note'>): string {
  return d.sourceSha256 ?? d.sourceSha256Note ?? SOURCE_NOT_SUPPLIED_NOTE;
}

export function analysisInputSha256Text(d: Pick<ExportDigests, 'analysisInputSha256'>): string {
  return d.analysisInputSha256 === undefined ? NO_ANALYSIS_NOTE : (d.analysisInputSha256 ?? INPUT_NOT_RECORDED_NOTE);
}

/** The lines every text surface prints, in this order. */
export function exportDigestLines(d: ExportDigests): string[] {
  return [
    `Source SHA-256: ${sourceSha256Text(d)}`,
    ...(d.analysisInputSha256 !== undefined ? [`Analysis input SHA-256: ${analysisInputSha256Text(d)}`] : []),
    crsOriginLine(d.crsOrigin),
  ];
}
