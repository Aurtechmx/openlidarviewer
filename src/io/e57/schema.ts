/**
 * schema.ts
 *
 * Interprets the parsed E57 XML tree into typed structures — the scan list,
 * each scan's point prototype, pose, and colour / intensity limits. Pure and
 * DOM-free.
 */

import type { XmlNode } from './xml';
import { child, childrenNamed } from './xml';

/** A prototype field's storage encoding. */
export type E57FieldType = 'float' | 'integer' | 'scaledInteger';

/** One field of a CompressedVector point record. */
export interface E57Field {
  name: string;
  type: E57FieldType;
  /** Float fields: bytes per value (4 = single, 8 = double). */
  floatBytes?: 4 | 8;
  /** Integer / scaledInteger fields: value added back to the packed integer. */
  minimum?: number;
  /** Integer / scaledInteger fields: bit width of the packed integer. */
  bitWidth?: number;
  /** scaledInteger fields only. */
  scale?: number;
  offset?: number;
}

/** A scan's rigid-body placement in the file's global coordinate frame. */
export interface E57Pose {
  /** Rotation quaternion, `[w, x, y, z]`. */
  rotation: [number, number, number, number];
  translation: [number, number, number];
}

/** One scan (a `data3D` child). */
export interface E57Scan {
  name: string;
  guid: string;
  recordCount: number;
  /** Physical offset of this scan's CompressedVector binary section. */
  fileOffset: number;
  prototype: E57Field[];
  pose: E57Pose | null;
  /** Declared colour channel maximum, for 0–255 normalisation; null if absent. */
  colorMax: number | null;
  /** Declared intensity maximum; null if absent. */
  intensityMax: number | null;
}

/** File-level provenance metadata. */
export interface E57Metadata {
  formatName: string;
  guid: string;
  library: string;
  /** Acquisition time as a GPS-time float, or null when absent. */
  creationDateTime: number | null;
}

/** The interpreted E57 document. */
export interface E57DocumentSchema {
  scans: E57Scan[];
  metadata: E57Metadata;
  /**
   * Non-fatal anomalies found while interpreting the XML (e.g. a pose
   * quaternion that had to be normalised or replaced with the identity).
   * The loader carries these to the user as load warnings.
   */
  warnings: string[];
}

/** Number of bits needed to pack integers in the range `[0, max - min]`. */
function bitWidthFor(min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return 0;
  let bits = 0;
  while (2 ** bits <= range) bits++;
  return bits;
}

/** A node's text content as a number, or `fallback` when empty / invalid. */
function numText(node: XmlNode | undefined, fallback = 0): number {
  if (!node || node.text === '') return fallback;
  const v = Number(node.text);
  return Number.isFinite(v) ? v : fallback;
}

