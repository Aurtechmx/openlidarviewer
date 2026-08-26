/**
 * OrganizedRange.ts — the source measurement topology behind a display cloud.
 *
 * A `PointCloud` answers "where is this return in 3D space". It cannot answer
 * "where did this return exist in the acquisition grid", because flattening a
 * scanner grid into a coordinate stream discards the row, the column and every
 * cell the scanner interrogated and got nothing back from.
 *
 * This module holds that discarded half. It is a SIDECAR, never a second point
 * cloud: it stores per-cell state and the identity of the display record each
 * cell produced, not a duplicate copy of the coordinates.
 *
 * The governing rule, inherited from the Profile Workbench, is IDENTITY, NOT
 * POSITION. A cell links to a display record because the loader recorded which
 * record it produced, never because a coordinate happened to be nearby. When
 * the processing path destroys that identity, the frame says so through
 * `linkage` rather than reconstructing a plausible answer.
 *
 * Pure and DOM-free by design, so the model is testable under Node. The bulk
 * of each frame is typed arrays, which cross a worker boundary by transfer
 * rather than by structured clone; the acquisition pose is a handful of plain
 * numbers per setup and is cloned.
 */

/**
 * What the source says about one grid cell.
 *
 * These are deliberately five distinct states rather than one "empty" sentinel,
 * because they carry different scientific weight. A NO_RETURN is evidence about
 * a ray the scanner actually fired: it looked along that direction and nothing
 * came back. A NOT_DECODED cell says nothing about the scene at all, only about
 * what this session did with the file. Collapsing the two would let a decision
 * taken inside the pipeline read as a property of the surface.
 */
export const CellState = {
  /** The source carries a usable return for this cell. */
  VALID_RETURN: 0,
  /** The scanner interrogated this direction and received nothing. */
  NO_RETURN: 1,
  /** The source record exists but the source declares it unusable. */
  SOURCE_INVALID: 2,
  /**
   * A record exists in the file and this session did not deliver it.
   *
   * Covers two routes to the same shortfall: never read (a stride decoded a
   * subset), and read but discarded (a coordinate that overflowed its
   * transform, removed by sanitation). Both are decisions this pipeline took,
   * and neither says anything about what the scanner observed. The distinction
   * that matters here is against NO_RETURN, not between the two routes.
   */
  NOT_DECODED: 3,
  /** The grid declares this cell and the file supplied no record for it. */
  SOURCE_RECORD_MISSING: 4,
} as const;

export type CellStateValue = (typeof CellState)[keyof typeof CellState];

/** Every state, in value order, for exhaustive iteration and tallying. */
export const CELL_STATES: readonly CellStateValue[] = [
  CellState.VALID_RETURN,
  CellState.NO_RETURN,
  CellState.SOURCE_INVALID,
  CellState.NOT_DECODED,
  CellState.SOURCE_RECORD_MISSING,
];

/** Human-readable names, for diagnostics and UI. Never abbreviate these in prose. */
export const CELL_STATE_LABEL: Readonly<Record<CellStateValue, string>> = {
  [CellState.VALID_RETURN]: 'Valid return',
  [CellState.NO_RETURN]: 'No return',
  [CellState.SOURCE_INVALID]: 'Source invalid',
  [CellState.NOT_DECODED]: 'Not decoded',
  [CellState.SOURCE_RECORD_MISSING]: 'Source record missing',
};

/**
 * The cell holds no display record, whatever the reason.
 *
 * `Int32Array` rather than `Uint32Array` precisely so this sentinel exists: an
 * unsigned array would have to spend a real index (or a parallel mask) to say
 * "nothing here", and a mask is one more array to keep in step.
 */
export const NO_RECORD = -1;

/**
 * Where a scanner setup stood.
 *
 * PTX carries TWO positions and they are not two candidates for one value.
 * They live in different frames:
 *
 *   `localPosition`  the format's own scanner-position header line, expressed
 *                    in the scanner's own frame, so it is `0 0 0` for ordinary
 *                    scanner-local data and non-zero only when the writer
 *                    offset its samples from the instrument.
 *   `worldTranslation` the registration transform's translation row, which is
 *                    where that scanner sits once the block is registered.
 *
 * An earlier design treated the header line as the better source for a single
 * "scanner origin" and the transform row as a fallback substitute. That is
 * wrong: it would report a scanner at the world origin for every ordinary file.
 * Keep both, name the frame in the field, and let the caller pick.
 *
 * The transform is kept as the raw row-major 4x4 rather than decomposed into a
 * quaternion. Decomposition buys nothing here and introduces a convention risk
 * (component order, handedness, row or column vectors) that a reader cannot
 * audit from the stored value.
 */
