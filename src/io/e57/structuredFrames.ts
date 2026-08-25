/**
 * structuredFrames.ts — an acquisition grid built from a structured E57 scan.
 *
 * The rules this file exists to hold:
 *
 *   EXTENT COMES FROM `indexBounds`, NOT THE PROTOTYPE. The prototype states
 *   what a field can hold; `indexBounds` states what the writer used. The pump
 *   fixture declares `rowIndex` up to 2047 and `columnIndex` up to 511 while
 *   its bounds say row 0 to 1073 and column 0 to 344, so sizing from the
 *   prototype allocates about 2.7 times the grid the file describes.
 *
 *   A DECLARATION IS NOT A BACKING. `e57StructuredGridCells` bounds the grid by
 *   the file, and a decoded index outside the declared bounds is a
 *   contradiction that costs the scan its grid rather than being folded to the
 *   nearest legal cell.
 *
 *   ONE FRAME PER SCAN. E57 topology is per scan while `loadE57` emits one
 *   merged cloud, so a merged grid would raster two instruments' views of
 *   different directions into a picture that means nothing.
 *
 *   IDENTITY IS RECORDED, NEVER RECONSTRUCTED. The merge loop tells the builder
 *   which merged record each decoded record became, including that it became
 *   none, so the invalid-state drop is composed rather than assumed away.
 */

import {
  CellState,
  NO_RECORD,
  buildCellReturns,
  cellIndexOf,
  tallyCellStates,
  type CellReturnInput,
  type OrganizedRangeFrame,
  type RangeLinkage,
} from '../../model/OrganizedRange';
import type { E57Scan } from './schema';
import type { E57StructuredSink } from './compressedVector';
import { e57StructuredGridCells, e57StructuredRequestsForScan } from './structuredSink';

/** The structured column a request produced, by LOCAL name. */
function byLocal(
  scan: E57Scan,
  sink: E57StructuredSink,
): Record<string, Uint16Array | Uint32Array | Float32Array | undefined> {
  const out: Record<string, Uint16Array | Uint32Array | Float32Array | undefined> = {};
  for (const request of e57StructuredRequestsForScan(scan)) {
    out[request.local] = sink.columns[request.name];
  }
  return out;
}

/**
 * Builds one scan's grid while the merge loop walks its records.
 *
 * Written as a builder rather than a post-pass over a record-to-record table
 * precisely so no such table exists: the merge already knows where each record
 * went, and storing that knowledge a second time would cost four bytes per
 * record and give the accounting one more term to be wrong about.
 */
export class E57GridBuilder {
  readonly width: number;
  readonly height: number;
  private readonly rowMinimum: number;
  private readonly columnMinimum: number;
  private readonly rowMaximum: number;
  private readonly columnMaximum: number;
  private readonly rows: Uint16Array | Uint32Array | Float32Array;
  private readonly columns: Uint16Array | Uint32Array | Float32Array;
  private readonly returnIndex?: Uint16Array | Uint32Array | Float32Array;
  private readonly returnCount?: Uint16Array | Uint32Array | Float32Array;
  private readonly range?: Uint16Array | Uint32Array | Float32Array;
  private readonly cellState: Uint8Array;
  private readonly cellToRecord: Int32Array;
  private readonly sourceRange?: Float32Array;
  private readonly returns?: CellReturnInput[];
  /** What the records said that the declaration forbids, or null. */
  contradiction: string | null = null;

  private readonly strided: boolean;

  private constructor(scan: E57Scan, sink: E57StructuredSink, strided: boolean) {
    this.strided = strided;
    const row = scan.indexBounds!.row!;
    const column = scan.indexBounds!.column!;
    this.rowMinimum = row.minimum;
    this.columnMinimum = column.minimum;
    this.rowMaximum = row.maximum;
    this.columnMaximum = column.maximum;
    this.height = row.maximum - row.minimum + 1;
    this.width = column.maximum - column.minimum + 1;
    const cells = this.width * this.height;
    const columns = byLocal(scan, sink);
    this.rows = columns.rowIndex!;
    this.columns = columns.columnIndex!;
    this.returnIndex = columns.returnIndex;
    this.returnCount = columns.returnCount;
    this.range = columns.sphericalRange;
    // A strided decode read a subset, and nothing distinguishes a cell whose
    // record was skipped from one the file never wrote. NOT_DECODED describes
    // the decision this session took; SOURCE_RECORD_MISSING would describe the
    // file, and only an unstrided read can say that.
    this.cellState = new Uint8Array(cells).fill(
      strided ? CellState.NOT_DECODED : CellState.SOURCE_RECORD_MISSING,
    );
    this.cellToRecord = new Int32Array(cells).fill(NO_RECORD);
    if (this.range) this.sourceRange = new Float32Array(cells).fill(Number.NaN);
    if (this.returnIndex) this.returns = [];
  }

