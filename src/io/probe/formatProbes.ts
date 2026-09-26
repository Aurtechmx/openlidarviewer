/**
 * formatProbes.ts
 *
 * The scored probe registry behind "open any point cloud". Every known format
 * has a probe that looks at a window of the file's first bytes (plus the
 * extension) and reports an interpretation LEVEL with its evidence:
 *
 *   VERIFIED        known format: its signature is present and the header
 *                   fields the window holds are in range.
 *   COMPATIBLE      known format family: the signature is present but the
 *                   header could not be fully validated (a truncated head, a
 *                   field out of range). The decoder has the final word.
 *   PROBABLE        known format by structure, not by signature (numeric point
 *                   rows, vertex lines, a JSON asset block), or by an
 *                   extension the content does not contradict.
 *   RECOVERED       an inferred raw layout meeting pre-registered criteria.
 *                   Reserved; phase A never produces it.
 *   PREVIEW_ONLY    geometry drawable, semantics and units unknown. Reserved;
 *                   phase A never produces it.
 *   OPAQUE          data is present but nothing decodes it: the failure report.
 *   NOT_POINT_CLOUD a recognised signature of something else (an image, an
 *                   archive, a document).
 *
 * Each result also carries an internal 0 to 100 confidence used only to rank
 * results of the same level. It is not calibrated and is never shown to users.
 *
 * The extension is weak evidence. It still breaks ties the way `sniffFormat`
 * always did, so every file sniffFormat recognises keeps its format (the
 * fixture regression test runs both), but it never overrides contradicting
 * content: a non point cloud signature, or binary bytes under a text-only
 * format's extension.
 *
 * Pure: no DOM, no File, no worker. Lazily loaded only when sniffFormat gives
 * up, so none of this is in the entry bundle.
 */
import type { SourceFormat } from '../sniffFormat';

/** Interpretation levels, strongest first. */
export type InterpretationLevel =
  | 'VERIFIED'
  | 'COMPATIBLE'
  | 'PROBABLE'
  | 'RECOVERED'
  | 'PREVIEW_ONLY'
  | 'OPAQUE'
  | 'NOT_POINT_CLOUD';

/** Levels at which a decoder is chosen and the file is opened. */
export const OPENING_LEVELS: ReadonlySet<InterpretationLevel> = new Set(['VERIFIED', 'COMPATIBLE', 'PROBABLE']);

const LEVEL_RANK: Record<InterpretationLevel, number> = {
  VERIFIED: 6,
  COMPATIBLE: 5,
  PROBABLE: 4,
  RECOVERED: 3,
  PREVIEW_ONLY: 2,
  OPAQUE: 1,
  NOT_POINT_CLOUD: 0,
};

/** Compare two levels: positive when `a` is stronger. */
export function compareLevels(a: InterpretationLevel, b: InterpretationLevel): number {
  return LEVEL_RANK[a] - LEVEL_RANK[b];
}

/**
 * A level strong enough to stop widening the sample: a signature settles the
 * format (or settles that it is not a point cloud). Structure-only matches keep
 * widening, since a wider window can only confirm or break them.
 */
export function isDecisive(level: InterpretationLevel): boolean {
  return level === 'VERIFIED' || level === 'COMPATIBLE' || level === 'NOT_POINT_CLOUD';
}

/** One probe's finding. */
export interface ProbeResult {
  /** The decoder this result would open the file with. */
  readonly decoderId: SourceFormat;
  readonly level: InterpretationLevel;
  /** Internal ranking weight, 0 to 100. Never shown to users. */
  readonly confidence: number;
  readonly evidence: string[];
  /** Bytes the probe needs to reach a firmer level, when the window was short. */
  readonly requiredBytes?: number;
}

/** What a probe sees: the sampled bytes, whether they are the whole file, the extension. */
export interface ProbeInput {
  readonly bytes: Uint8Array;
  /** True when `bytes` holds the entire file (no truncation at the window edge). */
  readonly complete: boolean;
  /** Lowercased extension without the dot, or ''. */
  readonly ext: string;
}