export interface AcquisitionPose {
  /** Registered world position: the transform's translation row. */
  readonly worldTranslation: readonly [number, number, number];
  /** The format's declared scanner position, in the scanner's own frame. */
  readonly localPosition?: readonly [number, number, number];
  /** Row-major, translation in row 3, matching the PTX layout. Four rows of four. */
  readonly transform?: readonly (readonly number[])[];
  /**
   * Whether `localPosition` was readable, the header line was malformed, or
   * the format carries no such second position at all (PCD, which declares one
   * viewpoint and nothing else).
   */
  readonly localPositionSource: 'source-declared' | 'unreadable' | 'not-applicable';
  /**
   * Acquisition orientation, where the format declares one as a quaternion.
   *
   * PCD's VIEWPOINT is `tx ty tz qw qx qy qz`, so the rotation arrives already
   * decomposed and there is nothing to gain by composing a 4x4 from it. The
   * components are NAMED rather than stored in an array precisely because the
   * order is the trap: PCD writes w first, three.js and most maths libraries
   * write it last, and a positional four-tuple makes the two indistinguishable
   * at every call site.
   */
  readonly rotation?: {
    readonly w: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /** Present only when `rotation` is, and only ever because the file said so. */
  readonly rotationSource?: 'source-declared';
}

/**
 * How faithfully this frame can still reach the display cloud.
 *
 * `partial` is a recoverable shortfall: the records that were decoded still
 * link exactly, and decoding more would restore the rest. `unavailable` is
 * permanent for this cloud, and the reason names which step spent the identity.
 */
export type RangeLinkage =
  | { readonly kind: 'exact' }
  | { readonly kind: 'partial'; readonly reason: 'stride' }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'voxel-centroids'
        | 'invalid-source-topology'
        | 'source-record-identity-unavailable';
    };

/** Per-frame tallies. Counts only; every ratio is derived on demand. */
export interface RangeFrameDiagnostics {
  readonly cells: number;
  /** Indexed by `CellStateValue`. */
  readonly stateCounts: Readonly<Record<CellStateValue, number>>;
}

