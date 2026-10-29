/**
 * canonical.mjs: one fixed-width record per point, so clouds decoded by
 * different paths (and by an independent reader) can be compared as
 * multisets.
 *
 * A record holds the LAS integer coordinates and the per-point attributes OLV
 * keeps for LAS point formats 6 to 10. Comparison sorts both sides by the whole
 * record (integer X, Y, Z first, then the attributes) and walks them in step.
 * Duplicate records are kept: the sort preserves multiplicity, and nothing is
 * matched by nearest neighbour, ICP or deduplication.
 *
 * Plain ESM with no imports, so the same file runs in Node, in Vitest and in
 * the browser page of the pooled run.
 */

/** Bytes per canonical record. */
export const RECORD_BYTES = 40;

/**
 * Field layout. `bytes` is the width in the record; every field is
 * little-endian. A path that does not decode a field leaves it out of its
 * `fields` list, and the comparison covers only fields both sides decoded.
 */
export const FIELDS = Object.freeze([
  { name: 'X', offset: 0, bytes: 4 },
  { name: 'Y', offset: 4, bytes: 4 },
  { name: 'Z', offset: 8, bytes: 4 },
  { name: 'intensity', offset: 12, bytes: 2 },
  { name: 'pointSourceId', offset: 14, bytes: 2 },
  { name: 'red8', offset: 16, bytes: 1 },
  { name: 'green8', offset: 17, bytes: 1 },
  { name: 'blue8', offset: 18, bytes: 1 },
  { name: 'classification', offset: 19, bytes: 1 },
  { name: 'classificationFlags', offset: 20, bytes: 1 },
  { name: 'returnNumber', offset: 21, bytes: 1 },
  { name: 'returnCount', offset: 22, bytes: 1 },
  { name: 'userData', offset: 23, bytes: 1 },
  { name: 'scanAngleRaw', offset: 24, bytes: 2 },
  { name: 'scannerChannel', offset: 26, bytes: 1 },
  { name: 'scanDirection', offset: 27, bytes: 1 },
  { name: 'edgeOfFlightLine', offset: 28, bytes: 1 },
  { name: 'gpsTime', offset: 32, bytes: 8 },
]);

/** LAS 1.4 extended scan angle unit, degrees per count. */
const SCAN_ANGLE_UNIT_DEG = 0.006;

/** Half the spacing between adjacent float32 values at magnitude `v`. */
export function float32HalfUlp(v) {
  const a = Math.abs(v);
  if (a === 0) return 2 ** -150;
  const e = Math.floor(Math.log2(a));
  return 2 ** (e - 24);
}

/**
 * Build canonical records from global (float64) coordinates and attribute
 * arrays shaped like OLV's `GlobalPoints`.
 *
 * Coordinates go back to LAS integers with `round((world - offset) / scale)`.
 * The residual `|world - (int * scale + offset)|` is the representation error
 * the path introduced; it is reported per axis, and a residual of half a scale
 * step or more is counted as `ambiguousRounding`, because then the integer the
 * path held can no longer be recovered with certainty.
 *
 * @param {object} g      `{ count, x, y, z, colors?, intensity?, ... }`
 * @param {{ scale: number[], offset: number[] }} q  The source quantisation.
 * @param {object} [opts] `{ local?: Float32Array }` local float32 positions,
 *                        used only to report their largest magnitude.
 */