/** A signature check: absent, present with a validated header, or present only. */
type Signature = { validated: boolean; evidence: string; requiredBytes?: number } | null;

interface Probe {
  readonly decoderId: SourceFormat;
  /** Extensions that name this format (the legacy extension fallback). */
  readonly exts: readonly string[];
  /** True for formats that are plain text: binary content contradicts them. */
  readonly textOnly?: boolean;
  readonly signature?: (inp: ProbeInput) => Signature;
  /** Content structure check. Returns evidence when the content fits. */
  readonly structure?: (inp: ProbeInput) => string | null;
}

/** Lowercased extension (no dot) of a file name, or ''. */
export function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function ascii(bytes: Uint8Array, count: number): string {
  const n = Math.min(count, bytes.length);
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Offset of the LAS point-data-record-format byte; its 0x80 bit flags LAZ. */
const LAS_POINT_FORMAT_OFFSET = 104;
/** The smallest LAS public header (version 1.0 to 1.2). */
const LAS_MIN_HEADER = 227;

/** LASF signature: compressed or not (null when absent). Matches sniffFormat exactly. */
function lasCompressed(inp: ProbeInput): boolean | null {
  if (!ascii(inp.bytes, 4).startsWith('LASF')) return null;
  if (inp.bytes.length > LAS_POINT_FORMAT_OFFSET) {
    return (inp.bytes[LAS_POINT_FORMAT_OFFSET] & 0x80) !== 0;
  }
  return inp.ext === 'laz';
}

function lasSignature(inp: ProbeInput, compressed: boolean): Signature {
  if (lasCompressed(inp) !== compressed) return null;
  const b = inp.bytes;
  const what = compressed ? 'LASF signature, compressed point records' : 'LASF signature, uncompressed point records';
  if (b.length < LAS_MIN_HEADER) return { validated: false, evidence: `${what}; header truncated`, requiredBytes: 375 };
  const major = b[24];
  const minor = b[25];
  const headerSize = u16(b, 94);
  const pointOffset = u32(b, 96);
  const pdrf = b[LAS_POINT_FORMAT_OFFSET] & 0x3f;
  const ok = major === 1 && minor <= 4 && headerSize >= LAS_MIN_HEADER && pointOffset >= headerSize && pdrf <= 10;
  return ok
    ? { validated: true, evidence: `${what}; version 1.${minor} header in range` }
    : { validated: false, evidence: `${what}; header fields out of range` };
}

function isPcdHeader(inp: ProbeInput): boolean {
  const head = ascii(inp.bytes, 256);
  return /(^|\n)VERSION[ \t]/.test(head) && /(^|\n)FIELDS[ \t]/.test(head);
}

// ── Text structure helpers ──────────────────────────────────────────────────

/** Text probes read at most this much of the window (400 lines fit easily). */
const TEXT_SCAN_BYTES = 256 * 1024;

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** The complete lines of a text window (the last, possibly cut, line dropped). */
function textLines(inp: ProbeInput, maxLines = 400): string[] {
  const cut = Math.min(inp.bytes.length, TEXT_SCAN_BYTES);
  const text = new TextDecoder('latin1').decode(inp.bytes.subarray(0, cut));
  const lines = text.split(/\r?\n/);
  if ((!inp.complete || cut < inp.bytes.length) && lines.length > 1) lines.pop();
  return lines.slice(0, maxLines);
}

function numericCols(line: string): number {
  const parts = line.trim().split(/[\s,;]+/);
  if (parts.length === 0 || parts[0] === '') return 0;
  for (const p of parts) if (!NUM.test(p)) return 0;
  return parts.length;
}

const MIN_ROWS = 3;

/** Rows of 3+ numeric columns with one stable column count, after optional headers. */
function numericTable(lines: string[], skipHead: number): { rows: number; cols: number } | null {
  let cols = 0;
  let rows = 0;
  let nonNumeric = 0;
  for (let i = skipHead; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    const n = numericCols(line);
    if (n === 0) {
      // Header lines are allowed before the first row, not between rows.
      if (rows > 0) return null;
      if (++nonNumeric > 5) return null;
      continue;
    }
    if (n < 3) return null;
    if (cols === 0) cols = n;
    else if (n !== cols) return null;
    rows++;
  }
  return rows >= MIN_ROWS ? { rows, cols } : null;
}

// ── Non point cloud signatures ──────────────────────────────────────────────

/** A recognised signature that is not a point cloud format. */
export interface ForeignSignature {
  readonly name: string;
  readonly kind: 'image' | 'archive' | 'compressed' | 'document' | 'executable' | 'database' | 'capture';
}

const FOREIGN: ReadonlyArray<{ bytes: number[]; at?: number; sig: ForeignSignature }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], sig: { name: 'PNG image', kind: 'image' } },
  { bytes: [0xff, 0xd8, 0xff], sig: { name: 'JPEG image', kind: 'image' } },
  { bytes: [0x47, 0x49, 0x46, 0x38], sig: { name: 'GIF image', kind: 'image' } },
  { bytes: [0x49, 0x49, 0x2a, 0x00], sig: { name: 'TIFF image', kind: 'image' } },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], sig: { name: 'TIFF image', kind: 'image' } },
  { bytes: [0x57, 0x45, 0x42, 0x50], at: 8, sig: { name: 'WebP image', kind: 'image' } },
  { bytes: [0x25, 0x50, 0x44, 0x46], sig: { name: 'PDF document', kind: 'document' } },
  { bytes: [0x50, 0x4b, 0x03, 0x04], sig: { name: 'ZIP archive', kind: 'archive' } },
  { bytes: [0x50, 0x4b, 0x05, 0x06], sig: { name: 'ZIP archive', kind: 'archive' } },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], sig: { name: '7z archive', kind: 'archive' } },
  { bytes: [0x52, 0x61, 0x72, 0x21], sig: { name: 'compressed archive', kind: 'archive' } },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], at: 257, sig: { name: 'TAR archive', kind: 'archive' } },
  { bytes: [0x1f, 0x8b], sig: { name: 'gzip compressed data', kind: 'compressed' } },
  { bytes: [0x42, 0x5a, 0x68], sig: { name: 'bzip2 compressed data', kind: 'compressed' } },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], sig: { name: 'xz compressed data', kind: 'compressed' } },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], sig: { name: 'zstd compressed data', kind: 'compressed' } },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], sig: { name: 'ELF executable', kind: 'executable' } },
  { bytes: [0x4d, 0x5a], sig: { name: 'executable program', kind: 'executable' } },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], sig: { name: 'SQLite database', kind: 'database' } },
  { bytes: [0x89, 0x48, 0x44, 0x46], sig: { name: 'HDF5 container', kind: 'database' } },
  { bytes: [0xd4, 0xc3, 0xb2, 0xa1], sig: { name: 'packet capture (PCAP)', kind: 'capture' } },
  { bytes: [0xa1, 0xb2, 0xc3, 0xd4], sig: { name: 'packet capture (PCAP)', kind: 'capture' } },
  { bytes: [0x4d, 0x3c, 0xb2, 0xa1], sig: { name: 'packet capture (PCAP)', kind: 'capture' } },
  { bytes: [0xa1, 0xb2, 0x3c, 0x4d], sig: { name: 'packet capture (PCAP)', kind: 'capture' } },
  { bytes: [0x0a, 0x0d, 0x0d, 0x0a], sig: { name: 'packet capture (PCAPNG)', kind: 'capture' } },
];

