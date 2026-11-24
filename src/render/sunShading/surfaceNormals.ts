/**
 * surfaceNormals.ts: one surface direction per point, for sun shading.
 *
 * The first design averaged heights per horizontal grid cell. A mean height
 * mixes canopy with the ground under it, a wall with the floor beside it, and
 * an empty neighbour with a level one, and it changes value at every cell
 * edge. This one fits a plane to the points of a small 3-D neighbourhood, so a
 * roof, the ground below it and a tree beside it never share a fit:
 *
 *   1. Points fall into 3-D cells. Each cell keeps its count and second
 *      moments, taken about the cell centre so a large coordinate costs no
 *      precision.
 *   2. A cell's plane comes from its own points and the 18 cells sharing a
 *      face or an edge (centre-weighted). An empty neighbour adds nothing. The result counts
 *      only as far as the neighbourhood is flat: foliage, a lone point, a
 *      scan-line of collinear points and near-vertical faces (whose "up" side
 *      is undecidable) count as no surface.
 *   3. A point blends the planes of the eight cells around it, which removes
 *      cell-edge facets. Where the fine cells hold no usable surface (sparse
 *      returns, or noise wider than the cell) the next coarser level answers;
 *      where none does, the point reads as level and keeps its plain colour.
 *
 * Directions are taken in the layer's own up frame with heights in the
 * horizontal unit, so a Y-up scan and a metre/foot scan shade correctly.
 *
 * The result is a 16-bit code per point and does not depend on the sun, so a
 * sun or strength change costs a table lookup (sunTable.ts), not a new pass.
 * Pure: no DOM, no three.js. Runs in sunNormalsWorker.ts.
 */

/** How a layer's interleaved xyz maps to (east, north, up). */
export interface SurfaceFrame {
  /** 2 = Z up; 1 = Y up (north is then -Z, as in the terrain gather). */
  readonly upAxis: 1 | 2;
  /** Height units to horizontal units (1 when they are the same). */
  readonly verticalScale: number;
}

export interface SurfaceNormalsParams {
  readonly frame: SurfaceFrame;
  /** Lowest finite source coordinate on each axis. */
  readonly min: readonly [number, number, number];
  /** Finest cell edge, in horizontal units (see {@link estimateCellSize}). */
  readonly cellSize: number;
  /** Cells kept before the grid is coarsened; bounds memory. */
  readonly maxCells?: number;
}

/**
 * Cells kept in the finest grid before it doubles its cell: one under 2^22, so
 * the arrays never grow past 4 Mi entries (about 250 MB in the worker, freed
 * when the job ends).
 */
export const MAX_CELLS = 4_194_303;
/** The finest cell is this many point spacings wide. */
const CELL_PER_SPACING = 1.5;
/** Levels, each twice the cell of the one before. */
const LEVELS = 3;
const MIN_POINTS = 6;
/** Ratio of the smallest to the middle eigenvalue: below is flat, above is not. */
const FLAT_FULL = 0.06;
const FLAT_NONE = 0.3;
/** Middle to largest: below this the points lie along a line. */
const LINE_RATIO = 0.02;
/** Up component of the normal: steeper than about 80 degrees fades out. */
const STEEP_NONE = 0.12;
const STEEP_FULL = 0.3;
const FIELDS = 10;
const AXIS_LIMIT = 131_072; // 2^17 per axis: three axes fit a double exactly

/** The code of a level surface, which the sun table maps to "unchanged". */
export const LEVEL_CODE = (127 << 8) | 127;

function smooth(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** Pack one component of a unit normal: square-root spacing, fine near level. */
function packComponent(v: number): number {
  return Math.round(Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v))) * 127) + 127;
}

/** The component a packed byte stands for. */
export function unpackComponent(byte: number): number {
  const s = (byte - 127) / 127;
  return Math.sign(s) * s * s;
}

/** The 16-bit code of a unit normal with a non-negative up component. */
export function packNormal(east: number, north: number): number {
  return (packComponent(east) << 8) | packComponent(north);
}

/** A sparse grid of cells keyed by integer coordinates. */
class CellGrid {
  count = 0;
  readonly cell: number;
  private _slots: Int32Array;
  private _mask: number;
  ix: Int32Array;
  iy: Int32Array;
  iz: Int32Array;
  m: Float32Array;
  /** Fitted unit normal times its weight (three floats), and the weight. */
  fit: Float32Array | null = null;

  constructor(cell: number, capacity = 4096) {
    this.cell = cell;
    this._slots = new Int32Array(capacity * 2).fill(-1);
    this._mask = capacity * 2 - 1;
    this.ix = new Int32Array(capacity);
    this.iy = new Int32Array(capacity);
    this.iz = new Int32Array(capacity);
    this.m = new Float32Array(capacity * FIELDS);
  }

