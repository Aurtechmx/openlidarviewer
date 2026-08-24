/**
 * loadPcd.ts
 *
 * PCD (Point Cloud Data) loader. PCD has three body encodings — `ascii`,
 * `binary`, and `binary_compressed` (the last LZF-compressed). Rather than
 * re-implement the LZF decompressor, decoding is delegated to three.js's vetted
 * `PCDLoader`; this module adapts its output into the viewer's `PointCloud` —
 * recentred through the coordinate bridge, with attributes normalised to the
 * viewer's typed-array conventions.
 *
 * One exception: `PCDLoader` parses positions into a Float32Array, which
 * truncates double-precision sources (ascii bodies, binary bodies with 8-byte
 * float x/y/z) before the origin could be subtracted. For those encodings the
 * x/y/z columns are re-read here in f64 so the coordinate bridge gets full
 * precision — see the position paths in {@link loadPcd}.
 *
 * `PCDLoader.parse` builds only data (no DOM), so this runs in the parse worker.
 */

import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
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
  pcdCellFromOrdinal,
  tallyCellStates,
  type AcquisitionPose,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../model/OrganizedRange';

/** Round and clamp a value into the 0–255 byte range. */
function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/** Round and clamp a value into the 0–65535 Uint16 range. */
function clampU16(v: number): number {
  if (v < 0) return 0;
  if (v > 65535) return 65535;
  return Math.round(v);
}

/**
 * The acquisition viewpoint a PCD header declares.
 *
 * PCD writes it as `tx ty tz qw qx qy qz`: a translation followed by a
 * quaternion whose SCALAR COMPONENT COMES FIRST. The scalar-first order is
 * carried in the field names rather than a comment, because the alternative —
 * a four-number tuple — reads identically whichever convention produced it.
 */