export function canonicalFromGlobal(g, q, opts = {}) {
  const n = g.count;
  const buf = new ArrayBuffer(n * RECORD_BYTES);
  const view = new DataView(buf);
  const fields = ['X', 'Y', 'Z'];
  const has = (k) => g[k] != null;
  if (has('intensity')) fields.push('intensity');
  if (has('pointSourceId')) fields.push('pointSourceId');
  if (has('colors')) fields.push('red8', 'green8', 'blue8');
  if (has('classification')) fields.push('classification');
  if (has('classificationFlags')) fields.push('classificationFlags');
  if (has('returnNumber')) fields.push('returnNumber');
  if (has('returnCount')) fields.push('returnCount');
  if (has('userData')) fields.push('userData');
  if (has('scanAngle')) fields.push('scanAngleRaw');
  if (has('scannerChannel')) fields.push('scannerChannel');
  if (has('scanDirection')) fields.push('scanDirection');
  if (has('edgeOfFlightLine')) fields.push('edgeOfFlightLine');
  if (has('gpsTime')) fields.push('gpsTime');

  const maxErr = [0, 0, 0];
  let nonFinite = 0;
  let ambiguousRounding = 0;
  let scanAngleResidualMax = 0;
  const axes = [g.x, g.y, g.z];
  for (let i = 0; i < n; i++) {
    const o = i * RECORD_BYTES;
    for (let a = 0; a < 3; a++) {
      const w = axes[a][i];
      if (!Number.isFinite(w)) {
        nonFinite++;
        view.setInt32(o + a * 4, 0, true);
        continue;
      }
      const s = q.scale[a];
      const k = Math.round((w - q.offset[a]) / s);
      const err = Math.abs(w - (k * s + q.offset[a]));
      if (err > maxErr[a]) maxErr[a] = err;
      if (err >= s / 2) ambiguousRounding++;
      view.setInt32(o + a * 4, k, true);
    }
    if (g.intensity) view.setUint16(o + 12, g.intensity[i], true);
    if (g.pointSourceId) view.setUint16(o + 14, g.pointSourceId[i], true);
    if (g.colors) {
      view.setUint8(o + 16, g.colors[i * 3]);
      view.setUint8(o + 17, g.colors[i * 3 + 1]);
      view.setUint8(o + 18, g.colors[i * 3 + 2]);
    }
    if (g.classification) view.setUint8(o + 19, g.classification[i]);
    if (g.classificationFlags) view.setUint8(o + 20, g.classificationFlags[i]);
    if (g.returnNumber) view.setUint8(o + 21, g.returnNumber[i]);
    if (g.returnCount) view.setUint8(o + 22, g.returnCount[i]);
    if (g.userData) view.setUint8(o + 23, g.userData[i]);
    if (g.scanAngle) {
      const raw = Math.round(g.scanAngle[i] / SCAN_ANGLE_UNIT_DEG);
      const r = Math.abs(g.scanAngle[i] - raw * SCAN_ANGLE_UNIT_DEG);
      if (r > scanAngleResidualMax) scanAngleResidualMax = r;
      view.setInt16(o + 24, raw, true);
    }
    if (g.scannerChannel) view.setUint8(o + 26, g.scannerChannel[i]);
    if (g.scanDirection) view.setUint8(o + 27, g.scanDirection[i]);
    if (g.edgeOfFlightLine) view.setUint8(o + 28, g.edgeOfFlightLine[i]);
    if (g.gpsTime) view.setFloat64(o + 32, g.gpsTime[i], true);
  }
  let maxAbsLocal = null;
  if (opts.local) {
    maxAbsLocal = [0, 0, 0];
    for (let i = 0; i < opts.local.length; i++) {
      const v = Math.abs(opts.local[i]);
      if (v > maxAbsLocal[i % 3]) maxAbsLocal[i % 3] = v;
    }
  }
  return {
    records: new Uint8Array(buf),
    count: n,
    fields,
    stats: { maxAbsError: maxErr, nonFinite, ambiguousRounding, scanAngleResidualMax, maxAbsLocal },
  };
}

/** Copy `records` with every byte outside `keep` zeroed. */
function masked(records, keep) {
  const out = new Uint8Array(records);
  const mask = new Uint8Array(RECORD_BYTES);
  for (const f of FIELDS) if (keep.includes(f.name)) mask.fill(1, f.offset, f.offset + f.bytes);
  for (let i = 0; i < out.length; i++) if (!mask[i % RECORD_BYTES]) out[i] = 0;
  return out;
}

/**
 * Indices of `records` in ascending record order: signed X, Y, Z first, then
 * the remaining bytes as unsigned words. Equal records stay adjacent.
 */
