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
  /** Length `width * height`. Display record index, or `NO_RECORD`. */
  readonly cellToRecord: Int32Array;
  /** Length `width * height`. Range in acquisition-local coordinates, NaN where absent. */
  readonly geometricRange?: Float32Array;
  /** Length `width * height`. Range the source itself declared, NaN where absent. */
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
