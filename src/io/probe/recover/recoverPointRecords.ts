/**
 * recoverPointRecords.ts: phase C of the open-any-point-cloud intake.
 *
 * When no known format opens a file (phase A returns OPAQUE), this module tries
 * to recover Cartesian point records from the bytes already read: headerless
 * fixed-record binary streams (float32 / float64 / scaled int32 XYZ, either byte
 * order, a leading header, any stride that holds three coordinates) and
 * delimited text point lists.
 *
 * It never guesses when the evidence is thin. Candidate strides come from the
 * byte autocorrelation, not from a blind sweep; every layout hypothesis must
 * pass several independent plausibility signals; and when the two best
 * surviving hypotheses score within TIE_MARGIN of each other, or any bound
 * below is hit, the answer is to abstain.
 *
 * What it cannot know, it does not claim: a float32 or scaled-int stream that
 * was written relative to an origin carries no trace of that origin, and a
 * scaled int carries no trace of its scale. Recovered coordinates are the raw
 * stored values (int32 at scale 1), with units unknown and frame 'unknown'.
 *
 * Status: not reachable from the application. The pre-registered held-out
 * evaluation (validation/intake-corpus/criteria.json) decides whether it may
 * be shown to users; see validation/intake-corpus/results/.
 */

/** Most layout hypotheses scored for one file. More than this abstains. */
export const MAX_LAYOUT_HYPOTHESES = 512;
/** Wall-clock budget for one recovery attempt. */
export const RECOVERY_TIME_BUDGET_MS = 3000;
/** Largest working allocation one recovery attempt may make. */
export const RECOVERY_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Largest sample the recovery reads. */
export const RECOVERY_SAMPLE_BYTES = 1024 * 1024;
/** Points shown in a recovered preview; larger inputs are strided. */
export const RECOVERED_PREVIEW_POINT_CAP = 2_000_000;
/** Score gap under which the two best hypotheses count as a tie. */
export const TIE_MARGIN = 0.05;

const STRIDE_CANDIDATES = 6;
const STRIDE_LAG_MIN = 12;
const STRIDE_LAG_MAX = 64;
const MAX_COORD_OFFSET = 12;
const DIMENSION_MIN = 1.5;
const FIELD_MIXING_MAX = 6;
const OCCUPANCY_MIN = 0.5;
const DIMENSION_MAX = 2.5;
/** Rejections that describe the bytes as a whole, not one misreading of them. */
const STRUCTURAL = new Set(['points lie on a line', 'points lie in a plane', 'values form one smooth sequence']);
const MIN_RECORDS = 32;
const SCORE_RECORDS = 1024;
const NN_POINTS = 512;
const MAX_ABS_FLOAT = 1e9;
const MIN_ABS_NONZERO_FLOAT = 1e-20;
const MAX_ABS_INT = 1 << 28;

export type CoordType = 'f32' | 'f64' | 'i32';

export interface BinaryLayout {
  kind: 'binary';
  headerBytes: number;
  stride: number;
  endianness: 'little' | 'big';
  type: CoordType;
  /** Byte offsets of x, y, z inside a record. */
  offsets: [number, number, number];
  /** Always 1: a stored scale is not recoverable from the bytes. */
  scale: 1;
}

export interface TextLayout {
  kind: 'text';
  delimiter: string;
  headerLines: number;
  columnCount: number;
  /** Column indices of x, y, z. */
  coordinateColumns: [number, number, number];
}

export type RecoveredLayout = BinaryLayout | TextLayout;

export interface PlausibilitySignals {
  finiteRatio: number;
  duplicateRatio: number;
  /** Smallest over largest principal variance: 0 for a plane or a line. */
  flatness: number;
  /** Middle over largest principal variance: 0 for a line. */
  elongation: number;
  /** Median nearest-neighbour distance over the bounding-box diagonal. */
  nnRatio: number;
  /** Median step of the values read as one sequence (x0 y0 z0 x1 ...) over their spread. */
  sequenceSmoothness: number;
  /** Correlation dimension near the nearest-neighbour scale: about 2 for sampled surfaces, 3 for a filled volume, 1 for a curve. */
  dimension: number;
  /** Largest z-score between records grouped by index modulo 2..5 (per axis). */
  fieldMixing: number;
  /** Smallest fraction of an axis range not taken by large gaps. */
  occupancy: number;
}