export interface OrganizedRangeFrame {
  readonly id: string;
  readonly sourceKind: 'ptx-grid' | 'pcd-organized' | 'e57-structured';
  /** Columns. */
  readonly width: number;
  /** Rows. */
  readonly height: number;
  /** Length `width * height`, indexed by `cellIndex`. */
  readonly cellState: Uint8Array;
  /**
   * Length `width * height`. The cell's PRIMARY display record, or `NO_RECORD`.
   *
   * A cell that produced several returns produced several records, and one
   * `Int32` cannot hold them. This array holds the primary and nothing else:
   * the SMALLEST merged record index the cell produced. Smallest rather than
   * last-written because the merge numbers records in file order, so the
   * smallest is the one the file wrote first, and because a rule stated over
   * the SET of a cell's records gives the same answer whatever order the
   * loader walked them in. Last-written gave a different primary for the same
   * file read at a different stride.
   *
   * It is a convenience for the single-return case and for the UI, never the
   * frame's record of identity. Every surviving record is reachable through
   * `returnRecord`, and {@link cellIndexForRecord} is the reverse direction for
   * all of them, not only for the primaries.
   */
  readonly cellToRecord: Int32Array;
  /**
   * Multi-return description, as parallel arrays in CSR form.
   *
   * The first three are present TOGETHER or not at all. Their absence is not
   * "this frame has no returns"; it means this frame never described returns
   * per cell, which is the ordinary case for PTX and PCD, where a cell holds at
   * most one. A single-return frame therefore allocates nothing here and every
   * existing accessor keeps its cost.
   *
   * `returnCountDeclared` and `returnSourceRange` are independent of that trio,
   * because a source can describe its returns while declaring neither. Their
   * absence is the frame saying the source was silent, which is why neither is
   * back-filled with a stand-in value.
   */
  /** Length `width * height + 1`. Returns of cell `c` live in `[s[c], s[c+1])`. */
  readonly returnCellStart?: Uint32Array;
  /** Length `returnCellStart[cells]`, in cell order. Record index, or `NO_RECORD`. */
  readonly returnRecord?: Int32Array;
  /**
   * Length as `returnRecord`. The source's own `returnIndex` for each return.
   *
   * `Uint32Array`, not `Uint16Array`, because the E57 structured sink sizes
   * this column from the file's DECLARED maximum and legitimately hands back a
   * `Uint32Array` when that maximum exceeds 65535. A narrower store took the
   * value modulo 65536 in silence, so a declared index of 70001 arrived as
   * 4465 and sorted into the wrong place in its own cell. Two extra bytes per
   * return is the price of never doing that.
   */
  readonly returnIndex?: Uint32Array;
  /**
   * Length as `returnRecord`, and ABSENT when the source declared no count.
   *
   * A zero here is the source declaring zero. The absence of the array is the
   * source saying nothing, which used to be written as a zero into an array
   * whose name asserts a declaration. In E57 the count is a prototype field
   * that either exists for the whole scan or does not, so absence is a
   * property of the frame and needs no per-return mask.
   */
  readonly returnCountDeclared?: Uint32Array;
  /**
   * Length as `returnRecord`. Source-declared range per RETURN, NaN where absent.
   *
   * Two returns of one pulse are at two distances, and no single cell-level
   * number describes both. `sourceRange` keeps a per-cell value for the raster,
   * defined against the primary record; this array is where the measurement
   * itself lives.
   */
  readonly returnSourceRange?: Float32Array;
  /** Returns the build was handed that addressed no cell of this grid. */
  readonly returnsSkipped?: number;
  /** Length `width * height`. Range in acquisition-local coordinates, NaN where absent. */
  readonly geometricRange?: Float32Array;
  /**
   * Length `width * height`. Range the source declared for the cell's PRIMARY
   * record, NaN where absent.
   *
   * Named against `cellToRecord`'s primary rule on purpose. A cell-level range
   * is a summary, and a summary needs a stated rule or it is whatever the
   * traversal happened to write last. Callers that need the distances of a
   * multi-return pulse read `returnSourceRange`, which loses nothing.
   */
  readonly sourceRange?: Float32Array;
  readonly acquisitionPose?: AcquisitionPose;
  readonly linkage: RangeLinkage;
  readonly diagnostics: RangeFrameDiagnostics;
}

export interface OrganizedRangeSet {
  readonly kind: 'organized-range';
  readonly frames: readonly OrganizedRangeFrame[];
  readonly organization: 'organized-grid' | 'multi-grid';
}

/**
 * PTX orders its samples column by column: every row of column 0, then every
 * row of column 1. So the ordinal advances DOWN a column, and the row is the
 * fast axis.
 *
 * This is stated as a function rather than inlined at the call site because it
 * is a format convention, not an arithmetic detail, and getting it transposed
 * produces a grid that looks plausible and is wrong everywhere. A test pins it
 * against a non-square grid, where a transposition cannot hide.
 */
export function ptxCellFromOrdinal(
  ordinal: number,
  rows: number,
): { readonly row: number; readonly column: number } {
  return { row: ordinal % rows, column: Math.floor(ordinal / rows) };
}

/**
 * PCD orders an organized dataset like an image: row by row, so the COLUMN is
 * the fast axis and the ordinal advances ACROSS a row. This is the opposite of
 * PTX, which is why both conventions are named functions rather than inline
 * arithmetic.
 *
 * PCL is the authority for both halves of this. Its header defines
 * `PointCloud::at(column, row)` as `points[row * width + column]`, and gates
 * organized access on `height > 1` — the same test this loader applies. The
 * format tutorial gives WIDTH as "the total number of points in a row" and
 * HEIGHT as "the total number of rows".
 *
 * A test pins the mapping against a non-square grid, where a transposition
 * cannot hide.
 */
