/**
 * loadPtx.ts
 *
 * PTX loader. A PTX file is one or more blocks ("clouds"), each a terrestrial
 * laser scan: a 10-line header — grid dimensions, the scanner pose, and a 4×4
 * registration transform — followed by `cols × rows` point lines
 * (`x y z intensity [r g b]`) in the scanner's local frame.
 *
 * Each block's points are transformed to world coordinates by its own 4×4
 * matrix, so a multi-block PTX registers into one consistent cloud. Empty grid
 * cells (a `0 0 0` line — a non-return) are skipped. A malformed block stops
 * further block parsing but never discards the blocks already read.
 *
 * Pure (no DOM, no three.js) — runs in the parse worker.
 */

import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import {
  sanitizeAndRecenter,
  withLoadWarning,
  outputRecordFor,
  RECORD_DROPPED,
  RECORD_NOT_WITNESSED,
  type CompactionWitness,
} from './sanitizeCloud';
import {
  CellState,
  NO_RECORD,
  cellIndexOf,
  ptxCellFromOrdinal,
  tallyCellStates,
  type AcquisitionPose,
  withLinkageUnavailable,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../model/OrganizedRange';

/**
 * Rewrite one frame's `cellToRecord` from pre-sanitation record indices to the
 * indices the display cloud actually holds.
 *
 * Returns `null` when the witness cannot answer for a record the frame claims,
 * which the caller turns into the honest degrade. Guessing here would be the
 * one failure this whole sidecar exists to prevent: an index that is present,
 * plausible, and points at another return.
 *
 * A cell whose record did not survive becomes NOT_DECODED. The scanner did get
 * a return there — the geometric range still proves it — so NO_RETURN would
 * report a decoding loss as an instrument observation. NOT_DECODED says what is
 * true: a record exists in the file and this session did not carry it through.
 */
function remapFrame(
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
  return { ...frame, cellState, cellToRecord, diagnostics: tallyCellStates(cellState) };
}

/**
 * Remap every frame, or none of them.
 *
 * A set where one frame links exactly and another silently lost its identity
 * would be read as uniformly trustworthy, so a single unanswerable frame sends
 * the whole set down the degrade path.
 */
function remapFrames(
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

/** A parsed 4×4 PTX transform — four rows of four numbers. */
type Mat4 = [number[], number[], number[], number[]];

/** The 4×4 identity — the fallback transform for a block with a bad matrix. */
const IDENTITY: Mat4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

/** The PTX header is two count lines, four pose lines, then four matrix lines. */
const HEADER_LINES = 10;

/** Split a line into tokens on any run of whitespace. */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Parse a matrix line into four floats. Non-finite or missing entries
 * are preserved as `NaN` so the caller can detect a malformed
 * transform — substituting `0` here would defeat `matrixIsFinite` and
 * silently apply a partially-zeroed transform that collapses or
 * mislocates the scan.
 */
function parseRow4(line: string | undefined): number[] {
  const tok = tokenize(line ?? '');
  const row = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  for (let i = 0; i < 4; i++) {
    row[i] = Number(tok[i]);
  }
  return row;
}

/**
 * Parse three floats from a header line, NaN-seeded like `parseRow4` so a
 * missing or non-numeric entry is detectable rather than silently zero. A
 * zeroed scanner position is a plausible origin and would be indistinguishable
 * from a real one at the coordinate system's centre.
 */
function parseRow3(line: string | undefined): number[] {
  const tok = tokenize(line ?? '');
  return [Number(tok[0] ?? Number.NaN), Number(tok[1] ?? Number.NaN), Number(tok[2] ?? Number.NaN)];
}

/** Whether every entry of a parsed transform is finite. */
function matrixIsFinite(m: Mat4): boolean {
  return m.every((row) => row.length === 4 && row.every((v) => Number.isFinite(v)));
}

/**
 * A random-access view over the lines of `text` that never materialises them.
 *
 * PTX is read by index — a block header is ten lines deep, and the walk looks
 * ahead — so the lines cannot simply be streamed. Splitting the file instead
 * held one JS string per line, and a scan with millions of points pays tens of
 * bytes of per-string object overhead on top of the characters themselves,
 * dwarfing the text it came from. An offset table costs four bytes a line and
 * slices only the line actually being read.
 */
class LineIndex {
  private readonly _text: string;
  private readonly _starts: Int32Array;
  readonly length: number;

  constructor(text: string) {
    this._text = text;
    let breaks = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) breaks++;
    // One more line than there are breaks, plus a sentinel so the last line's
    // end needs no special case. This mirrors `split(/\r?\n/)`, which yields a
    // trailing empty entry for a file that ends in a newline.
    this._starts = new Int32Array(breaks + 2);
    let k = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this._starts[k++] = i + 1;
    }
    this._starts[k] = text.length + 1;
    this.length = breaks + 1;
  }

  at(i: number): string {
    if (i < 0 || i >= this.length) return '';
    const start = this._starts[i];
    let end = this._starts[i + 1] - 1;
    // Drop the CR of a CRLF pair, matching the `\r?\n` split this replaced.
    if (end > start && this._text.charCodeAt(end - 1) === 13) end--;
    return this._text.slice(start, end);
  }
}