  /**
   * A builder for this scan, or null when it earns no grid.
   *
   * Null is the answer for every honest shortfall: a scan the schema rules
   * ineligible, a grid the file is too small to back, a declaration whose
   * bounds will not size an integer column, and a decode that already found a
   * value outside those bounds.
   */
  static forScan(
    scan: E57Scan,
    sink: E57StructuredSink | undefined,
    fileBytes: number,
    strided: boolean,
  ): E57GridBuilder | null {
    if (!sink || sink.contradiction !== null) return null;
    if (e57StructuredGridCells(scan, fileBytes) === 0) return null;
    const columns = byLocal(scan, sink);
    if (!columns.rowIndex || !columns.columnIndex) return null;
    return new E57GridBuilder(scan, sink, strided);
  }

  /**
   * Record what became of decoded record `i`.
   *
   * `merged` is the index the record took in the merged cloud, or null when the
   * merge dropped it because the file flagged it invalid. That drop removes 58 %
   * of the records of one real fixture, INSIDE the merge loop and before
   * sanitation runs, so a grid that ignored it would be wrong from its first
   * casualty onward — every later cell pointing at another return's coordinates.
   */
  place(i: number, merged: number | null): void {
    if (this.contradiction !== null) return;
    const row = this.rows[i]!;
    const column = this.columns[i]!;
    if (
      row < this.rowMinimum ||
      row > this.rowMaximum ||
      column < this.columnMinimum ||
      column > this.columnMaximum
    ) {
      this.contradiction =
        `record ${i} is at row ${row}, column ${column}, outside the ` +
        `${this.rowMinimum}–${this.rowMaximum} by ${this.columnMinimum}–${this.columnMaximum} ` +
        `grid the file's indexBounds declares`;
      return;
    }
    const cell = cellIndexOf(row - this.rowMinimum, column - this.columnMinimum, this.width);
    if (merged === null) {
      // The file itself says this record is unusable. That is evidence about
      // the record, not about this session, so it is not NOT_DECODED.
      this.cellState[cell] = CellState.SOURCE_INVALID;
      return;
    }
    this.cellState[cell] = CellState.VALID_RETURN;
    this.cellToRecord[cell] = merged;
    if (this.sourceRange && this.range) this.sourceRange[cell] = this.range[i]!;
    if (this.returns && this.returnIndex) {
      this.returns.push({
        row: row - this.rowMinimum,
        column: column - this.columnMinimum,
        record: merged,
        returnIndex: this.returnIndex[i]!,
        returnCount: this.returnCount ? this.returnCount[i]! : 0,
      });
    }
  }

  /** The finished frame. Never call this while `contradiction` is set. */
  frame(id: string): OrganizedRangeFrame {
    const linkage: RangeLinkage = this.strided
      ? { kind: 'partial', reason: 'stride' }
      : { kind: 'exact' };
    const built = this.returns
      ? buildCellReturns(this.width, this.height, this.returns)
      : undefined;
    return {
      id,
      sourceKind: 'e57-structured',
      width: this.width,
      height: this.height,
      cellState: this.cellState,
      cellToRecord: this.cellToRecord,
      ...(this.sourceRange ? { sourceRange: this.sourceRange } : {}),
      ...(built
        ? {
            returnCellStart: built.returnCellStart,
            returnRecord: built.returnRecord,
            returnIndex: built.returnIndex,
            returnCountDeclared: built.returnCountDeclared,
            returnsSkipped: built.skippedCount,
          }
        : {}),
      linkage,
      diagnostics: tallyCellStates(this.cellState),
    };
  }
}