export function pcdCellFromOrdinal(
  ordinal: number,
  width: number,
): { readonly row: number; readonly column: number } {
  return { row: Math.floor(ordinal / width), column: ordinal % width };
}

/**
 * The index into `cellState` and `cellToRecord` for a row and column.
 *
 * Storage is row-major (`row * width + column`) regardless of the source's own
 * ordering, so every frame is addressed the same way whatever produced it. The
 * source ordering is converted on the way in, once, by the loader.
 */
export function cellIndexOf(row: number, column: number, width: number): number {
  return row * width + column;
}

/** Tally cell states. Kept separate from construction so it can be re-run after an edit. */
export function tallyCellStates(cellState: Uint8Array): RangeFrameDiagnostics {
  const stateCounts = {
    [CellState.VALID_RETURN]: 0,
    [CellState.NO_RETURN]: 0,
    [CellState.SOURCE_INVALID]: 0,
    [CellState.NOT_DECODED]: 0,
    [CellState.SOURCE_RECORD_MISSING]: 0,
  } as Record<CellStateValue, number>;
  for (let i = 0; i < cellState.length; i++) {
    const s = cellState[i] as CellStateValue;
    if (s in stateCounts) stateCounts[s]++;
  }
  return { cells: cellState.length, stateCounts };
}

/**
 * Resolve a cell to its display record, or explain why it cannot.
 *
 * Returns `null` rather than a plausible index whenever the answer is not
 * provable. Callers must render the reason, not fall back to a nearest point.
 */
export function recordForCell(
  frame: OrganizedRangeFrame,
  row: number,
  column: number,
): { readonly ok: true; readonly record: number } | { readonly ok: false; readonly why: string } {
  if (frame.linkage.kind === 'unavailable') {
    return { ok: false, why: `Exact linking unavailable: ${frame.linkage.reason}.` };
  }
  if (row < 0 || column < 0 || row >= frame.height || column >= frame.width) {
    return { ok: false, why: 'Cell is outside the acquisition grid.' };
  }
  const idx = cellIndexOf(row, column, frame.width);
  const state = frame.cellState[idx] as CellStateValue;
  if (state !== CellState.VALID_RETURN) {
    return { ok: false, why: `${CELL_STATE_LABEL[state]}: no display record exists for this cell.` };
  }
  const record = frame.cellToRecord[idx];
  if (record === NO_RECORD) {
    return { ok: false, why: 'Source record identity is unavailable for this cell.' };
  }
  return { ok: true, record };
}

/**
 * Degrade every frame's linkage, returning a new set.
 *
 * The topology survives a reduction that destroys record identity: a grid of
 * validity and range is still worth inspecting after voxelization, and saying
 * so is the point of separating the two. What must not survive is the claim
 * that a centroid IS a source return.
 *
 * `cellToRecord` is rewritten to `NO_RECORD` rather than merely being ignored,
 * so a caller that reads the array directly cannot resurrect a stale index.
 */
export function withLinkageUnavailable(
  set: OrganizedRangeSet,
  reason: Extract<RangeLinkage, { kind: 'unavailable' }>['reason'],
): OrganizedRangeSet {
  return {
    ...set,
    frames: set.frames.map((f) => ({
      ...f,
      cellToRecord: new Int32Array(f.cellToRecord.length).fill(NO_RECORD),
      // The per-return indices are exactly the same defect one level down, so
      // they are erased on the same terms. The offsets, the return indices and
      // the declared counts survive: they are topology, not identity.
      ...(f.returnRecord ? { returnRecord: new Int32Array(f.returnRecord.length).fill(NO_RECORD) } : {}),
      linkage: { kind: 'unavailable', reason } as const,
    })),
  };
}

/**
 * Every transferable buffer in a set, derived from the frames themselves.
 *
 * Deliberately not a hand-written list of field names. The worker's transfer
 * list was enumerated per field, so adding one array to `OrganizedRangeFrame`
 * would have sent it across the boundary by structured clone: correct, silent,
 * and at exactly the copying cost the transfer list exists to avoid. Reading
 * the frame's own values means a new array is included by construction.
 *
 * `acquisitionPose.transform` is nested plain arrays rather than a typed array,
 * so it is cloned. That is a handful of numbers per setup and not worth a
 * representation change.
 */