/**
 * Load a `.ptx` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.ptx"`).
 */
export async function loadPtx(buffer: ArrayBuffer, name = 'cloud.ptx'): Promise<PointCloud> {
  const lines = new LineIndex(new TextDecoder().decode(buffer));

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const intensityVals: number[] = [];
  const rgb: number[] = [];
  // `null` until the first point decides whether the file carries colour.
  let hasColor: boolean | null = null;
  let scannerOrigin: [number, number, number] | undefined;
  // Per-block load warnings. A dropped registration or a grid that ran out of
  // lines leaves only finite, plausible coordinates behind, so the sanitiser —
  // which reports non-finite points — never sees them. They are surfaced here
  // instead, on the same load-warning channel the Scan Report already reads.
  const blockWarnings: string[] = [];
  let blockIndex = 0;

  // One frame per block. A PTX block is a SCANNER SETUP, not a temporal frame,
  // so each keeps its own grid, its own pose and its own cell-to-record map.
  // Flattening them into one grid would merge two instruments' views of
  // different directions into a raster that means nothing.
  const frames: OrganizedRangeFrame[] = [];

  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between blocks and any trailing newline.
    while (i < lines.length && lines.at(i).trim() === '') i++;
    if (i >= lines.length) break;

    // Block header — columns and rows.
    const cols = Number(tokenize(lines.at(i))[0]);
    const rows = Number(tokenize(lines.at(i + 1))[0]);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 0 || rows < 0) {
      break; // not a valid block header — stop, keeping the blocks already read
    }
    if (i + HEADER_LINES > lines.length) break; // truncated header
    blockIndex++;

    // The 4×4 transform sits in header lines 7–10 (after the two count lines
    // and four pose lines). PTX stores it row-major with translation in row 4.
    const parsed: Mat4 = [
      parseRow4(lines.at(i + 6)),
      parseRow4(lines.at(i + 7)),
      parseRow4(lines.at(i + 8)),
      parseRow4(lines.at(i + 9)),
    ];
    // A finite matrix is used as read — including a legitimate identity, which
    // is exactly how a single-scan PTX registers, and is not an error. A
    // NON-finite matrix is different: a row failed to parse (parseRow4 seeds
    // NaN for a missing or non-numeric token), so the file's registration is
    // corrupt. Substituting identity keeps the loader alive, but silently:
    // that block's points would render in raw scanner-local coordinates —
    // finite, plausible, and overlapping the world-registered blocks with no
    // other trace. So the substitution is announced, naming the block, and only
    // for the corrupt case — never for a matrix that legitimately IS identity.
    const registrationValid = matrixIsFinite(parsed);
    const m = registrationValid ? parsed : IDENTITY;
    if (!registrationValid) {
      blockWarnings.push(
        `Block ${blockIndex}: its 4×4 registration transform could not be parsed ` +
          `(a row held a non-numeric or missing entry), so the identity transform ` +
          `was substituted — that block is placed in raw scanner-local coordinates ` +
          `and may not register with the rest of the cloud.`,
      );
    }
    // PTX carries two positions in different frames, and the loader keeps both
    // rather than choosing. The header line after the two counts is the scanner
    // position in the SCANNER's own frame, which is `0 0 0` for ordinary
    // scanner-local data. The transform's translation row is where that scanner
    // sits once registered, which is what `metadata.scannerOrigin` has always
    // meant and continues to mean.
    const declared = parseRow3(lines.at(i + 2));
    const declaredOk = declared.every((v) => Number.isFinite(v));
    const blockOrigin: [number, number, number] = [m[3][0], m[3][1], m[3][2]];
    const pose: AcquisitionPose = {
      worldTranslation: blockOrigin,
      localPosition: declaredOk ? [declared[0], declared[1], declared[2]] : undefined,
      transform: m,
      localPositionSource: declaredOk ? 'source-declared' : 'unreadable',
    };
    scannerOrigin ??= blockOrigin;
    i += HEADER_LINES;

    const total = cols * rows;
    // Seeded with SOURCE_RECORD_MISSING so a block that runs out of lines
    // leaves its unread tail saying exactly that, with no second pass.
    const cellState = new Uint8Array(total).fill(CellState.SOURCE_RECORD_MISSING);
    const cellToRecord = new Int32Array(total).fill(NO_RECORD);
    const geometricRange = new Float32Array(total).fill(Number.NaN);
    let p = 0;
    for (; p < total && i < lines.length; p++, i++) {
      // The ordinal advances on every path below, including the skips, so the
      // cell address is sound even for a line that produced no point.
      const cell = ptxCellFromOrdinal(p, rows);
      const ci = cellIndexOf(cell.row, cell.column, cols);

      const tok = tokenize(lines.at(i));
      if (tok.length < 4) {
        // A malformed line is a defect in the file, not a statement about the
        // scene. It is NOT a no-return, and collapsing the two would report a
        // parse failure as an instrument observation.
        cellState[ci] = CellState.SOURCE_INVALID;
        continue;
      }
      const lx = Number(tok[0]);
      const ly = Number(tok[1]);
      const lz = Number(tok[2]);
      if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) {
        cellState[ci] = CellState.SOURCE_INVALID;
        continue;
      }
      // A 0 0 0 sample marks an empty grid cell (no laser return) — not a point.
      if (lx === 0 && ly === 0 && lz === 0) {
        cellState[ci] = CellState.NO_RETURN;
        continue;
      }

      // Geometric range in ACQUISITION-LOCAL coordinates, before the world
      // transform below. Computing it after registration would subtract two
      // large world coordinates and lose most of the precision to
      // cancellation, and it would make the value depend on the registration
      // being correct.
      geometricRange[ci] = Math.hypot(lx, ly, lz);
      cellState[ci] = CellState.VALID_RETURN;
      cellToRecord[ci] = xs.length;

      // world = [x y z 1] · M — points are row vectors in the scanner frame.
      const wx = lx * m[0][0] + ly * m[1][0] + lz * m[2][0] + m[3][0];
      const wy = lx * m[0][1] + ly * m[1][1] + lz * m[2][1] + m[3][1];
      const wz = lx * m[0][2] + ly * m[1][2] + lz * m[2][2] + m[3][2];

      xs.push(wx);
      ys.push(wy);
      zs.push(wz);

      const it = Number(tok[3]);
      intensityVals.push(Number.isFinite(it) ? it : 0);

      hasColor ??= tok.length >= 7;
      if (hasColor) {
        rgb.push(Number(tok[4]) || 0, Number(tok[5]) || 0, Number(tok[6]) || 0);
      }
    }
    // Each iteration consumes exactly one input line per grid cell — empty
    // 0 0 0 non-returns and short lines are skipped but still advance `p` — so
    // a complete block always reaches `total`. Ending short means the only
    // other way out: the file ran out of lines mid-block (the `i < lines.length`
    // guard failed), i.e. the scan is truncated and what was read is a fragment.
    if (p < total) {
      blockWarnings.push(
        `Block ${blockIndex}: the file ended after ${p} of ${total} declared ` +
          `grid cells (${cols}×${rows}) — the block is truncated, so only part ` +
          `of the scan was read.`,
      );
    }

    frames.push({
      id: `setup-${blockIndex}`,
      sourceKind: 'ptx-grid',
      width: cols,
      height: rows,
      cellState,
      cellToRecord,
      geometricRange,
      acquisitionPose: pose,
      // Exact for now. Sanitation runs after every block is read and may drop
      // records; the check after it downgrades every frame if it does.
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
    });
  }

  const count = xs.length;
  if (count === 0) throw new Error('PTX file has no readable points');

  // Recentre the world coordinates through the float64 coordinate bridge.
  const global = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    global[p * 3] = xs[p];
    global[p * 3 + 1] = ys[p];
    global[p * 3 + 2] = zs[p];
  }

  // Intensity — PTX intensity is conventionally a 0–1 float; that range is
  // rescaled to the full Uint16 span, otherwise it is taken as a raw value.
  let maxI = 0;
  for (const v of intensityVals) maxI = Math.max(maxI, v);
  const scale = maxI > 0 && maxI <= 1 ? 65535 : 1;
  const intensity = new Uint16Array(count);
  for (let p = 0; p < count; p++) {
    const v = Math.round(intensityVals[p] * scale);
    intensity[p] = Math.max(0, Math.min(65535, v));
  }

  // Colour — PTX RGB, when present, is 0–255 per channel.
  let colors: Uint8Array | undefined;
  if (hasColor) {
    colors = new Uint8Array(count * 3);
    for (let k = 0; k < count * 3; k++) {
      const v = Math.round(rgb[k]);
      colors[k] = Math.max(0, Math.min(255, v));
    }
  }

  // Release the JS number[] accumulators now that the typed positions /
  // intensity / colour outputs are built — the same memory-spike trim loadXyz
  // does, so a large PTX scan doesn't hold the boxed-number arrays alongside
  // the typed buffers (a transient 2–3× heap peak otherwise).
  xs.length = 0; ys.length = 0; zs.length = 0;
  intensityVals.length = 0; rgb.length = 0;

  let metadata: CloudMetadata | undefined = scannerOrigin ? { scannerOrigin } : undefined;
  // Fold in any per-block registration / truncation warnings first, then let
  // the sanitiser append its own below — all on the one load-warning channel.
  for (const w of blockWarnings) metadata = withLoadWarning(metadata, w);

  // The point reader already refuses a non-numeric x/y/z, but the registration
  // transform is applied after that check, so this is where a world coordinate
  // that overflowed the block's matrix is caught — and where the survivors get
  // their floored-min origin.
  const clean = sanitizeAndRecenter(global, { colors, intensity }, { witness: true });

  // Sanitation compacts survivors, so any drop shifts every record index after
  // the first casualty. The witness is what turns that shift into an answerable
  // question: it says where each source record landed, or that it landed
  // nowhere, so the grid can be rewritten instead of disowned.
  //
  // The degrade below stays. It is still the correct behaviour whenever the
  // witness cannot cover what the frames claim, and it is what a future caller
  // that does not ask for a witness would get.
  const remapped =
    clean.excludedCount === 0 || !clean.witness || clean.witness.sourceCount !== count
      ? null
      : remapFrames(frames, clean.witness);

  const built: OrganizedRangeSet | undefined =
    frames.length === 0
      ? undefined
      : {
          kind: 'organized-range',
          frames: remapped ?? frames,
          organization: frames.length > 1 ? 'multi-grid' : 'organized-grid',
        };
  const organizedRange =
    built === undefined || clean.excludedCount === 0 || remapped !== null
      ? built
      : withLinkageUnavailable(built, 'source-record-identity-unavailable');

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    organizedRange,
    origin: clean.origin,
    sourceFormat: 'ptx',
    name,
    decodedPointCount: count,
    metadata: withLoadWarning(metadata, clean.warning),
  });
}