interface PcdViewpoint {
  readonly translation: readonly [number, number, number];
  readonly rotation: {
    readonly w: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

/** The subset of PCD header facts the f64 position path needs. */
interface PcdHeaderFacts {
  /** Body encoding — `ascii`, `binary` or `binary_compressed`. */
  data: string;
  /** Field names in record order, lower-cased. */
  fields: string[];
  sizes: number[];
  types: string[];
  counts: number[];
  points: number;
  /** Declared columns. For an unorganized cloud this is the whole point count. */
  width: number;
  /** Declared rows. `1` for an unorganized cloud. */
  height: number;
  /**
   * The declared viewpoint, or `undefined` when the header carries no
   * VIEWPOINT line. The default `0 0 0 1 0 0 0` and an absent line are kept
   * apart: one is the file stating where the sensor was, the other is the file
   * saying nothing.
   */
  viewpoint?: PcdViewpoint;
  /** Offset of the first body byte (matches PCDLoader's `headerLen`). */
  bodyOffset: number;
}

/**
 * Byte length of the PCD header — the offset just past the newline that closes
 * the DATA line. The header is ASCII and DATA is always its last line, so a
 * byte scan locates it without decoding the (possibly binary, possibly huge)
 * body as text. Returns the whole buffer length when no DATA line is found, so
 * the regex in {@link parsePcdHeaderFacts} still gets its chance to fail.
 */
function pcdHeaderByteLength(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  const n = bytes.length;
  for (let i = 1; i + 3 < n; i++) {
    // DATA must OPEN a line — the body regex requires a newline right before
    // it, which also rules out a FIELDS/comment token that merely spells "data".
    const prev = bytes[i - 1];
    if (prev !== 10 && prev !== 13) continue;
    if (
      (bytes[i] === 0x44 || bytes[i] === 0x64) && // D d
      (bytes[i + 1] === 0x41 || bytes[i + 1] === 0x61) && // A a
      (bytes[i + 2] === 0x54 || bytes[i + 2] === 0x74) && // T t
      (bytes[i + 3] === 0x41 || bytes[i + 3] === 0x61) // A a
    ) {
      // Consume the encoding token and the line's terminator (LF, or CRLF) so
      // the decoded prefix carries the whitespace the DATA regex needs after
      // the token — then stop, one line short of any body byte.
      let j = i + 4;
      while (j < n && bytes[j] !== 10 && bytes[j] !== 13) j++;
      if (j < n && bytes[j] === 13) j++; // CR of a CRLF pair
      if (j < n && bytes[j] === 10) j++; // LF
      return j;
    }
  }
  return n;
}

/**
 * Parse the PCD text header. The header is ASCII by spec, so character
 * offsets into the decoded prefix equal byte offsets into the buffer.
 * Returns `null` when the header cannot be resolved — the caller falls back
 * to PCDLoader's positions.
 */
function parsePcdHeaderFacts(buffer: ArrayBuffer): PcdHeaderFacts | null {
  // Decode only the header — up to and including the DATA line — never the
  // body. A fixed 4 KiB probe silently truncated here: a valid header with many
  // FIELDS or long comments can push DATA past it, and a miss returned null,
  // which switched the f64 precision path OFF and let PCDLoader's f32 positions
  // through with no warning — quantising a UTM easting to a few centimetres.
  // PCDLoader scans the WHOLE buffer for DATA, so matching that is what keeps
  // the two parsers agreeing on every file both accept.
  const probe = new TextDecoder().decode(
    new Uint8Array(buffer, 0, pcdHeaderByteLength(buffer)),
  );
  // The same pattern PCDLoader uses to locate the body, so `bodyOffset`
  // agrees with its `headerLen` on every file both parsers accept.
  const m = /[\r\n]DATA\s(\S*)\s/i.exec(probe);
  if (!m) return null;

  const facts: PcdHeaderFacts = {
    data: m[1].toLowerCase(),
    fields: [],
    sizes: [],
    types: [],
    counts: [],
    points: 0,
    width: 0,
    height: 0,
    bodyOffset: m.index + m[0].length,
  };
  for (const raw of probe.slice(0, m.index).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tok = line.split(/\s+/);
    const key = tok[0].toUpperCase();
    if (key === 'FIELDS') facts.fields = tok.slice(1).map((f) => f.toLowerCase());
    else if (key === 'SIZE') facts.sizes = tok.slice(1).map(Number);
    else if (key === 'TYPE') facts.types = tok.slice(1).map((t) => t.toUpperCase());
    else if (key === 'COUNT') facts.counts = tok.slice(1).map(Number);
    else if (key === 'POINTS') facts.points = Number(tok[1]);
    else if (key === 'WIDTH') facts.width = Number(tok[1]);
    else if (key === 'HEIGHT') facts.height = Number(tok[1]);
    else if (key === 'VIEWPOINT') {
      const v = tok.slice(1, 8).map(Number);
      // A partial or non-numeric VIEWPOINT is not a viewpoint. Reading it as
      // one would place the sensor at a position the file never gave.
      if (v.length === 7 && v.every((n) => Number.isFinite(n))) {
        facts.viewpoint = {
          translation: [v[0], v[1], v[2]],
          rotation: { w: v[3], x: v[4], y: v[5], z: v[6] },
        };
      }
    }
  }
  // COUNT is optional and defaults to 1 per field; POINTS to WIDTH × HEIGHT.
  if (facts.counts.length === 0) facts.counts = facts.fields.map(() => 1);
  if (!(facts.points > 0)) facts.points = facts.width * facts.height;
  return facts;
}

/**
 * Re-read the x/y/z columns of a PCD body in double precision, for the
 * encodings that actually carry it: ascii text, and binary records whose
 * x/y/z are 8-byte floats. Returns interleaved global coordinates, or `null`
 * when the source is single-precision (nothing to save) — the caller then uses
 * PCDLoader's positions.
 *
 * Returning a non-null array is also the ONLY evidence in this module that OLV
 * walked the record stream itself. {@link loadPcd} reads it that way when it
 * decides whether cell-to-record identity can be claimed.
 */
function extractPcdPositionsF64(buffer: ArrayBuffer, facts: PcdHeaderFacts): Float64Array | null {
  const { fields, sizes, types, counts } = facts;
  if (sizes.length !== fields.length || counts.length !== fields.length) return null;
  const xi = fields.indexOf('x');
  const yi = fields.indexOf('y');
  const zi = fields.indexOf('z');
  if (xi < 0 || yi < 0 || zi < 0) return null;

  if (facts.data === 'ascii') {
    // Token column of a field = the COUNT-widths of the fields before it.
    const colOf = (fi: number): number => {
      let col = 0;
      for (let i = 0; i < fi; i++) col += counts[i];
      return col;
    };
    const cx = colOf(xi);
    const cy = colOf(yi);
    const cz = colOf(zi);
    const body = new TextDecoder().decode(buffer).slice(facts.bodyOffset);
    // Walk the body once into a preallocated buffer. Splitting it into lines and
    // each line into tokens held one string per line plus a growing number[]
    // that was then copied again into the typed array — four live copies of the
    // cloud at the peak, to read three columns per row.
    // Bound the row count by what the body can physically hold before sizing
    // the buffer. A row needs at least a coordinate token and a separator, so
    // the body cannot contain more rows than half its length. Without this, a
    // header that lies about POINTS (or WIDTH×HEIGHT) sizes this Float64Array
    // from an unchecked number — and because this runs OUTSIDE loadPcd's
    // try/finally, a wild count throws a raw RangeError (or crashes the
    // allocator) rather than degrading to the clean "could not be read" path.
    // The binary branch already cross-checks POINTS against the byte length;
    // this is the ascii equivalent. The honest row count can never exceed this
    // ceiling, so a well-formed file reads exactly as before.
    const rowCeiling = Math.floor(body.length / 2) + 1;
    const declaredRows = facts.points > 0 ? facts.points : countPcdRows(body);
    const maxRows = Math.min(declaredRows, rowCeiling);
    const out = new Float64Array(maxRows * 3);
    const n = body.length;
    let pos = 0;
    let row = 0;
    while (pos < n && row < maxRows) {
      // Skip blank lines, then read the row's fields in place.
      while (pos < n && isPcdSpace(body.charCodeAt(pos))) pos++;
      if (pos >= n) break;
      let col = 0;
      let wrote = false;
      while (pos < n) {
        const c = body.charCodeAt(pos);
        if (c === 10 || c === 13) break; // end of row
        if (c === 32 || c === 9) {
          pos++;
          continue;
        }
        const start = pos;
        while (pos < n && !isPcdSpace(body.charCodeAt(pos))) pos++;
        if (col === cx) {
          out[row * 3] = Number(body.slice(start, pos));
          wrote = true;
        } else if (col === cy) out[row * 3 + 1] = Number(body.slice(start, pos));
        else if (col === cz) out[row * 3 + 2] = Number(body.slice(start, pos));
        col++;
      }
      if (wrote) row++;
    }
    return row * 3 === out.length ? out : out.subarray(0, row * 3);
  }

  if (facts.data === 'binary') {
    if (types.length !== fields.length) return null;
    // Only 8-byte float fields hold precision beyond what PCDLoader keeps.
    const isF64 = (i: number): boolean => types[i] === 'F' && sizes[i] === 8;
    if (!isF64(xi) || !isF64(yi) || !isF64(zi)) return null;
    let rowSize = 0;
    const byteOffsets: number[] = [];
    for (let i = 0; i < fields.length; i++) {
      byteOffsets.push(rowSize);
      rowSize += sizes[i] * counts[i];
    }
    const points = facts.points;
    if (!(points > 0) || facts.bodyOffset + points * rowSize > buffer.byteLength) return null;
    const view = new DataView(buffer);
    const out = new Float64Array(points * 3);
    for (let i = 0; i < points; i++) {
      const base = facts.bodyOffset + i * rowSize;
      out[i * 3] = view.getFloat64(base + byteOffsets[xi], true);
      out[i * 3 + 1] = view.getFloat64(base + byteOffsets[yi], true);
      out[i * 3 + 2] = view.getFloat64(base + byteOffsets[zi], true);
    }
    return out;
  }

  // binary_compressed — the LZF-packed source is f32; PCDLoader's output
  // already carries everything the file had.
  return null;
}

/** What the header claims about organization, once the records have their say. */
type PcdOrganization =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly warning: string }
  | { readonly kind: 'grid'; readonly width: number; readonly height: number };

/**
 * Decide whether an organized grid can be recorded for this file.
 *
 * A declared grid is a CLAIM, and the sidecar costs about nine bytes per cell,
 * so the claim is never what sizes the allocation. The bound is the DECODED
 * RECORD COUNT: the grid is accepted only when `WIDTH × HEIGHT` equals the
 * number of records the file actually supplied, which is also the only case
 * where a cell has a record to correspond to. A header reading `100000 1000`
 * over an 87-byte body therefore allocates nothing, rather than 900 MB.
 *
 * `HEIGHT > 1` is PCL's own test for an organized dataset (`PointCloud::at`
 * throws `UnorganizedPointCloudException` below it), so a HEIGHT of 1 is an
 * ordinary unorganized cloud and not a one-row grid.
 */
function pcdOrganization(facts: PcdHeaderFacts, decodedCount: number): PcdOrganization {
  const { width, height } = facts;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return { kind: 'none' };
  if (!(width > 0) || !(height > 1)) return { kind: 'none' };
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells !== decodedCount) {
    return {
      kind: 'refused',
      warning:
        `The header declares an organized ${width} × ${height} grid ` +
        `(${cells} cells), and ${decodedCount} records were read from the file. ` +
        `No acquisition grid is recorded: a grid the records contradict cannot ` +
        `be mapped to them without inventing the correspondence.`,
    };
  }
  return { kind: 'grid', width, height };
}