export function organizedRangeTransferables(set: OrganizedRangeSet): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const frame of set.frames) {
    for (const value of Object.values(frame)) {
      if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer);
    }
  }
  return out;
}

/** One return of one pulse, as the source described it. */
export interface CellReturn {
  /** Display record index, or `NO_RECORD` when identity was never established. */
  readonly record: number;
  /** Which return of the pulse this is, as the source declared it. */
  readonly returnIndex: number;
  /**
   * How many returns the source declared for that pulse, or null when the
   * source declared no count at all. Null rather than 0: a source that says
   * "zero returns" and a source that says nothing are different evidence, and
   * only one of them is about the pulse.
   */
  readonly returnCount: number | null;
  /** Range the source declared for this return, or null when it declared none. */
  readonly sourceRange: number | null;
}

/** One return on its way in, addressed by grid cell. */
export interface CellReturnInput extends CellReturn {
  readonly row: number;
  readonly column: number;
}

/**
 * Aggregate one record's state into the state its CELL already holds.
 *
 * Order-independent by construction, which is the whole reason it exists as a
 * function. `place()` used to assign, so a cell holding a valid record and an
 * invalid one ended VALID_RETURN or SOURCE_INVALID depending on which record
 * the loader reached last, and the same file read at a different stride
 * disagreed with itself.
 *
 * VALID_RETURN dominates because the question the cell answers is whether it
 * produced a usable display record, and one usable return is enough for that.
 * The invalid siblings are not lost: they are records the merge dropped, so
 * they never had an identity for the return list to carry either. Anything the
 * source actually said about the cell beats the fill value the grid started
 * with, and NOT_DECODED never wins over evidence.
 */
export function aggregateCellState(
  current: CellStateValue,
  incoming: CellStateValue,
): CellStateValue {
  if (current === CellState.VALID_RETURN || incoming === CellState.VALID_RETURN) {
    return CellState.VALID_RETURN;
  }
  if (current === CellState.SOURCE_INVALID || incoming === CellState.SOURCE_INVALID) {
    return CellState.SOURCE_INVALID;
  }
  return incoming;
}

/** The arrays a frame carries, plus what the build could not place. */
export interface BuiltCellReturns {
  readonly returnCellStart: Uint32Array;
  readonly returnRecord: Int32Array;
  readonly returnIndex: Uint32Array;
  /** Absent when no entry declared a count. */
  readonly returnCountDeclared?: Uint32Array;
  /** Absent when no entry declared a range. */
  readonly returnSourceRange?: Float32Array;
  readonly skippedCount: number;
}

/**
 * Widest value the return columns can hold. The E57 structured sink sizes an
 * index column at `u32` when the file declares a maximum this large, so this is
 * the width the model must accept, not a generous margin.
 */
export const RETURN_VALUE_MAX = 4294967295;

/**
 * Refuse a return column value the store cannot hold, naming what was supplied.
 *
 * Refusal, not clamping and not a wrap. Both of those return a number, and a
 * number returned from here is indistinguishable from a measurement. A value
 * outside `0..RETURN_VALUE_MAX`, or one that is not an integer, is not a
 * `returnIndex` any source declared through a supported column, so the build
 * that produced it is wrong and stops rather than storing a plausible answer.
 */
function checkedReturnValue(field: string, value: number, at: number): number {
  if (!Number.isInteger(value) || value < 0 || value > RETURN_VALUE_MAX) {
    throw new RangeError(
      `${field} ${value} at entry ${at} is outside 0..${RETURN_VALUE_MAX}, ` +
        'so it cannot be stored without changing it',
    );
  }
  return value;
}

