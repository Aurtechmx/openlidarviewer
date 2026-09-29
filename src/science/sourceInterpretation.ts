/**
 * sourceInterpretation.ts — how the source file was read, carried into export
 * provenance.
 *
 * Two facts a reader needs to reproduce or weigh any derived result:
 *
 *   - `interpretationLevel`: the format probe's verdict on how the file's
 *     bytes were understood (`PointCloud.metadata.interpretationLevel`). The
 *     probe only runs when the signature and extension did not settle the
 *     format, so a file opened on its signature records `'not-probed'`; that
 *     is a statement about the probe, not a weaker reading.
 *   - `dataBasis`: which part of the source the result was computed on
 *     (`'full'`, `'sampled'`, `'resident-only'`), or `'unknown'` when the
 *     producing layer did not record one.
 *
 * Pure data and a leaf: no DOM, no three.js, no I/O and no runtime imports, so any
 * export path (eager or lazy) can reach it without pulling a chunk. The
 * manifest op for the record lives in `processingManifest.ts`.
 */

/** The registered method the manifest op is stamped with. */
export const SOURCE_INTERPRETATION_METHOD_ID = 'olv.provenance.source-interpretation';

export type SourceDataBasis = 'full' | 'sampled' | 'resident-only' | 'unknown';

import type { CrsOriginRecord } from './crsOrigin';

export interface SourceInterpretationRecord {
  /** Probe verdict (e.g. `'VERIFIED'`, `'PROBABLE'`), `'not-probed'` or `'not-recorded'`. */
  readonly interpretationLevel: string;
  readonly dataBasis: SourceDataBasis;
  /** Where the coordinate system came from (`crsOrigin.ts`), when the export path read it. */
  readonly crsOrigin?: CrsOriginRecord;
}

const BASES: ReadonlySet<string> = new Set(['full', 'sampled', 'resident-only']);

/**
 * Build the record from the loader's level and the coverage the result was
 * computed on. `null` means the cloud was read and carries no probe verdict
 * (`'not-probed'`); `undefined` means the producing path did not look
 * (`'not-recorded'`). The two are kept apart so a record never claims the
 * probe was skipped when nobody checked.
 */
export function sourceInterpretationOf(
  interpretationLevel: string | null | undefined,
  coverage: string | null | undefined,
): SourceInterpretationRecord {
  return {
    interpretationLevel: interpretationLevel ? interpretationLevel : interpretationLevel === null ? 'not-probed' : 'not-recorded',
    dataBasis: coverage && BASES.has(coverage) ? (coverage as SourceDataBasis) : 'unknown',
  };
}

/** Two README lines, word-for-word identical in every package. */
export function sourceInterpretationLines(record: SourceInterpretationRecord, indent = '  '): string[] {
  return [
    `${indent}Interpretation level  ${record.interpretationLevel}`,
    `${indent}Data basis            ${record.dataBasis}`,
  ];
}