/** The first non point cloud signature at the head of `bytes`, if any. */
export function foreignSignature(bytes: Uint8Array): ForeignSignature | null {
  outer: for (const f of FOREIGN) {
    const at = f.at ?? 0;
    if (bytes.length < at + f.bytes.length) continue;
    for (let i = 0; i < f.bytes.length; i++) if (bytes[at + i] !== f.bytes[i]) continue outer;
    return f.sig;
  }
  return null;
}

/** Signature kinds that prove the file is not a point cloud this viewer could read. */
export function provesNotPointCloud(sig: ForeignSignature | null): boolean {
  return sig !== null && sig.kind !== 'capture';
}

// ── The registry ────────────────────────────────────────────────────────────

const sig = (ok: boolean, evidence: string, validated = true): Signature => (ok ? { validated, evidence } : null);

/**
 * Registry order is the legacy `sniffFormat` order: signatures are tried in
 * this order, and the extension fallback walks the same list. Do not reorder
 * without re-running the fixture regression test.
 */
const PROBES: readonly Probe[] = [
  {
    decoderId: 'e57',
    exts: ['e57'],
    signature: (i) => {
      if (!ascii(i.bytes, 8).startsWith('ASTM-E57')) return null;
      if (i.bytes.length < 48) return { validated: false, evidence: 'ASTM-E57 signature; header truncated', requiredBytes: 48 };
      return sig(true, 'ASTM-E57 signature; version 1 header', u32(i.bytes, 8) === 1 && u32(i.bytes, 40) > 0)
        ?? { validated: false, evidence: 'ASTM-E57 signature; header fields out of range' };
    },
  },
  {
    decoderId: 'ply',
    exts: ['ply'],
    signature: (i) => {
      if (ascii(i.bytes, 3) !== 'ply') return null;
      const head = ascii(i.bytes, 4096);
      const ok = /^ply\r?\n/.test(head) && /\nformat (ascii|binary_little_endian|binary_big_endian) /.test(head) && /\nend_header\r?\n/.test(head);
      return { validated: ok, evidence: ok ? "'ply' signature; format line and end_header" : "'ply' signature; header not complete in the window" };
    },
  },
  { decoderId: 'las', exts: ['las'], signature: (i) => lasSignature(i, false) },
  { decoderId: 'laz', exts: ['laz'], signature: (i) => lasSignature(i, true) },
  {
    decoderId: 'glb',
    exts: ['glb'],
    signature: (i) => {
      if (ascii(i.bytes, 4) !== 'glTF') return null;
      const ok = i.bytes.length >= 12 && u32(i.bytes, 4) === 2 && u32(i.bytes, 8) >= 12;
      return { validated: ok, evidence: ok ? 'binary glTF signature; version 2 header' : 'binary glTF signature; header not validated' };
    },
  },
  {
    decoderId: 'pnts',
    exts: ['pnts'],
    signature: (i) => {
      if (ascii(i.bytes, 4) !== 'pnts') return null;
      const ok = i.bytes.length >= 28 && u32(i.bytes, 4) === 1 && u32(i.bytes, 8) >= 28;
      return { validated: ok, evidence: ok ? '3D Tiles pnts signature; version 1 header' : '3D Tiles pnts signature; header not validated' };
    },
  },
  {
    decoderId: 'pcd',
    exts: ['pcd'],
    signature: (i) => {
      if (!isPcdHeader(i)) return null;
      const ok = /(^|\n)DATA[ \t]+(ascii|binary|binary_compressed)\b/.test(ascii(i.bytes, 4096));
      return { validated: ok, evidence: ok ? 'PCD VERSION, FIELDS and DATA header lines' : 'PCD VERSION and FIELDS header lines' };
    },
  },
  {
    decoderId: 'ptx',
    exts: ['ptx'],
    textOnly: true,
    structure: (i) => {
      const l = textLines(i, 12).map((s) => s.trim());
      if (l.length < 10) return null;
      const ok =
        numericCols(l[0]) === 1 && numericCols(l[1]) === 1 &&
        [2, 3, 4, 5].every((k) => numericCols(l[k]) === 3) &&
        [6, 7, 8, 9].every((k) => numericCols(l[k]) === 4);
      return ok ? 'grid size, scanner pose and transform header' : null;
    },
  },
  {
    decoderId: 'pts',
    exts: ['pts'],
    textOnly: true,
    structure: (i) => {
      const l = textLines(i).filter((s) => s.trim() !== '');
      if (l.length < 2 || !/^\d+$/.test(l[0].trim())) return null;
      return numericTable(l, 1) ? 'point count line followed by numeric point rows' : null;
    },
  },
  {
    decoderId: 'obj',
    exts: ['obj'],
    textOnly: true,
    structure: (i) => {
      let v = 0;
      for (const line of textLines(i)) {
        const t = line.trim();
        if (t === '' || t[0] === '#') continue;
        if (/^v\s/.test(t)) {
          if (numericCols(t.slice(2)) < 3) return null;
          v++;
        } else if (!/^(vn|vt|vp|f|l|p|o|g|s|usemtl|mtllib)\b/.test(t)) return null;
      }
      return v >= MIN_ROWS ? 'vertex lines with three coordinates' : null;
    },
  },
  {
    decoderId: 'gltf',
    exts: ['gltf'],
    textOnly: true,
    structure: (i) => {
      const t = ascii(i.bytes, 4096).trimStart();
      return t.startsWith('{') && /"asset"\s*:/.test(t) ? 'JSON document with a glTF asset block' : null;
    },
  },
  {
    decoderId: 'xyz',
    exts: ['xyz', 'csv', 'asc', 'txt'],
    textOnly: true,
    structure: (i) => {
      const t = numericTable(textLines(i), 0);
      return t ? `text rows of ${t.cols} numeric columns` : null;
    },
  },
];