  private _hash(x: number, y: number, z: number): number {
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ Math.imul(z, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    return (h ^ (h >>> 13)) & this._mask;
  }

  find(x: number, y: number, z: number): number {
    let s = this._hash(x, y, z);
    for (;;) {
      const c = this._slots[s];
      if (c < 0) return -1;
      if (this.ix[c] === x && this.iy[c] === y && this.iz[c] === z) return c;
      s = (s + 1) & this._mask;
    }
  }

  ensure(x: number, y: number, z: number): number {
    const found = this.find(x, y, z);
    if (found >= 0) return found;
    if (this.count === this.ix.length) this._grow();
    const c = this.count++;
    this.ix[c] = x;
    this.iy[c] = y;
    this.iz[c] = z;
    this._insert(c);
    return c;
  }

  private _insert(c: number): void {
    let s = this._hash(this.ix[c], this.iy[c], this.iz[c]);
    while (this._slots[s] >= 0) s = (s + 1) & this._mask;
    this._slots[s] = c;
  }

  private _grow(): void {
    const cap = this.ix.length * 2;
    const copy = (a: Int32Array): Int32Array => { const b = new Int32Array(cap); b.set(a); return b; };
    this.ix = copy(this.ix);
    this.iy = copy(this.iy);
    this.iz = copy(this.iz);
    const m = new Float32Array(cap * FIELDS);
    m.set(this.m);
    this.m = m;
    this._slots = new Int32Array(cap * 2).fill(-1);
    this._mask = cap * 2 - 1;
    for (let c = 0; c < this.count; c++) this._insert(c);
  }

  /** The same points in cells twice as wide. */
  coarser(): CellGrid {
    const out = new CellGrid(this.cell * 2, Math.max(1024, this.ix.length >> 1));
    for (let c = 0; c < this.count; c++) {
      const x = this.ix[c];
      const y = this.iy[c];
      const z = this.iz[c];
      const d = out.ensure(x >> 1, y >> 1, z >> 1);
      // Moments are in cell edges about the cell centre: rescale and shift.
      addMoments(out.m, d * FIELDS, this.m, c * FIELDS, 0.5, (x & 1) ? 0.25 : -0.25, (y & 1) ? 0.25 : -0.25, (z & 1) ? 0.25 : -0.25, 1);
    }
    return out;
  }

  /** Fit every cell's plane. */
  fitAll(): void {
    const fit = new Float32Array(this.count * 4);
    const acc = new Float64Array(FIELDS);
    for (let c = 0; c < this.count; c++) {
      acc.fill(0);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 === 3) continue; // a corner cell adds little and costs a lookup
            const k = dx === 0 && dy === 0 && dz === 0 ? c : this.find(this.ix[c] + dx, this.iy[c] + dy, this.iz[c] + dz);
            if (k < 0) continue;
            addMoments(acc, 0, this.m, k * FIELDS, 1, dx, dy, dz, 1 / (1 << d2));
          }
        }
      }
      fitPlane(acc, fit, c * 4);
    }
    this.fit = fit;
    // The moments are spent; a fitted level keeps only its planes.
    this.m = new Float32Array(0);
  }
}

/** dst += w · (src scaled by `s` then shifted by (dx, dy, dz)). */
function addMoments(
  dst: Float32Array | Float64Array, d: number, src: Float32Array, o: number,
  s: number, dx: number, dy: number, dz: number, w: number,
): void {
  const n = src[o];
  const sx = src[o + 1] * s;
  const sy = src[o + 2] * s;
  const sz = src[o + 3] * s;
  const s2 = s * s;
  dst[d] += w * n;
  dst[d + 1] += w * (sx + n * dx);
  dst[d + 2] += w * (sy + n * dy);
  dst[d + 3] += w * (sz + n * dz);
  dst[d + 4] += w * (src[o + 4] * s2 + 2 * dx * sx + n * dx * dx);
  dst[d + 5] += w * (src[o + 5] * s2 + dx * sy + dy * sx + n * dx * dy);
  dst[d + 6] += w * (src[o + 6] * s2 + dx * sz + dz * sx + n * dx * dz);
  dst[d + 7] += w * (src[o + 7] * s2 + 2 * dy * sy + n * dy * dy);
  dst[d + 8] += w * (src[o + 8] * s2 + dy * sz + dz * sy + n * dy * dz);
  dst[d + 9] += w * (src[o + 9] * s2 + 2 * dz * sz + n * dz * dz);
}

