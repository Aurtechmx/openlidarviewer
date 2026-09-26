#!/usr/bin/env node
/**
 * generate.mjs: deterministic generator for the intake recovery corpus.
 *
 * Builds labelled samples for phase C of the open-any-point-cloud intake
 * (generic fixed-record and text recovery). Positives are headerless point
 * streams; negatives are binaries and text that are not point clouds. Every
 * sample is a pure function of this file and the two seed files under seeds/,
 * so only the manifest (with content hashes) is committed, never the samples.
 *
 * Usage:
 *   node validation/intake-corpus/generate.mjs --manifest   rewrite manifest.json
 *   node validation/intake-corpus/generate.mjs --out <dir>  write every sample
 *
 * The acceptance criteria live in criteria.json and were registered before
 * this generator. See protocol.md.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const COMMITTED_FILES = [
  'criteria.json',
  'protocol.md',
  'generate.mjs',
  'seeds/OLV-DS-090-subsample.txt',
  'seeds/OLV-DS-093-subsample.txt',
];

export const SOURCES = {
  'OLV-DS-090': {
    datasetId: 'OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST',
    licence: 'CC-BY-4.0',
    attribution: 'National Center for Airborne Laser Mapping (NCALM), distributed by OpenTopography',
    seedFile: 'seeds/OLV-DS-090-subsample.txt',
  },
  'OLV-DS-093': {
    datasetId: 'OLV-DS-093-ROGUE-SISKIYOU-2019-10TDM3449',
    licence: 'public-domain',
    attribution: 'USDA Forest Service / U.S. Geological Survey 3D Elevation Program (3DEP)',
    seedFile: 'seeds/OLV-DS-093-subsample.txt',
  },
};

// ---------------------------------------------------------------- utilities

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const TYPE_SIZE = { f32: 4, f64: 8, i32: 4, u16: 2, u8: 1 };

function writeValue(dv, off, type, v, le) {
  switch (type) {
    case 'f32': dv.setFloat32(off, v, le); break;
    case 'f64': dv.setFloat64(off, v, le); break;
    case 'i32': dv.setInt32(off, v, le); break;
    case 'u16': dv.setUint16(off, v, le); break;
    case 'u8': dv.setUint8(off, v); break;
    default: throw new Error(`unknown type ${type}`);
  }
}

function readValue(dv, off, type, le) {
  switch (type) {
    case 'f32': return dv.getFloat32(off, le);
    case 'f64': return dv.getFloat64(off, le);
    case 'i32': return dv.getInt32(off, le);
    default: throw new Error(`not a coordinate type ${type}`);
  }
}

// ---------------------------------------------------------------- point sources

let seedCache = null;
function seedPoints() {
  if (seedCache) return seedCache;
  seedCache = {};
  for (const [key, src] of Object.entries(SOURCES)) {
    const rows = readFileSync(join(CORPUS_DIR, src.seedFile), 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.trim().split(/\s+/).map(Number));
    seedCache[key] = rows;
  }
  return seedCache;
}

/** Real points: tuning takes even positions, held-out odd positions. */
function realPoints(key, split, rng) {
  const all = seedPoints()[key];
  const parity = split === 'tuning' ? 0 : 1;
  const pool = all.filter((_, i) => i % 2 === parity);
  const n = 300 + Math.floor(rng() * 400);
  const start = Math.floor(rng() * (pool.length - n));
  return pool.slice(start, start + n).map(([x, y, z, i]) => ({ x, y, z, i, r: 0, g: 0, b: 0 }));
}

function colourise(pts) {
  let zmin = Infinity, zmax = -Infinity;
  for (const p of pts) { zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); }
  const span = zmax - zmin || 1;
  for (const p of pts) {
    const t = (p.z - zmin) / span;
    p.r = Math.round(255 * t);
    p.g = Math.round(255 * (1 - Math.abs(2 * t - 1)));
    p.b = Math.round(255 * (1 - t));
  }
  return pts;
}

const SCENES = ['terrain', 'building', 'sphere', 'tree'];

