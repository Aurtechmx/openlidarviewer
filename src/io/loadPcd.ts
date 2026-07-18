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
import { sanitizeAndRecenter, withLoadWarning } from './sanitizeCloud';

/** Round and clamp a value into the 0–255 byte range. */
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Round and clamp a value into the 0–65535 Uint16 range. */
function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
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
  /** Offset of the first body byte (matches PCDLoader's `headerLen`). */
  bodyOffset: number;
}

/**
 * Parse the PCD text header. The header is ASCII by spec, so character
 * offsets into the decoded prefix equal byte offsets into the buffer.
 * Returns `null` when the header cannot be resolved — the caller falls back
 * to PCDLoader's positions.
 */
function parsePcdHeaderFacts(buffer: ArrayBuffer): PcdHeaderFacts | null {
  const probe = new TextDecoder().decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)),
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
    bodyOffset: m.index + m[0].length,
  };
  let width = 0;
  let height = 0;
  for (const raw of probe.slice(0, m.index).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line[0] === '#') continue;
    const tok = line.split(/\s+/);
    const key = tok[0].toUpperCase();
    if (key === 'FIELDS') facts.fields = tok.slice(1).map((f) => f.toLowerCase());
    else if (key === 'SIZE') facts.sizes = tok.slice(1).map(Number);
    else if (key === 'TYPE') facts.types = tok.slice(1).map((t) => t.toUpperCase());
    else if (key === 'COUNT') facts.counts = tok.slice(1).map(Number);
    else if (key === 'POINTS') facts.points = Number(tok[1]);
    else if (key === 'WIDTH') width = Number(tok[1]);
    else if (key === 'HEIGHT') height = Number(tok[1]);
  }
  // COUNT is optional and defaults to 1 per field; POINTS to WIDTH × HEIGHT.
  if (facts.counts.length === 0) facts.counts = facts.fields.map(() => 1);
  if (!(facts.points > 0)) facts.points = width * height;
  return facts;
}

/**
 * Re-read the x/y/z columns of a PCD body in double precision, for the
 * encodings that actually carry it: ascii text, and binary records whose
 * x/y/z are 8-byte floats. Returns interleaved global coordinates, or `null`
 * when the source is single-precision (nothing to save) or the header cannot
 * be resolved — the caller then uses PCDLoader's positions.
 */
function extractPcdPositionsF64(buffer: ArrayBuffer): Float64Array | null {
  const facts = parsePcdHeaderFacts(buffer);
  if (!facts) return null;
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
    const maxRows = facts.points > 0 ? facts.points : countPcdRows(body);
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
  const reread = extractPcdPositionsF64(buffer);
  let global: Float64Array;
  if (reread && reread.length === count * 3) {
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
  const clean = sanitizeAndRecenter(global, { colors, intensity, classification, normals });

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    classification: clean.attributes.classification,
    normals: clean.attributes.normals,
    origin: clean.origin,
    sourceFormat: 'pcd',
    name,
    decodedPointCount: count,
    metadata: withLoadWarning(undefined, clean.warning),
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