/** An attribute as a number, or `fallback` when absent / invalid. */
function attrNum(node: XmlNode, attr: string, fallback: number): number {
  const raw = node.attrs[attr];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Interpret one prototype field node. */
function readField(node: XmlNode): E57Field {
  const type = node.attrs.type;
  if (type === 'Float') {
    return {
      name: node.name,
      type: 'float',
      floatBytes: node.attrs.precision === 'single' ? 4 : 8,
    };
  }
  if (type === 'Integer') {
    const min = attrNum(node, 'minimum', 0);
    return {
      name: node.name,
      type: 'integer',
      minimum: min,
      bitWidth: bitWidthFor(min, attrNum(node, 'maximum', 0)),
    };
  }
  if (type === 'ScaledInteger') {
    const min = attrNum(node, 'minimum', 0);
    return {
      name: node.name,
      type: 'scaledInteger',
      minimum: min,
      bitWidth: bitWidthFor(min, attrNum(node, 'maximum', 0)),
      scale: attrNum(node, 'scale', 1),
      offset: attrNum(node, 'offset', 0),
    };
  }
  throw new Error(
    `E57: unsupported prototype field type "${type ?? '(none)'}" on "${node.name}".`,
  );
}

/**
 * Norm deviation from 1 beyond which a pose quaternion is normalised (with a
 * warning). Tighter than any plausible decimal-text roundoff, looser than
 * float noise — a norm off by more than this is a writer bug, not printing.
 */
const QUAT_NORM_TOLERANCE = 1e-6;

/** Norm below which a quaternion carries no usable direction at all. */
const QUAT_DEGENERATE_NORM = 1e-6;

/**
 * Read an optional pose (rotation quaternion + translation).
 *
 * Quaternion policy (documented so it can be argued with): the rotation
 * formula downstream assumes a UNIT quaternion — a non-unit one silently
 * SCALES the geometry, and a zero / non-finite one collapses it. So:
 *   - near-unit (within {@link QUAT_NORM_TOLERANCE}) → used as-is;
 *   - finite but non-unit → normalised, with a warning recording the norm;
 *   - degenerate (non-finite norm, or norm ≈ 0) → the identity rotation,
 *     with a warning — a possibly-misplaced but finite scan beats NaN
 *     geometry, and the warning keeps the substitution honest.
 */
function readPose(scan: XmlNode, scanName: string, warnings: string[]): E57Pose | null {
  const pose = child(scan, 'pose');
  if (!pose) return null;
  const rot = child(pose, 'rotation');
  const tr = child(pose, 'translation');
  let rotation: [number, number, number, number] = [
    rot ? numText(child(rot, 'w'), 1) : 1,
    rot ? numText(child(rot, 'x')) : 0,
    rot ? numText(child(rot, 'y')) : 0,
    rot ? numText(child(rot, 'z')) : 0,
  ];
  const norm = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!Number.isFinite(norm) || norm < QUAT_DEGENERATE_NORM) {
    warnings.push(
      `Scan "${scanName}": pose rotation quaternion is degenerate (zero or ` +
        `non-finite) — using the identity rotation; this scan's placement ` +
        `may be wrong.`,
    );
    rotation = [1, 0, 0, 0];
  } else if (Math.abs(norm - 1) > QUAT_NORM_TOLERANCE) {
    warnings.push(
      `Scan "${scanName}": pose rotation quaternion has norm ` +
        `${norm.toFixed(6)} (expected 1) — normalised before use.`,
    );
    rotation = [
      rotation[0] / norm,
      rotation[1] / norm,
      rotation[2] / norm,
      rotation[3] / norm,
    ];
  }
  return {
    rotation,
    translation: [
      tr ? numText(child(tr, 'x')) : 0,
      tr ? numText(child(tr, 'y')) : 0,
      tr ? numText(child(tr, 'z')) : 0,
    ],
  };
}

/**
 * Read + validate a scan's declared record count. The value comes from an
 * XML attribute in a possibly-remote file, and it later sizes one
 * Float64Array per prototype field — so a non-integer, negative, or
 * beyond-2^53 value must fail HERE, loudly, rather than poison the decoder's
 * allocation arithmetic. (The byte-level plausibility bound lives in
 * `compressedVector.ts`, next to the allocations it protects.)
 */
function readRecordCount(points: XmlNode): number {
  const count = attrNum(points, 'recordCount', 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`E57: invalid recordCount "${count}" — expected a non-negative integer.`);
  }
  return count;
}

/** Interpret one `data3D` scan structure. */
function readScan(scan: XmlNode, warnings: string[]): E57Scan {
  const points = child(scan, 'points');
  if (!points) throw new Error('E57: a scan has no point data.');
  const proto = child(points, 'prototype');
  if (!proto) throw new Error('E57: a scan has no point prototype.');
  // Resolved before the pose so pose warnings can name the scan.
  const name = child(scan, 'name')?.text ?? 'Scan';

  const colorLimits = child(scan, 'colorLimits');
  const colorMax = colorLimits
    ? Math.max(
        numText(child(colorLimits, 'colorRedMaximum')),
        numText(child(colorLimits, 'colorGreenMaximum')),
        numText(child(colorLimits, 'colorBlueMaximum')),
      )
    : null;
  const intensityLimits = child(scan, 'intensityLimits');

  return {
    name,
    guid: child(scan, 'guid')?.text ?? '',
    recordCount: readRecordCount(points),
    fileOffset: attrNum(points, 'fileOffset', 0),
    prototype: proto.children.map(readField),
    pose: readPose(scan, name, warnings),
    colorMax: colorMax && colorMax > 0 ? colorMax : null,
    intensityMax: intensityLimits
      ? numText(child(intensityLimits, 'intensityMaximum')) || null
      : null,
  };
}

/** Interpret a parsed E57 XML root into the scan list and metadata. */
export function readE57Document(root: XmlNode): E57DocumentSchema {
  const warnings: string[] = [];
  const data3D = child(root, 'data3D');
  const scans = data3D
    ? childrenNamed(data3D, 'vectorChild').map((s) => readScan(s, warnings))
    : [];
  const created = child(root, 'creationDateTime');
  return {
    scans,
    warnings,
    metadata: {
      formatName: child(root, 'formatName')?.text ?? '',
      guid: child(root, 'guid')?.text ?? '',
      library: child(root, 'e57LibraryVersion')?.text ?? '',
      creationDateTime: created ? numText(child(created, 'dateTimeValue')) : null,
    },
  };
}