export function sortedOrder(records) {
  const n = records.length / RECORD_BYTES;
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const words = RECORD_BYTES / 4;
  const keys = new Uint32Array(n * words);
  for (let i = 0; i < n; i++) {
    for (let w = 0; w < words; w++) {
      const v = view.getUint32(i * RECORD_BYTES + w * 4, true);
      keys[i * words + w] = w < 3 ? (v ^ 0x80000000) >>> 0 : v;
    }
  }
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    const ao = a * words;
    const bo = b * words;
    for (let w = 0; w < words; w++) {
      const d = keys[ao + w] - keys[bo + w];
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  });
  return idx;
}

/** Records that repeat an earlier identical record, given a sorted order. */
function duplicateCount(records, order) {
  let dups = 0;
  for (let k = 1; k < order.length; k++) {
    if (sameRecord(records, order[k - 1], records, order[k])) dups++;
  }
  return dups;
}

function sameRecord(ra, ia, rb, ib) {
  const oa = ia * RECORD_BYTES;
  const ob = ib * RECORD_BYTES;
  for (let j = 0; j < RECORD_BYTES; j++) if (ra[oa + j] !== rb[ob + j]) return false;
  return true;
}

function fieldEqual(ra, ia, rb, ib, f) {
  const oa = ia * RECORD_BYTES + f.offset;
  const ob = ib * RECORD_BYTES + f.offset;
  for (let j = 0; j < f.bytes; j++) if (ra[oa + j] !== rb[ob + j]) return false;
  return true;
}

/**
 * Compare two canonical sets over the fields both decoded.
 *
 * `multisetEqual` is the verdict: same count and, after sorting, every record
 * identical. `mismatchedRecords` counts sorted positions that differ, and
 * `fieldMismatches` breaks that down by field at those positions. Coordinates
 * are also compared on their own (sorted by X, Y, Z only) so a coordinate
 * difference can be told apart from an attribute difference.
 */
export function compareCanonical(a, b) {
  const compared = a.fields.filter((f) => b.fields.includes(f));
  const notCompared = {
    onlyA: a.fields.filter((f) => !b.fields.includes(f)),
    onlyB: b.fields.filter((f) => !a.fields.includes(f)),
  };
  const ra = masked(a.records, compared);
  const rb = masked(b.records, compared);
  const oa = sortedOrder(ra);
  const ob = sortedOrder(rb);
  const n = Math.min(a.count, b.count);
  const fieldMismatches = Object.fromEntries(compared.map((f) => [f, 0]));
  let mismatchedRecords = Math.abs(a.count - b.count);
  const defs = FIELDS.filter((f) => compared.includes(f.name));
  for (let k = 0; k < n; k++) {
    if (sameRecord(ra, oa[k], rb, ob[k])) continue;
    mismatchedRecords++;
    for (const f of defs) if (!fieldEqual(ra, oa[k], rb, ob[k], f)) fieldMismatches[f.name]++;
  }
  // Coordinates alone.
  const ca = masked(a.records, ['X', 'Y', 'Z']);
  const cb = masked(b.records, ['X', 'Y', 'Z']);
  const sa = sortedOrder(ca);
  const sb = sortedOrder(cb);
  let coordinateMismatches = Math.abs(a.count - b.count);
  for (let k = 0; k < n; k++) if (!sameRecord(ca, sa[k], cb, sb[k])) coordinateMismatches++;
  return {
    countA: a.count,
    countB: b.count,
    comparedFields: compared,
    notCompared,
    multisetEqual: a.count === b.count && mismatchedRecords === 0,
    mismatchedRecords,
    coordinateMismatches,
    fieldMismatches,
    duplicateRecordsA: duplicateCount(ra, oa),
    duplicateRecordsB: duplicateCount(rb, ob),
  };
}

/** Integer bounds of a canonical set, per axis. */
export function integerBounds(c) {
  const view = new DataView(c.records.buffer, c.records.byteOffset, c.records.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = view.getInt32(i * RECORD_BYTES + a * 4, true);
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}