function syntheticPoints(scene, rng) {
  const n = 300 + Math.floor(rng() * 500);
  const ox = Math.round((rng() - 0.5) * 2e6) / 100;
  const oy = Math.round((rng() - 0.5) * 2e6) / 100;
  const oz = Math.round(rng() * 50000) / 100;
  const pts = [];
  for (let k = 0; k < n; k++) {
    let x, y, z;
    if (scene === 'terrain') {
      x = rng() * 200; y = rng() * 200;
      z = 5 * Math.sin(x / 30) + 3 * Math.cos(y / 17) + 0.05 * gauss(rng);
    } else if (scene === 'building') {
      const face = Math.floor(rng() * 5);
      const u = rng() * 20, v = rng() * 12;
      if (face === 0) { x = u; y = 0; z = v; }
      else if (face === 1) { x = u; y = 15; z = v; }
      else if (face === 2) { x = 0; y = u * 0.75; z = v; }
      else if (face === 3) { x = 20; y = u * 0.75; z = v; }
      else { x = u; y = rng() * 15; z = 12; }
    } else if (scene === 'sphere') {
      const th = 2 * Math.PI * rng(), ph = Math.acos(2 * rng() - 1), r = 4 + 0.01 * gauss(rng);
      x = r * Math.sin(ph) * Math.cos(th); y = r * Math.sin(ph) * Math.sin(th); z = r * Math.cos(ph);
    } else {
      const h = rng() * 15, th = 2 * Math.PI * rng();
      const r = h < 5 ? 0.3 : 3 * (1 - (h - 5) / 10);
      x = r * Math.cos(th); y = r * Math.sin(th); z = h;
    }
    // Two decimals so every scaled int layout reproduces them exactly.
    pts.push({
      x: Math.round((x + ox) * 100) / 100,
      y: Math.round((y + oy) * 100) / 100,
      z: Math.round((z + oz) * 100) / 100,
      i: Math.floor(rng() * 65536), r: 0, g: 0, b: 0,
    });
  }
  return colourise(pts);
}

// ---------------------------------------------------------------- layouts

/**
 * A binary layout: header bytes, stride, byte order and field list. Coordinate
 * fields carry scale and origin (value = raw * scale + origin). Layout keys are
 * the identity used to keep held-out layouts out of tuning.
 */
function bin(key, { header = 0, stride, le = true, xyz, xyzOffset = 0, extras = [], scale = 1, pad = 'zero' }) {
  const size = TYPE_SIZE[xyz];
  const fields = ['x', 'y', 'z'].map((name, k) => ({ name, offset: xyzOffset + k * size, type: xyz }));
  for (const e of extras) fields.push(e);
  return { key, kind: 'binary', headerBytes: header, stride, endianness: le ? 'little' : 'big', coordType: xyz, scale, fields, pad };
}

const u16 = (name, offset) => ({ name, offset, type: 'u16' });
const rgb = (offset) => [
  { name: 'r', offset, type: 'u8' },
  { name: 'g', offset: offset + 1, type: 'u8' },
  { name: 'b', offset: offset + 2, type: 'u8' },
];