/** Plane of one neighbourhood: weighted upward unit normal + weight into `out`. */
function fitPlane(a: Float64Array, out: Float32Array, o: number): void {
  const n = a[0]; // weighted: a face neighbour's points count a half, an edge's a quarter
  if (n < 4) return; // three points always fit a plane, so they prove nothing
  const mx = a[1] / n;
  const my = a[2] / n;
  const mz = a[3] / n;
  const xx = a[4] / n - mx * mx;
  const xy = a[5] / n - mx * my;
  const xz = a[6] / n - mx * mz;
  const yy = a[7] / n - my * my;
  const yz = a[8] / n - my * mz;
  const zz = a[9] / n - mz * mz;
  // Eigenvalues of a symmetric 3x3 (trigonometric form).
  const q = (xx + yy + zz) / 3;
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * (xy * xy + xz * xz + yz * yz);
  const p = Math.sqrt(p2 / 6);
  if (!(p > 1e-9)) return;
  const bxx = (xx - q) / p;
  const byy = (yy - q) / p;
  const bzz = (zz - q) / p;
  const bxy = xy / p;
  const bxz = xz / p;
  const byz = yz / p;
  const det = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  const l2 = q + 2 * p * Math.cos(phi);
  const l0 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const l1 = 3 * q - l0 - l2;
  if (!(l1 > l2 * LINE_RATIO)) return;
  const flat = 1 - smooth(FLAT_FULL, FLAT_NONE, Math.max(0, l0) / l1);
  if (flat <= 0) return;
  // Normal: the largest cross product of two rows of (C - l0 I).
  const r0x = xx - l0;
  const r1y = yy - l0;
  const r2z = zz - l0;
  let nx = xy * yz - xz * r1y;
  let ny = xz * xy - r0x * yz;
  let nz = r0x * r1y - xy * xy;
  let best = nx * nx + ny * ny + nz * nz;
  const bx = xy * r2z - xz * yz;
  const by = xz * xz - r0x * r2z;
  const bz = r0x * yz - xz * xy;
  const b2 = bx * bx + by * by + bz * bz;
  if (b2 > best) { nx = bx; ny = by; nz = bz; best = b2; }
  const cx = r1y * r2z - yz * yz;
  const cy = yz * xz - xy * r2z;
  const cz = xy * yz - r1y * xz;
  const c2 = cx * cx + cy * cy + cz * cz;
  if (c2 > best) { nx = cx; ny = cy; nz = cz; best = c2; }
  if (!(best > 0)) return;
  const k = (nz < 0 ? -1 : 1) / Math.sqrt(best);
  const up = nz * k;
  const w = flat * smooth(STEEP_NONE, STEEP_FULL, up) * Math.min(1, n / MIN_POINTS);
  out[o] = nx * k * w;
  out[o + 1] = ny * k * w;
  out[o + 2] = up * w;
  out[o + 3] = w;
}

/**
 * Accumulates chunks, then answers codes for chunks. Both passes may run in
 * any chunking; the order of points within the cloud does not matter.
 */
export class SurfaceNormals {
  private _grid: CellGrid;
  private readonly _levels: CellGrid[] = [];
  private readonly _maxCells: number;
  private readonly _e0: number;
  private readonly _n0: number;
  private readonly _u0: number;
  private readonly _p: SurfaceNormalsParams;

  constructor(params: SurfaceNormalsParams) {
    this._p = params;
    this._maxCells = Math.max(16, params.maxCells ?? MAX_CELLS);
    this._grid = new CellGrid(params.cellSize > 0 ? params.cellSize : 1);
    const { min } = params;
    this._e0 = min[0];
    // Y-up: north is -Z, so the low edge of north is unknown from `min`; cells
    // may take negative indices, which the grid accepts.
    this._n0 = params.frame.upAxis === 2 ? min[1] : -min[2];
    this._u0 = min[params.frame.upAxis];
  }

  /** The finest cell edge in use (the starting one, or wider if the cap was met). */
  get cellSize(): number { return this._grid.cell; }
  get cellCount(): number { return this._grid.count; }