export type RecoveryOutcome =
  | {
      status: 'offer';
      layout: RecoveredLayout;
      /** x,y,z per point as float64, raw stored values. */
      points: Float64Array;
      pointCount: number;
      /** Total records in the file (may exceed pointCount when the sample is a head). */
      recordCount: number;
      score: number;
      signals: PlausibilitySignals;
      hypothesesTried: number;
    }
  | { status: 'abstain'; reason: string; hypothesesTried: number };

export interface RecoveryOptions {
  /** Size of the whole file when `bytes` is only its head. */
  totalBytes?: number;
  signal?: AbortSignal;
  now?: () => number;
}

class BoundHit extends Error {}

// ------------------------------------------------------------------ signals

function plausibility(xyz: Float64Array, n: number): { ok: boolean; why?: string; score: number; signals: PlausibilitySignals } {
  const signals: PlausibilitySignals = { finiteRatio: 1, duplicateRatio: 0, flatness: 0, elongation: 0, nnRatio: 1, sequenceSmoothness: 1, dimension: 0, fieldMixing: 0, occupancy: 1 };
  const fail = (why: string) => ({ ok: false, why, score: 0, signals });
  if (n < MIN_RECORDS) return fail('too few records');
  // Axis spreads and principal variances.
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) mean[a] += xyz[3 * i + a];
  for (let a = 0; a < 3; a++) mean[a] /= n;
  const c = [0, 0, 0, 0, 0, 0]; // xx yy zz xy xz yz
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const dx = xyz[3 * i] - mean[0], dy = xyz[3 * i + 1] - mean[1], dz = xyz[3 * i + 2] - mean[2];
    c[0] += dx * dx; c[1] += dy * dy; c[2] += dz * dz; c[3] += dx * dy; c[4] += dx * dz; c[5] += dy * dz;
    for (let a = 0; a < 3; a++) { const v = xyz[3 * i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  }
  for (let a = 0; a < 3; a++) if (!(hi[a] > lo[a])) return fail('an axis is constant');
  const ev = symmetricEigenvalues3(c.map((v) => v / n));
  signals.flatness = ev[0] / ev[2];
  signals.elongation = ev[1] / ev[2];
  if (!(signals.elongation >= 1e-4)) return fail('points lie on a line');
  if (!(signals.flatness >= 1e-5)) return fail('points lie in a plane');
  // Duplicates.
  const seen = new Set<string>();
  let dup = 0;
  for (let i = 0; i < n; i++) {
    const k = `${xyz[3 * i]},${xyz[3 * i + 1]},${xyz[3 * i + 2]}`;
    if (seen.has(k)) dup++; else seen.add(k);
  }
  signals.duplicateRatio = dup / n;
  if (signals.duplicateRatio > 0.2) return fail('too many duplicate points');
  // The values read as one sequence: a one-dimensional signal cut into triples
  // steps smoothly across axis boundaries, a point cloud does not.
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < 3 * n; i++) { const v = xyz[i]; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  const steps = new Float64Array(3 * n - 1);
  for (let i = 0; i + 1 < 3 * n; i++) steps[i] = Math.abs(xyz[i + 1] - xyz[i]);
  signals.sequenceSmoothness = median(steps) / (vmax - vmin);
  if (!(signals.sequenceSmoothness >= 0.02)) return fail('values form one smooth sequence');
  // Field consistency: a wrong stride walks across fields, so what it calls
  // one axis is a rotation through several. Records grouped by index modulo
  // a small period then differ in mean far beyond sampling noise.
  signals.fieldMixing = fieldMixing(xyz, n);
  if (!(signals.fieldMixing <= FIELD_MIXING_MAX)) return fail('axes mix fields from different record positions');
  // Occupancy: an integer read across a field boundary puts one field's
  // bytes in the high digits, so its values bunch into far-apart clusters.
  signals.occupancy = Math.min(occupancy(xyz, n, 0), occupancy(xyz, n, 1), occupancy(xyz, n, 2));
  if (!(signals.occupancy >= OCCUPANCY_MIN)) return fail('values bunch into far-apart clusters');
  // Local spatial continuity.
  const m = Math.min(n, NN_POINTS);
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const nn = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let best = Infinity;
    for (let j = 0; j < m; j++) {
      if (i === j) continue;
      const d = Math.hypot(xyz[3 * i] - xyz[3 * j], xyz[3 * i + 1] - xyz[3 * j + 1], xyz[3 * i + 2] - xyz[3 * j + 2]);
      if (d < best) best = d;
    }
    nn[i] = best;
  }
  signals.nnRatio = median(nn) / diag;
  if (!(signals.nnRatio <= 0.15)) return fail('no local spatial continuity');
  // Correlation dimension from pair counts at two radii near the NN scale.
  const r1 = 2 * median(nn), r2 = 2 * r1;
  let c1 = 0, c2 = 0;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    const d = Math.hypot(xyz[3 * i] - xyz[3 * j], xyz[3 * i + 1] - xyz[3 * j + 1], xyz[3 * i + 2] - xyz[3 * j + 2]);
    if (d <= r2) { c2++; if (d <= r1) c1++; }
  }
  signals.dimension = c1 > 0 ? Math.log2(c2 / c1) : 0;
  if (!(signals.dimension >= DIMENSION_MIN && signals.dimension <= DIMENSION_MAX)) return fail('not a sampled surface');
  const score = 1 - Math.abs(signals.dimension - 2);
  return { ok: true, score, signals };
}