/**
 * Build the CSR return description for a grid.
 *
 * The shape here is deliberately the same as the profile hit-test's spatial
 * index build — a per-cell count pass, an exclusive prefix sum into a
 * `cellStart` array carrying a terminator entry, a placement cursor copied from
 * it, payloads stored in cell order, and an explicit count of the items that
 * fell outside — so a reader who knows one recognises the other. It is
 * reimplemented rather than imported because `src/model` must not depend on
 * `src/render`.
 *
 * The alternative, a dense `width * height * maxReturns` array, is mostly empty
 * whenever returns are sparse, which is the normal case.
 *
 * ORDERING: returns are NOT assumed to arrive in `returnIndex` order, and they
 * are sorted within each cell by `returnIndex` ascending, then by `record`
 * ascending. That is a real reordering and it is stated because it is one:
 * `returnIndex` is a physical fact about the pulse, so it travels with its own
 * record, count and range rather than being inferred from a position.
 *
 * The record tie-break is what makes the result a function of the ENTRIES
 * rather than of their arrival order. Two returns declaring the same index
 * previously kept the order the caller happened to supply, so the same records
 * read at a different stride, or merged in a different scan order, produced a
 * different frame. A total order over the values themselves cannot do that.
 */
export function buildCellReturns(
  width: number,
  height: number,
  entries: readonly CellReturnInput[],
): BuiltCellReturns {
  const cellCount = width * height;
  const counts = new Uint32Array(cellCount);
  const cellOf = new Int32Array(entries.length).fill(-1);
  let live = 0;
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]!;
    if (e.row < 0 || e.column < 0 || e.row >= height || e.column >= width) continue;
    const cell = cellIndexOf(e.row, e.column, width);
    cellOf[k] = cell;
    counts[cell]!++;
    live++;
  }

  // Terminator entry: `cellStart[cellCount]` is the total, so the LAST cell has
  // an end offset like every other. Without it the last span is unreadable.
  const returnCellStart = new Uint32Array(cellCount + 1);
  let running = 0;
  for (let c = 0; c < cellCount; c++) {
    running += counts[c]!;
    returnCellStart[c + 1] = running;
  }

  const cursor = new Uint32Array(cellCount);
  cursor.set(returnCellStart.subarray(0, cellCount));

  // Whether the source declared these at all is a property of the whole build,
  // so it is decided before anything is allocated and an undeclared column
  // costs no bytes rather than a run of stand-in zeroes.
  let declaresCount = false;
  let declaresRange = false;
  for (let k = 0; k < entries.length; k++) {
    if (cellOf[k]! < 0) continue;
    const e = entries[k]!;
    if (e.returnCount !== null && e.returnCount !== undefined) declaresCount = true;
    if (e.sourceRange !== null && e.sourceRange !== undefined) declaresRange = true;
  }

  const returnRecord = new Int32Array(live);
  const returnIndex = new Uint32Array(live);
  const returnCountDeclared = declaresCount ? new Uint32Array(live) : undefined;
  const returnSourceRange = declaresRange ? new Float32Array(live).fill(Number.NaN) : undefined;
  for (let k = 0; k < entries.length; k++) {
    const cell = cellOf[k]!;
    if (cell < 0) continue;
    const e = entries[k]!;
    const at = cursor[cell]!++;
    returnRecord[at] = e.record;
    returnIndex[at] = checkedReturnValue('returnIndex', e.returnIndex, k);
    if (returnCountDeclared && e.returnCount !== null && e.returnCount !== undefined) {
      returnCountDeclared[at] = checkedReturnValue('returnCount', e.returnCount, k);
    }
    if (returnSourceRange && e.sourceRange !== null && e.sourceRange !== undefined) {
      returnSourceRange[at] = e.sourceRange;
    }
  }

  // Insertion sort inside each span, on the pair (returnIndex, record). Spans
  // are a handful of returns. The pair is a total order over distinct records,
  // so the sorted span depends on the entries and not on how they arrived.
  for (let c = 0; c < cellCount; c++) {
    const start = returnCellStart[c]!;
    const end = returnCellStart[c + 1]!;
    for (let i = start + 1; i < end; i++) {
      const ri = returnIndex[i]!;
      const rec = returnRecord[i]!;
      const rc = returnCountDeclared ? returnCountDeclared[i]! : 0;
      const rr = returnSourceRange ? returnSourceRange[i]! : 0;
      let j = i - 1;
      while (j >= start && (returnIndex[j]! > ri || (returnIndex[j]! === ri && returnRecord[j]! > rec))) {
        returnIndex[j + 1] = returnIndex[j]!;
        returnRecord[j + 1] = returnRecord[j]!;
        if (returnCountDeclared) returnCountDeclared[j + 1] = returnCountDeclared[j]!;
        if (returnSourceRange) returnSourceRange[j + 1] = returnSourceRange[j]!;
        j--;
      }
      returnIndex[j + 1] = ri;
      returnRecord[j + 1] = rec;
      if (returnCountDeclared) returnCountDeclared[j + 1] = rc;
      if (returnSourceRange) returnSourceRange[j + 1] = rr;
    }
  }

  return {
    returnCellStart,
    returnRecord,
    returnIndex,
    ...(returnCountDeclared ? { returnCountDeclared } : {}),
    ...(returnSourceRange ? { returnSourceRange } : {}),
    skippedCount: entries.length - live,
  };
}