/** Internal ranking weights. Not calibrated; never shown. */
const CONFIDENCE = { validated: 95, signature: 75, structure: 55, extensionAgrees: 10, extensionOnly: 20 } as const;

/** Run every probe over a window. Results are in registry order, one per decoder. */
export function runProbes(inp: ProbeInput): ProbeResult[] {
  const text = looksLikeText(inp.bytes);
  return PROBES.map((p): ProbeResult => {
    const evidence: string[] = [];
    let level: InterpretationLevel = 'OPAQUE';
    let confidence = 0;
    let requiredBytes: number | undefined;
    const s = p.signature?.(inp);
    if (s) {
      level = s.validated ? 'VERIFIED' : 'COMPATIBLE';
      confidence = s.validated ? CONFIDENCE.validated : CONFIDENCE.signature;
      evidence.push(s.evidence);
      requiredBytes = s.requiredBytes;
    } else if (p.structure && text) {
      const f = p.structure(inp);
      if (f) {
        level = 'PROBABLE';
        confidence = CONFIDENCE.structure;
        evidence.push(f);
      }
    }
    if (p.exts.includes(inp.ext)) {
      const contradicted = p.textOnly === true && !text && inp.bytes.length > 0;
      evidence.push(contradicted ? `extension .${inp.ext}, contradicted by binary content` : `extension .${inp.ext}`);
      if (!contradicted) {
        if (level === 'OPAQUE') {
          level = 'PROBABLE';
          confidence = CONFIDENCE.extensionOnly;
        } else {
          confidence = Math.min(100, confidence + CONFIDENCE.extensionAgrees);
        }
      }
    }
    return requiredBytes === undefined
      ? { decoderId: p.decoderId, level, confidence, evidence }
      : { decoderId: p.decoderId, level, confidence, evidence, requiredBytes };
  });
}