function fieldMixing(xyz: Float64Array, n: number): number {
  let worst = 0;
  for (let a = 0; a < 3; a++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += xyz[3 * i + a];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (xyz[3 * i + a] - mean) ** 2;
    const sd = Math.sqrt(v / n) || 1;
    for (let p = 2; p <= 5; p++) {
      for (let g = 0; g < p; g++) {
        let s = 0, c = 0;
        for (let i = g; i < n; i += p) { s += xyz[3 * i + a]; c++; }
        worst = Math.max(worst, Math.abs(s / c - mean) / (sd / Math.sqrt(c)));
      }
    }
  }
  return worst;
}

function occupancy(xyz: Float64Array, n: number, a: number): number {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = xyz[3 * i + a];
  v.sort();
  const range = v[n - 1] - v[0];
  const big = (50 * range) / n;
  let gaps = 0;
  for (let i = 1; i < n; i++) { const g = v[i] - v[i - 1]; if (g > big) gaps += g; }
  return 1 - gaps / range;
}

function median(a: Float64Array): number {
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

/** Eigenvalues of a symmetric 3x3 matrix [xx yy zz xy xz yz], ascending. */
function symmetricEigenvalues3([a, b, c, d, e, f]: number[]): [number, number, number] {
  const p1 = d * d + e * e + f * f;
  if (p1 === 0) return [a, b, c].sort((x, y) => x - y) as [number, number, number];
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [(a - q) / p, (b - q) / p, (c - q) / p, d / p, e / p, f / p];
  const detB = B[0] * (B[1] * B[2] - B[5] * B[5]) - B[3] * (B[3] * B[2] - B[5] * B[4]) + B[4] * (B[3] * B[5] - B[1] * B[4]);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e3, e2, e1].map((v) => Math.max(0, v)) as [number, number, number];
}

// ------------------------------------------------------------------ binary

const TYPE_SIZE: Record<CoordType, number> = { f32: 4, f64: 8, i32: 4 };

