/**
 * organizedRangeRemap.ts — carrying cell-to-record identity through sanitation.
 *
 * Sanitation compacts survivors, so any drop shifts every record index after
 * the first casualty. The compaction witness turns that shift into an
 * answerable question: it says where each source record landed, or that it
 * landed nowhere, so a grid can be rewritten instead of disowned.
 *
 * Written once, here, because PTX and E57 reach it by different routes and a
 * second copy of this reasoning is a second place for it to drift. Guessing an
 * index is the one failure the whole sidecar exists to prevent: an index that
 * is present, plausible, and points at another return.
 */

import {
  CellState,
  NO_RECORD,
  tallyCellStates,
  type OrganizedRangeFrame,
} from '../model/OrganizedRange';
import { outputRecordFor, RECORD_DROPPED, RECORD_NOT_WITNESSED, type CompactionWitness } from './sanitizeCloud';

/**
 * Rewrite one frame's `cellToRecord` from pre-sanitation record indices to the
 * indices the display cloud actually holds.
 *
 * Returns `null` when the witness cannot answer for a record the frame claims,
 * which the caller turns into the honest degrade.
 *
 * A cell whose record did not survive becomes NOT_DECODED. The scanner did get
 * a return there, so NO_RETURN would report a decoding loss as an instrument
 * observation. NOT_DECODED says what is true: a record exists in the file and
 * this session did not carry it through.
 */
export function remapFrame(
  frame: OrganizedRangeFrame,
  witness: CompactionWitness,
): OrganizedRangeFrame | null {
  const cellState = new Uint8Array(frame.cellState);
  const cellToRecord = new Int32Array(frame.cellToRecord);
  for (let ci = 0; ci < cellToRecord.length; ci++) {
    const source = cellToRecord[ci];
    if (source === NO_RECORD) continue;
    const output = outputRecordFor(witness, source);
    // The witness does not cover this index, so the grid and the sanitiser
    // disagree about how many records existed. That is a bookkeeping fault,
    // not a decoding outcome, and no cell state describes it truthfully.
    // Abandon the remap and let the caller degrade the whole set.
    if (output === RECORD_NOT_WITNESSED) return null;
    if (output === RECORD_DROPPED) {
      cellToRecord[ci] = NO_RECORD;
      cellState[ci] = CellState.NOT_DECODED;
      continue;
    }
    cellToRecord[ci] = output;
  }
  // The per-return records are the same identity one level down, so they move
  // with it. A return whose record was dropped keeps its returnIndex and its
  // declared count, which are topology, and loses only the claim to a record.
  let returnRecord: Int32Array | undefined;
  if (frame.returnRecord) {
    returnRecord = new Int32Array(frame.returnRecord);
    for (let k = 0; k < returnRecord.length; k++) {
      const source = returnRecord[k];
      if (source === NO_RECORD) continue;
      const output = outputRecordFor(witness, source);
      if (output === RECORD_NOT_WITNESSED) return null;
      returnRecord[k] = output === RECORD_DROPPED ? NO_RECORD : output;
    }
  }
  return {
    ...frame,
    cellState,
    cellToRecord,
    ...(returnRecord ? { returnRecord } : {}),
    diagnostics: tallyCellStates(cellState),
  };
}

/**
 * Remap every frame, or none of them.
 *
 * A set where one frame links exactly and another silently lost its identity
 * would be read as uniformly trustworthy, so a single unanswerable frame sends
 * the whole set down the degrade path.
 */
export function remapFrames(
  frames: readonly OrganizedRangeFrame[],
  witness: CompactionWitness,
): OrganizedRangeFrame[] | null {
  const out: OrganizedRangeFrame[] = [];
  for (const frame of frames) {
    const next = remapFrame(frame, witness);
    if (next === null) return null;
    out.push(next);
  }
  return out;
}
