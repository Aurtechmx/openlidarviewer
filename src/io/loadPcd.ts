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
import { computeOrigin, recenter } from './coordinateBridge';

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
    const rows: number[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      const tok = line.split(/\s+/);
      rows.push(Number(tok[cx]), Number(tok[cy]), Number(tok[cz]));
    }
    return Float64Array.from(rows);
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
  try {
    points = new PCDLoader().parse(buffer);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    throw new Error(`This PCD file could not be read${detail}`);
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
  //    save, so PCDLoader's values are used as-is with the origin subtracted
  //    post-parse to keep the coordinate-bridge contract.
  // The row-count guard keeps the f64 re-read honest: if it ever disagrees
  // with what PCDLoader decoded, PCDLoader's rows win.
  const global = extractPcdPositionsF64(buffer);
  let origin: [number, number, number];
  let positions: Float32Array;
  if (global && global.length === count * 3) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    for (let i = 0; i < count; i++) {
      const x = global[i * 3];
      const y = global[i * 3 + 1];
      const z = global[i * 3 + 2];
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
    }
    origin = computeOrigin(min);
    positions = recenter(global, origin);
  } else {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    for (let i = 0; i < count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
    }
    origin = computeOrigin(min);
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = posAttr.getX(i) - origin[0];
      positions[i * 3 + 1] = posAttr.getY(i) - origin[1];
      positions[i * 3 + 2] = posAttr.getZ(i) - origin[2];
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

  return new PointCloud({
    positions,
    colors,
    intensity,
    classification,
    normals,
    origin,
    sourceFormat: 'pcd',
    name,
    decodedPointCount: count,
  });
}
