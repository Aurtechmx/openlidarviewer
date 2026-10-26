/**
 * storageHistoryRow.ts: the scan report's "Storage history" row.
 *
 * The outcome of the storage-grid test (`science/storageHistory.ts`) is reduced here to one
 * row. The value names the grid the stored integers are compatible with, or says that none was
 * detected, or why the test did not run. The detail (the hover text) carries the figures: the
 * Fisher-combined p before and after the Bonferroni correction, the measured-to-predicted
 * amplitude ratio, and the windows and points that entered. The wording states compatibility
 * with a grid and nothing about who wrote the file or how.
 *
 * Pure: no DOM. One formatter for the static and the streaming report so the same row cannot
 * read two ways.
 */

import type { AnalysisRow } from './ModuleApi';

/** The unit a supported grid's step is shown in. `source` is the file's own unit when it is not a metre or a foot, or is not declared. */
export type StorageHistoryUnit = 'm' | 'ft' | 'source';

export type StorageHistoryOutcome =
  | {
      readonly kind: 'supported';
      /** Grid step in `unit`. */
      readonly step: number;
      readonly unit: StorageHistoryUnit;
      /** Whole degrees the grid axes are turned counter-clockwise from the file axes; 0 for the file's own frame. */
      readonly rotationDeg: number;
      /** Fisher-combined empirical p over the candidate's testable peaks. */
      readonly pJoint: number;
      /** `pJoint` times the number of tested candidates, capped at 1. */
      readonly pBonferroni: number;
      /** Median measured / predicted peak amplitude; support needs it in [0.5, 2]. */
      readonly amplitudeRatio: number;
      readonly candidatesTested: number;
      /** Supported most-specific grids; the one with the smallest corrected p is shown. */
      readonly supportedCount: number;
      readonly windows: number;
      readonly points: number;
    }
  | { readonly kind: 'none'; readonly candidatesTested: number; readonly windows: number; readonly points: number }
  | { readonly kind: 'not-tested'; readonly reason: string }
  | { readonly kind: 'running' };

export const STORAGE_HISTORY_LABEL = 'Storage history';

/** The method tag the detail cites; the version is the registry's (`olv.storage.grid-history`). */
export const STORAGE_HISTORY_METHOD_TAG = 'olv.storage.grid-history@1';

const COMPATIBILITY_NOTE =
  'A supported grid is one the stored integers are compatible with; it does not say which process produced the file.';

/** A step with up to four significant digits and no trailing zeros. */
export function formatGridStep(step: number): string {
  return String(Number(step.toPrecision(4)));
}

function gridPhrase(o: Extract<StorageHistoryOutcome, { kind: 'supported' }>): string {
  const unit = o.unit === 'source' ? 'source-unit' : o.unit;
  const turned = o.rotationDeg !== 0 ? ` rotated ${o.rotationDeg}°` : '';
  return `${formatGridStep(o.step)} ${unit} grid${turned}`;
}

function fmtP(p: number): string {
  return p >= 0.001 ? p.toFixed(3) : p.toExponential(1);
}

/** The row for one outcome. */
export function storageHistoryRow(o: StorageHistoryOutcome): AnalysisRow {
  switch (o.kind) {
    case 'supported': {
      const others = o.supportedCount > 1 ? ` ${o.supportedCount} grids are supported; the one with the smallest corrected p is shown.` : '';
      const feet = o.unit === 'ft' ? ' International and US survey feet are not told apart.' : '';
      return {
        label: STORAGE_HISTORY_LABEL,
        value: `coordinates supported on a ${gridPhrase(o)}`,
        status: 'info',
        detail:
          `Preview. Fisher-combined p ${fmtP(o.pJoint)}, ${fmtP(o.pBonferroni)} after Bonferroni over ${o.candidatesTested} tested candidate grids; `
          + `measured/predicted amplitude ratio ${o.amplitudeRatio.toFixed(2)}; ${o.windows} windows, ${o.points.toLocaleString('en-US')} points.`
          + `${others}${feet} ${COMPATIBILITY_NOTE} (${STORAGE_HISTORY_METHOD_TAG})`,
      };
    }
    case 'none':
      return {
        label: STORAGE_HISTORY_LABEL,
        value: 'none detected',
        status: 'info',
        detail:
          `Preview. No candidate grid reached p < 0.01 after Bonferroni over ${o.candidatesTested} tested candidate grids `
          + `with an amplitude ratio in [0.5, 2]; ${o.windows} windows, ${o.points.toLocaleString('en-US')} points. `
          + `Only the candidate grids were tested; a grid outside them is not ruled out. (${STORAGE_HISTORY_METHOD_TAG})`,
      };
    case 'not-tested':
      return {
        label: STORAGE_HISTORY_LABEL,
        value: `not tested (${o.reason})`,
        status: 'info',
        detail: `Preview. The storage-grid test did not run for this scan. (${STORAGE_HISTORY_METHOD_TAG})`,
      };
    case 'running':
      return {
        label: STORAGE_HISTORY_LABEL,
        value: 'test running',
        status: 'info',
        detail: 'Preview. The stored integers are being tested against the candidate grids; the row updates when the test ends.',
      };
  }
}
