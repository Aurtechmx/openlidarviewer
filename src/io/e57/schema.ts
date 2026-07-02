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

/**
 * One metadata field exactly as the file declared it. `value` is verbatim
 * (numbers re-printed from the parsed value, strings untouched); nothing here
 * is inferred or verified by the viewer.
 */
export interface E57DeclaredField {
  /** Local element name as declared, e.g. "sensorModel" or "datasetType". */
  name: string;
  /** The declared value, verbatim. */
  value: string;
  /** Namespace URI for extension-namespace fields (absent for standard E57 fields). */
  namespaceUri?: string;
}

/**
 * Declared-only source metadata read from the E57 XML section — the standard
 * root/scan provenance fields plus any extension-namespace (e.g. `olv:`)
 * String/Integer/Float leaf elements at root or scan level, in document order.
 *
 * E57 quirk honoured here: an EMPTY element with a type attribute means the
 * type's default value (Integer/Float 0, String ""). A zero dateTimeValue and
 * empty strings are treated as NOT DECLARED and omitted — the viewer never
 * displays a fabricated zero timestamp or blank field.
 */
export interface E57SourceMetadata {
  /** Standard E57-schema fields that were actually declared, in order. */
  standard: E57DeclaredField[];
  /** Extension-namespace leaf fields (any prefix), in document order. */
  extensions: E57DeclaredField[];
}

/** The interpreted E57 document. */
export interface E57DocumentSchema {
  scans: E57Scan[];
  metadata: E57Metadata;
  /**
   * Declared-only source metadata (standard + extension-namespace fields), or
   * null when the file declares nothing beyond geometry. Built defensively:
   * malformed metadata degrades to omission (with a warning), never a throw.
   */
  sourceMetadata: E57SourceMetadata | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Declared source metadata
//
// Everything below reads what the file DECLARES — nothing is inferred, and a
// value the writer left at its empty-element default (Integer/Float 0,
// String "") is treated as not declared rather than displayed as a
// fabricated zero / blank. Malformed metadata degrades to omission.
// ─────────────────────────────────────────────────────────────────────────────

/** The ASTM E57 core namespace marker — elements in it are "standard". */
const E57_CORE_NS = /astm\.org\/.*E57/i;

/** Trimmed element text, or undefined when the element is missing / empty. */
function declaredText(node: XmlNode | undefined): string | undefined {
  const t = node?.text.trim();
  return t ? t : undefined;
}

/** Element text as a re-printed number, or undefined when missing / empty / NaN. */
function declaredNumText(node: XmlNode | undefined): string | undefined {
  const t = declaredText(node);
  if (t === undefined) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? String(v) : undefined;
}

/**
 * Format a declared E57 dateTime structure. The spec stores seconds since the
 * GPS epoch (1980-01-06T00:00Z); a ZERO / empty dateTimeValue is the
 * empty-element default and therefore NOT a declaration — omitted, never
 * shown as a fabricated 1980 timestamp. Leap seconds are not applied (the
 * value is labelled as GPS time so the ~18 s offset stays visible as such).
 */
function declaredDateTime(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const t = declaredText(child(node, 'dateTimeValue'));
  if (t === undefined) return undefined;
  const seconds = Number(t);
  if (!Number.isFinite(seconds) || seconds === 0) return undefined;
  const ms = Date.UTC(1980, 0, 6) + seconds * 1000;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.toISOString().replace(/\.\d{3}Z$/, 'Z')} (GPS time ${t})`;
}

/** Push `{name, value}` when the value is actually declared. */
function pushDeclared(
  out: E57DeclaredField[],
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) out.push({ name, value });
}

/**
 * A min–max limits structure ("intensityLimits") as a single declared value,
 * or undefined when no child carries an explicit value. An empty minimum next
 * to a declared maximum renders as its spec default (0) — that pairing is a
 * real declaration, unlike a wholly-empty structure.
 */
function declaredRange(
  node: XmlNode | undefined,
  minName: string,
  maxName: string,
): string | undefined {
  if (!node) return undefined;
  const minNode = child(node, minName);
  const maxNode = child(node, maxName);
  if (declaredText(minNode) === undefined && declaredText(maxNode) === undefined) {
    return undefined;
  }
  const lo = declaredNumText(minNode) ?? '0';
  const hi = declaredNumText(maxNode) ?? '0';
  return `${lo} to ${hi}`;
}

/** The colorLimits structure as one compact declared row, or undefined. */
function declaredColorLimits(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const parts: string[] = [];
  for (const [label, minN, maxN] of [
    ['R', 'colorRedMinimum', 'colorRedMaximum'],
    ['G', 'colorGreenMinimum', 'colorGreenMaximum'],
    ['B', 'colorBlueMinimum', 'colorBlueMaximum'],
  ] as const) {
    const range = declaredRange(node, minN, maxN);
    if (range !== undefined) parts.push(`${label} ${range}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Collect extension-namespace String/Integer/Float LEAF elements among the
 * direct children of `node`, in document order. An element counts when its
 * name carries a prefix that does not resolve to the E57 core namespace.
 * Empty text is the type's default value — treated as not declared (omitted).
 */
function extensionLeaves(
  node: XmlNode,
  nsUris: Record<string, string>,
  prefixNames: (name: string) => string,
): E57DeclaredField[] {
  const out: E57DeclaredField[] = [];
  for (const c of node.children) {
    const colon = c.name.indexOf(':');
    if (colon <= 0 || c.children.length > 0) continue;
    const prefix = c.name.slice(0, colon);
    const uri = nsUris[prefix];
    if (uri !== undefined && E57_CORE_NS.test(uri)) continue;
    const type = c.attrs.type;
    if (type !== 'String' && type !== 'Integer' && type !== 'Float') continue;
    const value = c.text.trim();
    if (!value) continue; // empty-element default — not a declaration.
    const field: E57DeclaredField = { name: prefixNames(c.name.slice(colon + 1)), value };
    if (uri !== undefined) field.namespaceUri = uri;
    out.push(field);
  }
  return out;
}

/** The `xmlns:prefix` declarations on the root element. */
function namespaceDeclarations(root: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.attrs)) {
    if (k.startsWith('xmlns:')) out[k.slice(6)] = v;
  }
  return out;
}