/**
 * The cell index a display record was decoded from, or null when this frame
 * produced no such record.
 *
 * EVERY surviving record answers here, not only the cell primaries. The CSR
 * arrays are consulted first because they list every return the frame kept,
 * while `cellToRecord` keeps one record per cell and so cannot answer for the
 * second and later returns of a multi-return pulse. Answering null for a record
 * that `returnsForCell` will happily hand back is the reverse direction
 * disagreeing with the forward one about which records exist.
 *
 * A frame whose linkage is unavailable answers null without scanning, because
 * `withLinkageUnavailable` has already erased the indices and a match against
 * the erased sentinel would be meaningless.
 */
export function cellIndexForRecord(frame: OrganizedRangeFrame, record: number): number | null {
  if (frame.linkage.kind === 'unavailable') return null;
  if (record < 0) return null;
  const { returnCellStart, returnRecord } = frame;
  if (returnCellStart && returnRecord) {
    for (let i = 0; i < returnRecord.length; i++) {
      if (returnRecord[i] !== record) continue;
      // The offset is inside exactly one cell's half-open span. Binary search
      // for the last start that does not exceed it, which is that cell.
      let low = 0;
      let high = returnCellStart.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (returnCellStart[mid]! <= i) low = mid;
        else high = mid - 1;
      }
      return low;
    }
    return null;
  }
  const map = frame.cellToRecord;
  for (let i = 0; i < map.length; i++) {
    if (map[i] === record) return i;
  }
  return null;
}

/**
 * Resolve every return of a cell.
 *
 * Zero, one and many are all `ok: true`: a described cell that produced nothing
 * answers with an empty list, which is evidence about the scene. A frame that
 * never described returns at all answers `ok: false` with `not-described`,
 * because that says nothing about the scene and must not be readable as "none".
 */
export function returnsForCell(
  frame: OrganizedRangeFrame,
  row: number,
  column: number,
):
  | { readonly ok: true; readonly returns: readonly CellReturn[] }
  | {
      readonly ok: false;
      readonly why: string;
      readonly reason: 'linkage-unavailable' | 'outside-grid' | 'not-described';
    } {
  if (frame.linkage.kind === 'unavailable') {
    return {
      ok: false,
      reason: 'linkage-unavailable',
      why: `Exact linking unavailable: ${frame.linkage.reason}.`,
    };
  }
  if (row < 0 || column < 0 || row >= frame.height || column >= frame.width) {
    return { ok: false, reason: 'outside-grid', why: 'Cell is outside the acquisition grid.' };
  }
  const { returnCellStart, returnRecord, returnIndex, returnCountDeclared, returnSourceRange } =
    frame;
  if (!returnCellStart || !returnRecord || !returnIndex) {
    return {
      ok: false,
      reason: 'not-described',
      why: 'This frame does not describe returns per cell.',
    };
  }
  const cell = cellIndexOf(row, column, frame.width);
  const start = returnCellStart[cell]!;
  const end = returnCellStart[cell + 1]!;
  const out: CellReturn[] = [];
  for (let i = start; i < end; i++) {
    // Absence stays absence on the way out. The count array is missing when the
    // source declared none, and a 0 substituted here would read as a pulse the
    // source described as empty.
    const range = returnSourceRange ? returnSourceRange[i]! : Number.NaN;
    out.push({
      record: returnRecord[i]!,
      returnIndex: returnIndex[i]!,
      returnCount: returnCountDeclared ? returnCountDeclared[i]! : null,
      sourceRange: Number.isFinite(range) ? range : null,
    });
  }
  return { ok: true, returns: out };
}