function readCoord(dv: DataView, off: number, type: CoordType, le: boolean): number {
  return type === 'f32' ? dv.getFloat32(off, le) : type === 'f64' ? dv.getFloat64(off, le) : dv.getInt32(off, le);
}

function valueValid(v: number, type: CoordType): boolean {
  if (type === 'i32') return Math.abs(v) < MAX_ABS_INT;
  if (!Number.isFinite(v)) return false;
  const a = Math.abs(v);
  return a <= MAX_ABS_FLOAT && (a === 0 || a >= MIN_ABS_NONZERO_FLOAT);
}

/**
 * Record sizes worth testing: lags whose byte autocorrelation stands clearly
 * above chance, minus multiples of a smaller such lag (a multiple of the record
 * size repeats as well as the record size does). Strongest first, capped.
 */
export function candidateStrides(bytes: Uint8Array): number[] {
  const n = Math.min(bytes.length, 64 * 1024);
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i++) counts[bytes[i]]++;
  let chance = 0;
  for (let k = 0; k < 256; k++) chance += (counts[k] / n) ** 2;
  const scored: Array<[number, number]> = [];
  for (let lag = STRIDE_LAG_MIN; lag <= Math.min(STRIDE_LAG_MAX, Math.floor(n / 8)); lag++) {
    let same = 0;
    for (let i = 0; i + lag < n; i++) if (bytes[i] === bytes[i + lag]) same++;
    scored.push([lag, same / (n - lag)]);
  }
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map(([, v]) => v));
  if (best - chance < 0.01) return [];
  const band = scored.filter(([, v]) => v >= chance + 0.5 * (best - chance)).map(([l]) => l);
  const minimal = band.filter((l) => !band.some((d) => d < l && l % d === 0));
  const byLag = new Map(scored);
  return minimal.sort((a, b) => byLag.get(b)! - byLag.get(a)! || a - b).slice(0, STRIDE_CANDIDATES);
}

interface Scored { layout: RecoveredLayout; points: Float64Array; count: number; records: number; score: number; signals: PlausibilitySignals }

function tryBinary(bytes: Uint8Array, total: number, stride: number, type: CoordType, le: boolean, off: number, budget: () => void): Scored | 'structural' | null {
  const size = TYPE_SIZE[type];
  const phase = total % stride;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inSample = Math.floor((bytes.length - phase) / stride);
  if (inSample < MIN_RECORDS) return null;
  const valid = (k: number) => {
    const base = phase + k * stride + off;
    for (let a = 0; a < 3; a++) if (!valueValid(readCoord(dv, base + a * size, type, le), type)) return false;
    return true;
  };
  // Header: the records before the last invalid one in the leading window.
  const lead = Math.min(inSample, 64);
  let first = 0;
  for (let k = 0; k < lead; k++) if (!valid(k)) first = k + 1;
  if (first > 32 || inSample - first < MIN_RECORDS) return null;
  const count = Math.min(inSample - first, SCORE_RECORDS);
  if (count * 24 > RECOVERY_MEMORY_BUDGET_BYTES) throw new BoundHit('memory');
  budget();
  const xyz = new Float64Array(count * 3);
  for (let k = 0; k < count; k++) {
    if (!valid(first + k)) return null;
    const base = phase + (first + k) * stride + off;
    for (let a = 0; a < 3; a++) xyz[3 * k + a] = readCoord(dv, base + a * size, type, le);
  }
  // Every sampled record must decode, not only the scored ones.
  for (let k = first + count; k < inSample; k++) if (!valid(k)) return null;
  const p = plausibility(xyz, count);
  if (!p.ok) return STRUCTURAL.has(p.why!) ? 'structural' : null;
  const headerBytes = phase + first * stride;
  return {
    layout: { kind: 'binary', headerBytes, stride, endianness: le ? 'little' : 'big', type, offsets: [off, off + size, off + 2 * size], scale: 1 },
    points: xyz, count, records: (total - headerBytes) / stride, score: p.score, signals: p.signals,
  };
}

// ------------------------------------------------------------------ text