/**
 * Read the declared-only source metadata: standard root/scan provenance
 * fields plus extension-namespace leaves. Returns null when nothing beyond
 * geometry is declared. Never throws — the caller wraps it so malformed
 * metadata degrades to omission with a warning.
 */
function readSourceMetadata(root: XmlNode): E57SourceMetadata | null {
  const nsUris = namespaceDeclarations(root);
  const standard: E57DeclaredField[] = [];
  const extensions: E57DeclaredField[] = [];

  // Root-level standard fields, in a stable reading order.
  pushDeclared(standard, 'guid', declaredText(child(root, 'guid')));
  pushDeclared(standard, 'e57LibraryVersion', declaredText(child(root, 'e57LibraryVersion')));
  pushDeclared(standard, 'creationDateTime', declaredDateTime(child(root, 'creationDateTime')));
  pushDeclared(standard, 'coordinateMetadata', declaredText(child(root, 'coordinateMetadata')));

  // Per-scan standard fields. A single-scan file uses the plain field names;
  // multi-scan files prefix each with its scan index so nothing collides.
  const data3D = child(root, 'data3D');
  const scanNodes = data3D ? childrenNamed(data3D, 'vectorChild') : [];
  scanNodes.forEach((scan, i) => {
    const p = (name: string): string =>
      scanNodes.length > 1 ? `scan ${i + 1} ${name}` : name;
    pushDeclared(standard, p('name'), declaredText(child(scan, 'name')));
    // The scan-level guid keeps a "scan" prefix even in single-scan files —
    // the root declares its own `guid`, and two identically-named rows with
    // different values would read as a contradiction rather than two fields.
    pushDeclared(
      standard,
      scanNodes.length > 1 ? `scan ${i + 1} guid` : 'scan guid',
      declaredText(child(scan, 'guid')),
    );
    pushDeclared(standard, p('description'), declaredText(child(scan, 'description')));
    pushDeclared(standard, p('sensorVendor'), declaredText(child(scan, 'sensorVendor')));
    pushDeclared(standard, p('sensorModel'), declaredText(child(scan, 'sensorModel')));
    pushDeclared(standard, p('sensorSerialNumber'), declaredText(child(scan, 'sensorSerialNumber')));
    pushDeclared(standard, p('acquisitionStart'), declaredDateTime(child(scan, 'acquisitionStart')));
    pushDeclared(standard, p('acquisitionEnd'), declaredDateTime(child(scan, 'acquisitionEnd')));
    pushDeclared(standard, p('temperature'), declaredNumText(child(scan, 'temperature')));
    pushDeclared(standard, p('relativeHumidity'), declaredNumText(child(scan, 'relativeHumidity')));
    pushDeclared(standard, p('atmosphericPressure'), declaredNumText(child(scan, 'atmosphericPressure')));
    pushDeclared(
      standard,
      p('intensityLimits'),
      declaredRange(child(scan, 'intensityLimits'), 'intensityMinimum', 'intensityMaximum'),
    );
    pushDeclared(standard, p('colorLimits'), declaredColorLimits(child(scan, 'colorLimits')));
    extensions.push(...extensionLeaves(scan, nsUris, p));
  });

  // Root-level extension leaves, after the per-scan blocks (document order in
  // typical files, where the extension block trails the data3D vector).
  extensions.push(...extensionLeaves(root, nsUris, (n) => n));

  return standard.length > 0 || extensions.length > 0 ? { standard, extensions } : null;
}

/** Interpret a parsed E57 XML root into the scan list and metadata. */
export function readE57Document(root: XmlNode): E57DocumentSchema {
  const warnings: string[] = [];
  const data3D = child(root, 'data3D');
  const scans = data3D
    ? childrenNamed(data3D, 'vectorChild').map((s) => readScan(s, warnings))
    : [];
  const created = child(root, 'creationDateTime');
  // Declared metadata must never sink a load: malformed metadata degrades to
  // "omitted" (with a warning), and the geometry pipeline proceeds untouched.
  let sourceMetadata: E57SourceMetadata | null = null;
  try {
    sourceMetadata = readSourceMetadata(root);
  } catch {
    sourceMetadata = null;
    warnings.push(
      'The file\'s declared source metadata could not be interpreted — it is omitted.',
    );
  }
  return {
    scans,
    warnings,
    sourceMetadata,
    metadata: {
      formatName: child(root, 'formatName')?.text ?? '',
      guid: child(root, 'guid')?.text ?? '',
      library: child(root, 'e57LibraryVersion')?.text ?? '',
      creationDateTime: created ? numText(child(created, 'dateTimeValue')) : null,
    },
  };
}