/**
 * Build the acquisition grid for a file whose records line up with its header.
 *
 * `linked` is what separates the two encodings families. For ascii and 8-byte
 * float binary bodies OLV walks the records itself, so ordinal `i` in the grid
 * IS display record `i`, and the linkage is exact. For 4-byte float binary and
 * `binary_compressed` bodies both the count and the ORDER come from three.js's
 * PCDLoader, which OLV does not test record for record; inferring an ordering
 * from it would be exactly the invented correspondence this sidecar exists to
 * prevent. Those files keep the topology and the pose and claim no identity.
 */
function buildPcdFrame(
  grid: { readonly width: number; readonly height: number },
  global: Float64Array,
  viewpoint: PcdViewpoint | undefined,
  linked: boolean,
): OrganizedRangeFrame {
  const { width, height } = grid;
  const cells = width * height;
  const cellState = new Uint8Array(cells).fill(CellState.NOT_DECODED);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  if (linked) {
    for (let i = 0; i < cells; i++) {
      const cell = pcdCellFromOrdinal(i, width);
      const ci = cellIndexOf(cell.row, cell.column, width);
      const finite =
        Number.isFinite(global[i * 3]) &&
        Number.isFinite(global[i * 3 + 1]) &&
        Number.isFinite(global[i * 3 + 2]);
      // A non-finite record is SOURCE_INVALID: the file holds a record here and
      // declares it unusable. It is NOT a no-return. PCD has no no-return
      // semantics — nothing in the format says the sensor looked along a
      // direction and got nothing back — so this loader must never produce
      // CellState.NO_RETURN, whatever a cell's contents look like.
      cellState[ci] = finite ? CellState.VALID_RETURN : CellState.SOURCE_INVALID;
      if (finite) cellToRecord[ci] = i;
    }
  }
  const pose: AcquisitionPose | undefined = viewpoint
    ? {
        worldTranslation: viewpoint.translation,
        // PCD declares one viewpoint and no second, scanner-frame position, so
        // there is no `localPosition` here to be readable or malformed.
        localPositionSource: 'not-applicable',
        rotation: viewpoint.rotation,
        rotationSource: 'source-declared',
      }
    : undefined;
  return {
    id: 'pcd-grid',
    sourceKind: 'pcd-organized',
    width,
    height,
    cellState,
    cellToRecord,
    acquisitionPose: pose,
    linkage: linked
      ? { kind: 'exact' }
      : { kind: 'unavailable', reason: 'source-record-identity-unavailable' },
    diagnostics: tallyCellStates(cellState),
  };
}