/** The decision over one window. */
export interface ProbeDecision {
  /** The decoder to open with, or null when nothing opens the file. */
  readonly decoderId: SourceFormat | null;
  readonly level: InterpretationLevel;
  /** Every probe that found anything, strongest first. */
  readonly candidates: ProbeResult[];
  readonly foreign: ForeignSignature | null;
}

/**
 * Decide the decoder for one window.
 *
 * 1. A point cloud signature wins, first in registry order (sniffFormat step 1).
 * 2. A recognised non point cloud signature settles NOT_POINT_CLOUD; no
 *    extension overrides it.
 * 3. A known extension the content does not contradict comes next
 *    (sniffFormat step 2).
 * 4. Otherwise the strongest structure match opens the file.
 * 5. Otherwise the file is OPAQUE.
 */
export function chooseFormat(inp: ProbeInput): ProbeDecision {
  const results = runProbes(inp);
  const candidates = results
    .filter((r) => r.level !== 'OPAQUE')
    .sort((a, b) => compareLevels(b.level, a.level) || b.confidence - a.confidence);
  const foreign = foreignSignature(inp.bytes);
  const signed = results.find((r) => r.level === 'VERIFIED' || r.level === 'COMPATIBLE');
  if (signed) return { decoderId: signed.decoderId, level: signed.level, candidates, foreign };
  if (provesNotPointCloud(foreign)) return { decoderId: null, level: 'NOT_POINT_CLOUD', candidates: [], foreign };
  const probe = PROBES.find((p) => p.exts.includes(inp.ext));
  const byExt = probe && results.find((r) => r.decoderId === probe.decoderId && r.level === 'PROBABLE');
  if (byExt) return { decoderId: byExt.decoderId, level: 'PROBABLE', candidates, foreign };
  const best = candidates.find((r) => r.level === 'PROBABLE');
  if (best) return { decoderId: best.decoderId, level: 'PROBABLE', candidates, foreign };
  return { decoderId: null, level: 'OPAQUE', candidates, foreign };
}