const DELIMS = [',', '\t', ';', ' '];
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function splitLine(line: string, d: string): string[] {
  return d === ' ' ? line.trim().split(/ +/) : line.split(d).map((s) => s.trim());
}

function tryText(bytes: Uint8Array): Scored | { abstain: string } | null {
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
    const b = bytes[i];
    if (b === 0 || (b < 0x20 && b !== 9 && b !== 10 && b !== 13)) return null;
  }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // A head sample may end mid-line.
  const lastNl = text.lastIndexOf('\n');
  if (lastNl > 0 && lastNl < text.length - 1) text = text.slice(0, lastNl);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < MIN_RECORDS) return { abstain: 'too few text lines' };
  const found: Scored[] = [];
  for (const d of DELIMS) {
    let header = 0;
    while (header < Math.min(4, lines.length) && !splitLine(lines[header], d).every((t) => NUMBER.test(t))) header++;
    const rows = lines.slice(header).map((l) => splitLine(l, d));
    const width = rows[0]?.length ?? 0;
    if (width < 3 || width > 16) continue;
    if (!rows.every((r) => r.length === width && r.every((t) => NUMBER.test(t)))) continue;
    // Coordinate columns: named x y z in a header line, otherwise the columns
    // that carry decimals when exactly three do, otherwise the first three.
    let cols: number[] | null = null;
    if (header > 0) {
      const names = splitLine(lines[header - 1], d).map((s) => s.toLowerCase());
      const idx = ['x', 'y', 'z'].map((a) => names.indexOf(a));
      if (idx.every((k) => k >= 0)) cols = idx;
    }
    if (!cols) {
      const fractional = [...Array(width).keys()].filter((k) => rows.some((r) => /[.eE]/.test(r[k])));
      if (width === 3) cols = [0, 1, 2];
      else if (fractional.length === 3) cols = fractional;
      else continue;
    }
    const n = Math.min(rows.length, SCORE_RECORDS);
    const xyz = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) xyz[3 * k + a] = Number(rows[k][cols[a]]);
    const p = plausibility(xyz, n);
    if (!p.ok) continue;
    found.push({
      layout: { kind: 'text', delimiter: d, headerLines: header, columnCount: width, coordinateColumns: cols as [number, number, number] },
      points: xyz, count: n, records: rows.length, score: p.score, signals: p.signals,
    });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.score - a.score);
  if (found.length > 1) return { abstain: 'two text readings fit equally' };
  return found[0];
}

// ------------------------------------------------------------------ entry

/** Decode every record of a recovered layout (strided to the preview cap). */
export function decodeRecovered(bytes: Uint8Array, layout: RecoveredLayout, cap = RECOVERED_PREVIEW_POINT_CAP): { points: Float64Array; count: number; strided: number } {
  if (layout.kind === 'text') {
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/).slice(layout.headerLines).filter((l) => l.trim());
    const rows = lines.map((l) => splitLine(l, layout.delimiter)).filter((r) => r.length === layout.columnCount);
    const step = Math.max(1, Math.ceil(rows.length / cap));
    const n = Math.ceil(rows.length / step);
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) pts[3 * k + a] = Number(rows[k * step][layout.coordinateColumns[a]]);
    return { points: pts, count: n, strided: step };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = Math.floor((bytes.length - layout.headerBytes) / layout.stride);
  const step = Math.max(1, Math.ceil(records / cap));
  const n = Math.ceil(records / step);
  const pts = new Float64Array(3 * n);
  const le = layout.endianness === 'little';
  for (let k = 0; k < n; k++) {
    const base = layout.headerBytes + k * step * layout.stride;
    for (let a = 0; a < 3; a++) pts[3 * k + a] = readCoord(dv, base + layout.offsets[a], layout.type, le);
  }
  return { points: pts, count: n, strided: step };
}

/**
 * Recover point records from bytes no known format opened. `bytes` is the
 * whole file or its head (at most RECOVERY_SAMPLE_BYTES are read).
 */