export const LAYOUTS = {
  tuning: [
    bin('f32-xyz-s12-le-h0', { stride: 12, xyz: 'f32' }),
    bin('f32-xyz-i16-s16-le-h0', { stride: 16, xyz: 'f32', extras: [u16('intensity', 12)] }),
    bin('f64-xyz-s24-le-h0', { stride: 24, xyz: 'f64' }),
    bin('i32c-xyz-s12-le-h0', { stride: 12, xyz: 'i32', scale: 0.01 }),
    bin('f32-xyz-rgb-s15-le-h0', { stride: 15, xyz: 'f32', extras: rgb(12) }),
    bin('f32-xyz-s12-be-h0', { stride: 12, xyz: 'f32', le: false }),
    bin('f64-xyz-i16-s32-le-h64', { header: 64, stride: 32, xyz: 'f64', extras: [u16('intensity', 24)] }),
    bin('i32c-xyz-i16-rgb-s20-le-h128', { header: 128, stride: 20, xyz: 'i32', scale: 0.01, extras: [u16('intensity', 12), ...rgb(14)] }),
    { key: 'text-space-xyz-h0', kind: 'text', delimiter: ' ', headerLines: 0, columns: ['x', 'y', 'z'], decimals: 2 },
  ],
  heldout: [
    bin('f32-xyz-s20-be-h32', { header: 32, stride: 20, xyz: 'f32', le: false, pad: 'noise' }),
    bin('f64-xyz-s48-le-h0', { stride: 48, xyz: 'f64', pad: 'noise' }),
    bin('i32m-xyz-i16-s16-be-h0', { stride: 16, xyz: 'i32', scale: 0.001, le: false, extras: [u16('intensity', 12)] }),
    bin('f32-xyz-rgb-s16-be-h17', { header: 17, stride: 16, xyz: 'f32', le: false, extras: rgb(12) }),
    bin('f64-xyz-i16-rgb-s29-le-h256', { header: 256, stride: 29, xyz: 'f64', extras: [u16('intensity', 24), ...rgb(26)] }),
    bin('i32c-xyz-rgb-s15-le-h7', { header: 7, stride: 15, xyz: 'i32', scale: 0.01, extras: rgb(12) }),
    bin('f32-i16-xyz-s14-le-h0', { stride: 14, xyz: 'f32', xyzOffset: 2, extras: [u16('intensity', 0)] }),
    { key: 'text-comma-xyzi-h1', kind: 'text', delimiter: ',', headerLines: 1, columns: ['x', 'y', 'z', 'intensity'], decimals: 3 },
    { key: 'text-tab-ixyz-h0', kind: 'text', delimiter: '\t', headerLines: 0, columns: ['intensity', 'x', 'y', 'z'], decimals: 2 },
  ],
};

/** Encode points; returns bytes and the truth coordinates as stored. */
function encodePositive(layout, pts, rng) {
  if (layout.kind === 'text') {
    const lines = [];
    if (layout.headerLines) lines.push(layout.columns.join(layout.delimiter));
    const truth = new Float64Array(pts.length * 3);
    pts.forEach((p, k) => {
      const vals = layout.columns.map((c) => (c === 'intensity' ? String(p.i) : p[c].toFixed(layout.decimals)));
      lines.push(vals.join(layout.delimiter));
      truth[3 * k] = Number(p.x.toFixed(layout.decimals));
      truth[3 * k + 1] = Number(p.y.toFixed(layout.decimals));
      truth[3 * k + 2] = Number(p.z.toFixed(layout.decimals));
    });
    return { bytes: Buffer.from(lines.join('\n') + '\n', 'utf8'), truth, origin: [0, 0, 0] };
  }
  // Float32 and scaled int layouts store local coordinates relative to an
  // integer origin, the way real exporters keep precision.
  let origin = [0, 0, 0];
  if (layout.coordType !== 'f64') {
    origin = ['x', 'y', 'z'].map((a) => Math.floor(Math.min(...pts.map((p) => p[a]))));
  }
  const le = layout.endianness === 'little';
  const buf = new ArrayBuffer(layout.headerBytes + layout.stride * pts.length);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  for (let k = 0; k < layout.headerBytes; k++) u8[k] = Math.floor(rng() * 256);
  if (layout.pad === 'noise') {
    for (let k = layout.headerBytes; k < u8.length; k++) u8[k] = Math.floor(rng() * 256);
  }
  const truth = new Float64Array(pts.length * 3);
  pts.forEach((p, k) => {
    const base = layout.headerBytes + k * layout.stride;
    for (const f of layout.fields) {
      const off = base + f.offset;
      const axis = 'xyz'.indexOf(f.name);
      if (axis >= 0) {
        const local = p[f.name] - origin[axis];
        const raw = f.type === 'i32' ? Math.round(local / layout.scale) : local;
        writeValue(dv, off, f.type, raw, le);
      } else if (f.name === 'intensity') {
        writeValue(dv, off, 'u16', p.i, le);
      } else {
        writeValue(dv, off, 'u8', p[f.name], le);
      }
    }
    // Truth is what a correct decoder reads back from the stored bytes.
    for (let a = 0; a < 3; a++) {
      const f = layout.fields[a];
      const raw = readValue(dv, base + f.offset, f.type, le);
      truth[3 * k + a] = (f.type === 'i32' ? raw * layout.scale : raw) + origin[a];
    }
  });
  return { bytes: Buffer.from(buf), truth, origin };
}