// ── Byte statistics ─────────────────────────────────────────────────────────

/** Shannon entropy of the bytes, in bits per byte (0 to 8). */
export function byteEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let h = 0;
  for (let k = 0; k < 256; k++) {
    if (counts[k] === 0) continue;
    const p = counts[k] / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when the bytes read as text: no NUL, and nearly all printable or UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) bad++;
  }
  return bad / bytes.length < 0.01;
}

/** Bounds of the stride search. */
const STRIDE_MIN = 4;
const STRIDE_MAX = 512;
const STRIDE_SAMPLE = 64 * 1024;

/**
 * A candidate fixed record size: the smallest lag at which the bytes repeat
 * well above chance (autocorrelation by byte equality). Null for text, for
 * windows too short to hold a few records, and for data with no stable stride.
 */
export function detectStride(bytes: Uint8Array): number | null {
  const n = Math.min(bytes.length, STRIDE_SAMPLE);
  if (n < STRIDE_MIN * 8) return null;
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i++) counts[bytes[i]]++;
  let chance = 0;
  for (let k = 0; k < 256; k++) chance += (counts[k] / n) ** 2;
  const maxLag = Math.min(STRIDE_MAX, Math.floor(n / 8));
  const scores = new Float64Array(maxLag + 1);
  let best = 0;
  for (let lag = STRIDE_MIN; lag <= maxLag; lag++) {
    let same = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) if (bytes[i] === bytes[i + lag]) same++;
    scores[lag] = same / m;
    if (scores[lag] > best) best = scores[lag];
  }
  // A real stride repeats clearly more often than byte frequencies explain,
  // and clearly more often than a typical lag does.
  const sorted = Array.from(scores.subarray(STRIDE_MIN)).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  if (best - chance < 0.02 || best < 2 * median) return null;
  for (let lag = STRIDE_MIN; lag <= maxLag; lag++) {
    // The smallest lag near the peak: multiples of the record size score as
    // high as the record size itself, and the record size is the answer.
    if (scores[lag] >= best * 0.9) return lag;
  }
  return null;
}