/**
 * Rewrite a frame's record indices from pre-sanitation to display indices.
 *
 * Returns `null` when the witness cannot answer for an index the frame claims,
 * which the caller turns into the honest degrade rather than a guess.
 */
function remapPcdFrame(
  frame: OrganizedRangeFrame,
  witness: CompactionWitness,
): OrganizedRangeFrame | null {
  const cellState = new Uint8Array(frame.cellState);
  const cellToRecord = new Int32Array(frame.cellToRecord);
  for (let ci = 0; ci < cellToRecord.length; ci++) {
    const source = cellToRecord[ci];
    if (source === NO_RECORD) continue;
    const output = outputRecordFor(witness, source);
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
 * Load a `.pcd` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.pcd"`).
 */
export async function loadPcd(buffer: ArrayBuffer, name = 'cloud.pcd'): Promise<PointCloud> {
  let points;
  // PCDLoader.parse computes a bounding sphere internally; on a file whose x/y/z
  // carry a non-finite value, three's BufferGeometry logs "computeBoundingSphere():
  // Computed radius is NaN" — through console.ERROR (its `error` helper), not warn —
  // BEFORE we sanitise. We exclude those points below and report them through the
  // loader's own warning channel, so silence just that one message on both console
  // methods for the duration of the parse; never globally, restored in `finally`.
  const isBoundingRadiusNaN = (args: unknown[]): boolean =>
    typeof args[0] === 'string' &&
    args[0].includes('computeBoundingSphere') &&
    args[0].includes('NaN');
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]): void => {
    if (isBoundingRadiusNaN(args)) return;
    originalWarn.apply(console, args as []);
  };
  console.error = (...args: unknown[]): void => {
    if (isBoundingRadiusNaN(args)) return;
    originalError.apply(console, args as []);
  };
  try {
    points = new PCDLoader().parse(buffer);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    throw new Error(`This PCD file could not be read${detail}`);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  const geometry = points.geometry;

  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    throw new Error('PCD file has no readable points');
  }
  const count = posAttr.count;

  // Positions, split on what precision the source actually carries:
  //  - ascii bodies and binary bodies with 8-byte float x/y/z hold full
  //    doubles, but PCDLoader parses them into a Float32Array — a UTM-scale
  //    easting snaps to a centimetre grid before the origin could ever be
  //    subtracted. For those the x/y/z columns are re-read in f64 and the
  //    origin subtraction happens in double precision; `recenter` narrows to
  //    f32 only on the small local residuals.
  //  - f32 binary and binary_compressed bodies have no extra precision to
  //    save, so PCDLoader's values are widened verbatim — nothing is gained or
  //    lost by staging them, and both encodings then share one recentring path.
  // The row-count guard keeps the f64 re-read honest: if it ever disagrees
  // with what PCDLoader decoded, PCDLoader's rows win.
  const facts = parsePcdHeaderFacts(buffer);
  const reread = facts ? extractPcdPositionsF64(buffer, facts) : null;
  // True only when OLV walked the record stream itself and reached the same
  // record count PCDLoader did. Cell-to-record identity is claimed on this and
  // nothing else.
  const walkedRecords = reread?.length === count * 3;
  let global: Float64Array;
  if (walkedRecords && reread) {
    global = reread;
  } else {
    global = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      global[i * 3] = posAttr.getX(i);
      global[i * 3 + 1] = posAttr.getY(i);
      global[i * 3 + 2] = posAttr.getZ(i);
    }
  }

  // Colour — PCDLoader yields 0–1 floats; the viewer stores 0–255 bytes.
  let colors: Uint8Array | undefined;
  const colorAttr = geometry.getAttribute('color');
  if (colorAttr) {
    colors = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = clampByte(colorAttr.getX(i) * 255);
      colors[i * 3 + 1] = clampByte(colorAttr.getY(i) * 255);
      colors[i * 3 + 2] = clampByte(colorAttr.getZ(i) * 255);
    }
  }

  // Normals — carried through unchanged when the file provides them.
  let normals: Float32Array | undefined;
  const normalAttr = geometry.getAttribute('normal');
  if (normalAttr) {
    normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      normals[i * 3] = normalAttr.getX(i);
      normals[i * 3 + 1] = normalAttr.getY(i);
      normals[i * 3 + 2] = normalAttr.getZ(i);
    }
  }

  // Intensity — PCD intensity is a float of no fixed range. The viewer stores
  // a Uint16: a 0–1 file is rescaled to the full range so the colour ramp and
  // the inspector stay meaningful; a larger range is taken as a raw value.
  let intensity: Uint16Array | undefined;
  const intensityAttr = geometry.getAttribute('intensity');
  if (intensityAttr) {
    let maxI = 0;
    for (let i = 0; i < count; i++) maxI = Math.max(maxI, intensityAttr.getX(i));
    const scale = maxI > 0 && maxI <= 1 ? 65535 : 1;
    intensity = new Uint16Array(count);
    for (let i = 0; i < count; i++) intensity[i] = clampU16(intensityAttr.getX(i) * scale);
  }

  // Labels — PCD's per-point label maps to the classification slot.
  let classification: Uint8Array | undefined;
  const labelAttr = geometry.getAttribute('label');
  if (labelAttr) {
    classification = new Uint8Array(count);
    for (let i = 0; i < count; i++) classification[i] = clampByte(labelAttr.getX(i));
  }

  // Drop unplaceable points — a binary body can carry a NaN bit pattern, an
  // ascii one the literal token — and recentre the survivors. `count` stays the
  // DECODED count: the file really did hold that many records, and the warning
  // is where the exclusion is reported.
  // Header facts and grid VALIDATION apply to every encoding; only the record
  // identity inside the frame depends on which body OLV can walk.
  const organization = facts ? pcdOrganization(facts, count) : { kind: 'none' as const };
  let metadata: CloudMetadata | undefined;
  if (organization.kind === 'refused') {
    metadata = withLoadWarning(metadata, organization.warning);
  }
  const frame =
    organization.kind === 'grid'
      ? buildPcdFrame(organization, global, facts?.viewpoint, walkedRecords)
      : undefined;

  const clean = sanitizeAndRecenter(
    global,
    { colors, intensity, classification, normals },
    // The witness costs an Int32Array only when something was actually
    // dropped, and it is the only way a linked grid survives compaction.
    { witness: frame !== undefined && walkedRecords },
  );

  // Sanitation compacts survivors, so any drop shifts every record index after
  // the first casualty. The witness turns that shift into an answerable
  // question instead of a reason to disown the grid.
  let organizedRange: OrganizedRangeSet | undefined;
  if (frame) {
    const remapped =
      frame.linkage.kind !== 'exact' ||
      clean.excludedCount === 0 ||
      !clean.witness ||
      clean.witness.sourceCount !== count
        ? null
        : remapPcdFrame(frame, clean.witness);
    const usable =
      frame.linkage.kind !== 'exact' || clean.excludedCount === 0
        ? frame
        : (remapped ?? {
            ...frame,
            cellToRecord: new Int32Array(frame.cellToRecord.length).fill(NO_RECORD),
            linkage: {
              kind: 'unavailable',
              reason: 'source-record-identity-unavailable',
            } as const,
          });
    organizedRange = {
      kind: 'organized-range',
      frames: [usable],
      organization: 'organized-grid',
    };
  }

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    classification: clean.attributes.classification,
    normals: clean.attributes.normals,
    organizedRange,
    origin: clean.origin,
    sourceFormat: 'pcd',
    name,
    decodedPointCount: count,
    metadata: withLoadWarning(metadata, clean.warning),
  });
}

/** Space, tab, LF, VT, FF, CR — the whitespace an ASCII PCD row separates on. */
function isPcdSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

/**
 * Count non-blank rows in an ASCII PCD body. Only used when the header's POINTS
 * is missing or zero — the scanner needs a size to preallocate, and counting
 * newlines is far cheaper than materialising every line as a string.
 */
function countPcdRows(body: string): number {
  let rows = 0;
  let inRow = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 10 || c === 13) {
      if (inRow) rows++;
      inRow = false;
    } else if (!isPcdSpace(c)) {
      inRow = true;
    }
  }
  return inRow ? rows + 1 : rows;
}