function layoutTruth(layout, origin) {
  if (layout.kind === 'text') {
    return {
      kind: 'text', delimiter: layout.delimiter, headerLines: layout.headerLines,
      coordinateColumns: ['x', 'y', 'z'].map((a) => layout.columns.indexOf(a)),
      columns: layout.columns,
    };
  }
  return {
    kind: 'binary', headerBytes: layout.headerBytes, stride: layout.stride, endianness: layout.endianness,
    fields: layout.fields.map((f) => {
      const axis = 'xyz'.indexOf(f.name);
      if (axis < 0) return { name: f.name, offset: f.offset, type: f.type };
      return { name: f.name, offset: f.offset, type: f.type, scale: f.type === 'i32' ? layout.scale : 1, origin: origin[axis] };
    }),
    padding: layout.pad,
  };
}

// ---------------------------------------------------------------- negatives

const WORDS = ['alpha', 'beta', 'queue', 'worker', 'session', 'cache', 'socket', 'render', 'upload', 'retry', 'config', 'timer'];

function textLog(rng, variant) {
  const lines = [];
  const n = 150 + Math.floor(rng() * 250);
  let t = Date.UTC(2026, 0, 1) + Math.floor(rng() * 1e9);
  for (let k = 0; k < n; k++) {
    t += Math.floor(rng() * 5000);
    const lvl = ['INFO', 'WARN', 'DEBUG', 'ERROR'][Math.floor(rng() * 4)];
    const w = () => WORDS[Math.floor(rng() * WORDS.length)];
    if (variant === 0) lines.push(`${new Date(t).toISOString()} ${lvl} ${w()}.${w()} id=${Math.floor(rng() * 1e6)} took=${(rng() * 900).toFixed(1)}ms`);
    else lines.push(`[${lvl.toLowerCase()}] ${Math.floor(t / 1000)} ${w()} ${w()} ${w()} status=${[200, 404, 500][Math.floor(rng() * 3)]} bytes=${Math.floor(rng() * 1e5)}`);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function csvTable(rng, variant) {
  const n = 100 + Math.floor(rng() * 300);
  const rows = [variant === 0 ? 'name,age,price,quantity,date' : 'order_id;customer;total;items;paid'];
  for (let k = 0; k < n; k++) {
    const name = WORDS[Math.floor(rng() * WORDS.length)] + Math.floor(rng() * 100);
    if (variant === 0) {
      rows.push(`${name},${18 + Math.floor(rng() * 60)},${(rng() * 500).toFixed(2)},${Math.floor(rng() * 40)},2026-0${1 + Math.floor(rng() * 9)}-1${Math.floor(rng() * 9)}`);
    } else {
      rows.push(`${10000 + k};${name};${(rng() * 9000).toFixed(2)};${1 + Math.floor(rng() * 9)};${rng() < 0.5 ? 'yes' : 'no'}`);
    }
  }
  return Buffer.from(rows.join('\n') + '\n', 'utf8');
}

function f32Buffer(values, le = true) {
  const dv = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((v, k) => dv.setFloat32(4 * k, v, le));
  return Buffer.from(dv.buffer);
}

const NEGATIVE_KINDS = {
  'random-bytes': (rng) => {
    const n = 4096 + Math.floor(rng() * 28672);
    return Buffer.from(Array.from({ length: n }, () => Math.floor(rng() * 256)));
  },
  deflate: (rng, v) => {
    // A self-contained fixed-Huffman deflate stream (RFC 1951, BTYPE=01) with
    // literal codes only, so the bytes do not depend on the zlib build.
    const src = v === 0 ? textLog(rng, 0) : f32Buffer(Array.from({ length: 2048 }, (_, k) => Math.sin(k / 9) + 0.1 * gauss(rng)));
    return fixedHuffmanLiterals(src);
  },
  'pcm-audio': (rng, v) => {
    const channels = v === 0 ? 1 : 2;
    const frames = 2000 + Math.floor(rng() * 6000);
    const f1 = 110 + rng() * 800, f2 = 200 + rng() * 2000, sr = 22050;
    const dv = new DataView(new ArrayBuffer(frames * channels * 2));
    for (let k = 0; k < frames; k++) {
      for (let c = 0; c < channels; c++) {
        const s = 0.5 * Math.sin((2 * Math.PI * f1 * k) / sr + c) + 0.2 * Math.sin((2 * Math.PI * f2 * k) / sr) + 0.05 * gauss(rng);
        dv.setInt16(2 * (k * channels + c), Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true);
      }
    }
    return Buffer.from(dv.buffer);
  },
  'image-pixels': (rng, v) => {
    const w = 32 + Math.floor(rng() * 64), h = 32 + Math.floor(rng() * 64);
    const ch = v === 0 ? 3 : 4;
    const noise = rng() < 0.5;
    const out = Buffer.alloc(w * h * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * ch;
      if (noise) { for (let c = 0; c < ch; c++) out[o + c] = Math.floor(rng() * 256); }
      else {
        out[o] = Math.floor((255 * x) / w); out[o + 1] = Math.floor((255 * y) / h);
        out[o + 2] = ((x >> 3) ^ (y >> 3)) & 1 ? 200 : 40;
        if (ch === 4) out[o + 3] = 255;
      }
    }
    return out;
  },
  'f32-signal': (rng, v) => {
    const n = 1500 + Math.floor(rng() * 4000);
    const f = 0.001 + rng() * 0.05;
    return f32Buffer(Array.from({ length: n }, (_, k) =>
      v === 0 ? Math.sin(2 * Math.PI * f * k) * Math.exp(-k / n) : Math.sin(2 * Math.PI * f * k * (1 + k / n)) * 100 + gauss(rng)), v === 0);
  },
  'f32-sorted': (rng, v) => {
    const n = 1500 + Math.floor(rng() * 4000);
    const vals = Array.from({ length: n }, () => (v === 0 ? rng() * 1000 : Math.exp(rng() * 12)));
    vals.sort((a, b) => a - b);
    return f32Buffer(vals, v === 0);
  },
  'mesh-interleaved': (rng, v) => {
    // Vertex blocks alternating with index blocks, as a mesh dump would.
    const parts = [];
    const blocks = 4 + Math.floor(rng() * 6);
    for (let b = 0; b < blocks; b++) {
      const g = 6 + Math.floor(rng() * 6);
      const verts = [];
      for (let yy = 0; yy < g; yy++) for (let xx = 0; xx < g; xx++) {
        verts.push(xx, yy, 0.3 * Math.sin(xx + b));
        if (v === 1) verts.push(0, 0, 1, xx / g, yy / g); // normal + uv, stride 32
      }
      parts.push(f32Buffer(verts));
      const idx = [];
      for (let yy = 0; yy < g - 1; yy++) for (let xx = 0; xx < g - 1; xx++) {
        const a = yy * g + xx;
        idx.push(a, a + 1, a + g, a + 1, a + g + 1, a + g);
      }
      const ib = v === 0 ? Buffer.alloc(idx.length * 4) : Buffer.alloc(idx.length * 2);
      idx.forEach((q, k) => (v === 0 ? ib.writeUInt32LE(q, 4 * k) : ib.writeUInt16LE(q, 2 * k)));
      parts.push(ib);
    }
    return Buffer.concat(parts);
  },
  'text-log': (rng, v) => textLog(rng, v),
  'csv-table': (rng, v) => csvTable(rng, v),
};

/** Minimal deterministic deflate: one final fixed-Huffman block of literals. */
function fixedHuffmanLiterals(src) {
  const out = [];
  let acc = 0, nbits = 0;
  const put = (val, len) => { // LSB-first bit packing
    for (let k = 0; k < len; k++) {
      acc |= ((val >> k) & 1) << nbits; nbits++;
      if (nbits === 8) { out.push(acc); acc = 0; nbits = 0; }
    }
  };
  const putCode = (code, len) => { // Huffman codes are packed MSB first
    for (let k = len - 1; k >= 0; k--) put((code >> k) & 1, 1);
  };
  put(1, 1); put(1, 2); // BFINAL=1, BTYPE=01
  for (const b of src) {
    if (b < 144) putCode(0x30 + b, 8); else putCode(0x190 + (b - 144), 9);
  }
  putCode(0, 7); // end of block (256)
  if (nbits) out.push(acc);
  return Buffer.from(out);
}

// ---------------------------------------------------------------- corpus

const SPLIT_PLAN = {
  // Seeds are disjoint by construction: tuning uses 1xxxxx, held-out 9xxxxx.
  tuning: { seedBase: 100000, positivesPerLayout: 8, negativesPerKind: 6, negVariant: 0 },
  heldout: { seedBase: 900000, positivesPerLayout: 12, negativesPerKind: 12, negVariant: 1 },
};

/** Build every sample in memory. Returns [{entry, bytes, truth}]. */
export function generateCorpus() {
  const samples = [];
  for (const split of ['tuning', 'heldout']) {
    const plan = SPLIT_PLAN[split];
    let seed = plan.seedBase;
    LAYOUTS[split].forEach((layout) => {
      for (let r = 0; r < plan.positivesPerLayout; r++) {
        const s = seed++;
        const rng = mulberry32(s);
        let source, pts;
        if (r < 2) {
          source = r === 0 ? 'OLV-DS-090' : 'OLV-DS-093';
          pts = colourise(realPoints(source, split, rng));
        } else {
          const scene = SCENES[(r - 2) % SCENES.length];
          source = `synthetic:${scene}`;
          pts = syntheticPoints(scene, rng);
        }
        const { bytes, truth, origin } = encodePositive(layout, pts, rng);
        samples.push({
          entry: {
            id: `${split}-pos-${layout.key}-${String(r).padStart(2, '0')}`,
            split, label: 'positive', category: layout.kind === 'text' ? 'text-points' : 'binary-points',
            source, seed: s, bytes: bytes.length, sha256: sha256(bytes),
            pointCount: pts.length,
            truthSha256: sha256(Buffer.from(truth.buffer)),
            layoutKey: layout.key,
            layout: layoutTruth(layout, origin),
          },
          bytes, truth,
        });
      }
    });
    for (const kind of Object.keys(NEGATIVE_KINDS)) {
      for (let r = 0; r < plan.negativesPerKind; r++) {
        const s = seed++;
        const rng = mulberry32(s);
        // The held-out split alternates the kind's two variants; tuning uses one.
        const variant = split === 'tuning' ? plan.negVariant : r % 2;
        const bytes = NEGATIVE_KINDS[kind](rng, variant);
        samples.push({
          entry: {
            id: `${split}-neg-${kind}-${String(r).padStart(2, '0')}`,
            split, label: 'negative', category: kind, variant,
            source: 'synthetic', seed: s, bytes: bytes.length, sha256: sha256(bytes),
          },
          bytes, truth: null,
        });
      }
    }
  }
  return samples;
}

export function buildManifest(samples = generateCorpus()) {
  const committed = {};
  for (const f of COMMITTED_FILES) committed[f] = sha256(readFileSync(join(CORPUS_DIR, f)));
  const count = (split, label) => samples.filter((s) => s.entry.split === split && s.entry.label === label).length;
  return {
    schema: 'olv.intake-corpus.manifest/1',
    generator: 'validation/intake-corpus/generate.mjs',
    criteria: 'validation/intake-corpus/criteria.json',
    note: 'Samples are not committed. Regenerate them with generate.mjs; every sha256 below must match. truthSha256 hashes the truth coordinates as float64 little-endian x,y,z per point.',
    sources: SOURCES,
    committedFiles: committed,
    summary: {
      tuning: { positives: count('tuning', 'positive'), negatives: count('tuning', 'negative') },
      heldout: { positives: count('heldout', 'positive'), negatives: count('heldout', 'negative') },
      totalBytes: samples.reduce((a, s) => a + s.bytes.length, 0),
    },
    samples: samples.map((s) => s.entry),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const samples = generateCorpus();
  if (args.includes('--manifest')) {
    const m = buildManifest(samples);
    writeFileSync(join(CORPUS_DIR, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    console.log(`manifest.json: ${m.samples.length} samples`, JSON.stringify(m.summary));
  }
  const oi = args.indexOf('--out');
  if (oi >= 0) {
    const out = resolve(args[oi + 1]);
    for (const s of samples) {
      const dir = join(out, s.entry.split, s.entry.label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${s.entry.id}.bin`), s.bytes);
      if (s.truth) writeFileSync(join(dir, `${s.entry.id}.truth.f64`), Buffer.from(s.truth.buffer));
    }
    console.log(`wrote ${samples.length} samples to ${out}`);
  }
  if (!args.includes('--manifest') && oi < 0) console.log('usage: generate.mjs --manifest | --out <dir>');
}
