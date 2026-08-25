/**
 * rangeCellLink.ts — what the workbench is allowed to say about one cell.
 *
 * The governing rule is the one the model states: IDENTITY, NOT POSITION. A
 * cell names a display record because the loader recorded which record it
 * produced. When that is not provable, this module produces a sentence that
 * says so and names the reason, and it never produces a record index.
 *
 * The copy lives here rather than in the widget for two reasons. It is the part
 * that has to be tested — the three linkage states are the contract, and a
 * fallback to something merely nearby would be a defect no rendering test would
 * notice — and it is the part the claim register constrains. Two claims,
 * ORG-TOPOLOGY-IDENTITY and ORG-RANGE-GEOMETRIC, prohibit the words "measured
 * range", "sensor accuracy" and "Flash LiDAR" outright, and prohibit claiming a
 * positional correspondence or an identity that survived a reduction. Nothing
 * below uses those words or makes those claims: a distance is a GEOMETRIC RANGE
 * in the acquisition frame, a shortfall is PARTIAL SOURCE COVERAGE, and a lost
 * identity names VOXEL CENTROIDS rather than describing what a centroid is
 * close to.
 *
 * Pure and DOM-free.
 */

import {
  CELL_STATE_LABEL,
  recordForCell,
  type CellStateValue,
  type OrganizedRangeFrame,
  type RangeLinkage,
} from '../model/OrganizedRange';
import { cellIndexOf } from '../model/OrganizedRange';

/**
 * What a click on a cell resolved to.
 *
 * `record` is present ONLY on the `linked` branch. A refusal carries no index
 * field at all, so a caller cannot read a stale or sentinel value out of it,
 * and no widening of the type can quietly hand one back.
 */
export type CellLinkResolution =
  | {
      readonly kind: 'linked';
      readonly record: number;
      readonly headline: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'refused';
      readonly headline: string;
      readonly detail: string;
    };

/** Why an unavailable linkage is unavailable, in the register's vocabulary. */
export function unavailableReasonText(
  reason: Extract<RangeLinkage, { kind: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'voxel-centroids':
      return 'the display cloud holds voxel centroids rather than source returns';
    case 'invalid-source-topology':
      return 'the source topology could not be read as an acquisition grid';
    case 'source-record-identity-unavailable':
      return 'the source record identity was never established for this grid';
  }
}

/** A one-line description of a frame's linkage, for the workbench header. */
export function linkageText(linkage: RangeLinkage): string {
  if (linkage.kind === 'exact') return 'Exact linkage';
  if (linkage.kind === 'partial') return 'Partial source coverage';
  return `Exact linkage unavailable: ${unavailableReasonText(linkage.reason)}`;
}

/** `Row 12, column 300`, written once so every surface says it the same way. */
export function cellText(row: number, column: number): string {
  return `Row ${row}, column ${column}`;
}

/**
 * Resolve a cell for the 2D to 3D link.
 *
 * Every branch routes through `recordForCell`, so the model decides what is
 * provable and this module decides only how to say it. The refusals are
 * deliberately specific: a person who clicks an empty band should learn whether
 * the scanner looked and got nothing back, or whether this session simply did
 * not decode the record, because those are different facts about different
 * things.
 */
export function resolveCellLink(
  frame: OrganizedRangeFrame,
  row: number,
  column: number,
): CellLinkResolution {
  const where = cellText(row, column);

  if (frame.linkage.kind === 'unavailable') {
    return {
      kind: 'refused',
      headline: 'Source-record identity is gone for this acquisition grid',
      detail:
        `${where} cannot name a display record, because ` +
        `${unavailableReasonText(frame.linkage.reason)}. ` +
        'No point in the displayed cloud is offered in its place.',
    };
  }

  const resolved = recordForCell(frame, row, column);
  if (resolved.ok) {
    const partial =
      frame.linkage.kind === 'partial'
        ? ' This grid reports partial source coverage; the records that were decoded still link exactly.'
        : '';
    return {
      kind: 'linked',
      record: resolved.record,
      headline: `${where} is display record ${resolved.record}`,
      detail: `The loader recorded this cell as the source of that record.${partial}`,
    };
  }

  if (row < 0 || column < 0 || row >= frame.height || column >= frame.width) {
    return {
      kind: 'refused',
      headline: 'Outside the acquisition grid',
      detail: `${where} is not a cell of this ${frame.width} by ${frame.height} grid.`,
    };
  }

  const state = frame.cellState[cellIndexOf(row, column, frame.width)] as CellStateValue;
  const stateLabel = CELL_STATE_LABEL[state] ?? 'Unknown cell state';
  const because =
    frame.linkage.kind === 'partial'
      ? ' This grid reports partial source coverage, so a record that was not decoded in this session has no display point to link to.'
      : '';
  return {
    kind: 'refused',
    headline: `${stateLabel}: no display record exists for this cell`,
    detail: `${where} holds no display record.${because}`,
  };
}