  add(positions: Float32Array): void {
    const n = Math.floor(positions.length / 3);
    const { upAxis, verticalScale } = this._p.frame;
    const nOff = upAxis === 2 ? 1 : 2;
    const nSign = upAxis === 2 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const e = positions[j] - this._e0;
      const no = nSign * positions[j + nOff] - this._n0;
      const u = (positions[j + upAxis] - this._u0) * verticalScale;
      if (!Number.isFinite(e) || !Number.isFinite(no) || !Number.isFinite(u)) continue;
      const g = this._grid;
      const inv = 1 / g.cell;
      const ix = Math.floor(e * inv);
      const iy = Math.floor(no * inv);
      const iz = Math.floor(u * inv);
      const c = g.ensure(ix, iy, iz) * FIELDS;
      const x = e * inv - ix - 0.5;
      const y = no * inv - iy - 0.5;
      const z = u * inv - iz - 0.5;
      const m = g.m;
      m[c] += 1;
      m[c + 1] += x;
      m[c + 2] += y;
      m[c + 3] += z;
      m[c + 4] += x * x;
      m[c + 5] += x * y;
      m[c + 6] += x * z;
      m[c + 7] += y * y;
      m[c + 8] += y * z;
      m[c + 9] += z * z;
      while (this._grid.count > this._maxCells) this._grid = this._grid.coarser();
    }
  }

  /** Fit every level. Call once, after the last `add`. */
  fit(): void {
    let g = this._grid;
    for (let k = 0; k < LEVELS; k++) {
      const next = k < LEVELS - 1 ? g.coarser() : null;
      g.fitAll();
      this._levels.push(g);
      if (!next) break;
      g = next;
    }
  }

  /** The code of every point in `positions`. */
  encode(positions: Float32Array, out = new Uint16Array(Math.floor(positions.length / 3))): Uint16Array {
    const n = out.length;
    const { upAxis, verticalScale } = this._p.frame;
    const nOff = upAxis === 2 ? 1 : 2;
    const nSign = upAxis === 2 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const e = positions[j] - this._e0;
      const no = nSign * positions[j + nOff] - this._n0;
      const u = (positions[j + upAxis] - this._u0) * verticalScale;
      out[i] = LEVEL_CODE;
      if (!Number.isFinite(e) || !Number.isFinite(no) || !Number.isFinite(u)) continue;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      let left = 1; // the share of the answer no finer level has given
      for (const g of this._levels) {
        const fit = g.fit!;
        const fx = e / g.cell - 0.5;
        const fy = no / g.cell - 0.5;
        const fz = u / g.cell - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const z0 = Math.floor(fz);
        const tx = fx - x0;
        const ty = fy - y0;
        const tz = fz - z0;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sw = 0; // weight of usable planes
        let so = 0; // weight of occupied cells
        for (let k = 0; k < 8; k++) {
          const w = ((k & 1) ? tx : 1 - tx) * ((k & 2) ? ty : 1 - ty) * ((k & 4) ? tz : 1 - tz);
          if (w < 1e-4) continue;
          const c = g.find(x0 + (k & 1), y0 + ((k >> 1) & 1), z0 + (k >> 2));
          if (c < 0) continue;
          so += w;
          const o = c * 4;
          sx += w * fit[o];
          sy += w * fit[o + 1];
          sz += w * fit[o + 2];
          sw += w * fit[o + 3];
        }
        if (so <= 0 || sw <= 0) continue;
        const r = left / so;
        vx += sx * r;
        vy += sy * r;
        vz += sz * r;
        left *= 1 - sw / so;
        if (left < 0.02) break;
      }
      vz += left; // the unanswered share reads as level
      const len = Math.hypot(vx, vy, vz);
      if (len > 0) out[i] = packNormal(vx / len, vy / len);
    }
    return out;
  }
}

/** True when the extent is addressable at `cell` (indices stay 32-bit safe). */
function fitsAxis(extent: number, cell: number): boolean {
  return extent / cell < AXIS_LIMIT;
}

/**
 * The finest cell for a cloud, from its own spacing: the occupied surface area
 * of a strided sample over the point count. Counting occupied 3-D cells rather
 * than the bounding rectangle keeps a narrow corridor, a facade or an L-shaped
 * site from reading as sparser or denser than it is. `null` for a cloud with
 * no extent (fewer than three distinct points), which has no surface to shade.
 */
export function estimateCellSize(
  sample: Float32Array, pointCount: number, frame: SurfaceFrame,
): number | null {
  const n = Math.floor(sample.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const scale = [1, 1, 1];
  scale[frame.upAxis] = frame.verticalScale;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    if (!Number.isFinite(sample[j]) || !Number.isFinite(sample[j + 1]) || !Number.isFinite(sample[j + 2])) continue;
    used++;
    for (let a = 0; a < 3; a++) {
      const v = sample[j + a] * scale[a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (used < 3) return null;
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(extent > 0) || !Number.isFinite(extent)) return null;
  // Occupancy at a cell holding several sample points on average; a cell that
  // is too fine would count points instead of surface.
  let cell = extent / 256;
  let occupied = 0;
  for (let pass = 0; pass < 6; pass++) {
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const x = Math.floor((sample[j] * scale[0] - min[0]) / cell);
      const y = Math.floor((sample[j + 1] * scale[1] - min[1]) / cell);
      const z = Math.floor((sample[j + 2] * scale[2] - min[2]) / cell);
      if (x === x && y === y && z === z) seen.add((x * 1024 + y) * 1024 + z);
    }
    occupied = seen.size;
    if (used / occupied >= 6) break;
    cell *= 2;
  }
  const spacing = Math.sqrt((occupied * cell * cell) / Math.max(1, pointCount));
  let out = CELL_PER_SPACING * spacing;
  while (!fitsAxis(extent, out)) out *= 2;
  return out;
}