export function recoverPointRecords(input: Uint8Array, opts: RecoveryOptions = {}): RecoveryOutcome {
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const bytes = input.subarray(0, RECOVERY_SAMPLE_BYTES);
  const total = opts.totalBytes ?? input.length;
  let tried = 0;
  const budget = () => {
    if (opts.signal?.aborted) throw new BoundHit('cancelled');
    if (now() - start > RECOVERY_TIME_BUDGET_MS) throw new BoundHit('time budget');
  };
  try {
    const text = tryText(bytes);
    tried++;
    if (text && 'abstain' in text) return { status: 'abstain', reason: text.abstain, hypothesesTried: tried };
    if (text) return offer(text, tried);
    const survivors: Scored[] = [];
    // Hypotheses that share a stride, a type and the byte that carries each
    // coordinate's sign and exponent (or high digits) read the same field:
    // the right byte order, or a shifted misreading that borrows its low bytes
    // from the neighbouring field. When any reading of a field shows the bytes
    // are a curve, a plane or one smooth sequence, none of them is geometry.
    const anchorKey = (stride: number, type: CoordType, le: boolean, off: number) =>
      `${stride}:${type}:${(off + (le ? TYPE_SIZE[type] - 1 : 0)) % stride}`;
    const structural = new Set<string>();
    for (const stride of candidateStrides(bytes)) {
      for (const type of ['f32', 'f64', 'i32'] as CoordType[]) {
        const maxOff = Math.min(MAX_COORD_OFFSET, stride - 3 * TYPE_SIZE[type]);
        for (let off = 0; off <= maxOff; off++) {
          for (const le of [true, false]) {
            if (++tried > MAX_LAYOUT_HYPOTHESES) throw new BoundHit('hypothesis budget');
            budget();
            const s = tryBinary(bytes, total, stride, type, le, off, budget);
            if (s === 'structural') structural.add(anchorKey(stride, type, le, off));
            else if (s) survivors.push(s);
          }
        }
      }
    }
    // A stride that is a multiple of a surviving stride with the same field
    // placement reads every k-th record of it: keep the record size.
    const grounded = survivors.filter((s) => {
      const l = s.layout as BinaryLayout;
      return !structural.has(anchorKey(l.stride, l.type, l.endianness === 'little', l.offsets[0]));
    });
    let kept = grounded.filter((s) => !grounded.some((o) =>
      o !== s && o.layout.kind === 'binary' && s.layout.kind === 'binary' &&
      s.layout.stride % o.layout.stride === 0 && s.layout.stride > o.layout.stride &&
      o.layout.type === s.layout.type && o.layout.endianness === s.layout.endianness &&
      s.layout.offsets[0] % o.layout.stride === o.layout.offsets[0]));
    if (kept.length === 0) return { status: 'abstain', reason: 'no layout hypothesis is plausible', hypothesesTried: tried };
    // Parsimony: the smallest record size that decodes every record coherently
    // explains the bytes with the fewest assumptions. A larger stride that also
    // passes is reading fields out of order.
    const smallest = Math.min(...kept.map((k) => (k.layout as BinaryLayout).stride));
    kept = kept.filter((k) => (k.layout as BinaryLayout).stride === smallest);
    kept.sort((a, b) => b.score - a.score);
    if (kept.length > 1 && kept[0].score - kept[1].score < TIE_MARGIN) {
      return { status: 'abstain', reason: 'the two best layouts fit equally well', hypothesesTried: tried };
    }
    return offer(kept[0], tried);
  } catch (e) {
    if (e instanceof BoundHit) return { status: 'abstain', reason: `bound reached: ${e.message}`, hypothesesTried: tried };
    throw e;
  }

  function offer(s: Scored, n: number): RecoveryOutcome {
    const full = decodeRecovered(input, s.layout, Number.MAX_SAFE_INTEGER);
    return { status: 'offer', layout: s.layout, points: full.points, pointCount: full.count, recordCount: s.records, score: s.score, signals: s.signals, hypothesesTried: n };
  }
}
