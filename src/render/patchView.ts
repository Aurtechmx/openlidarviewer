/**
 * patchView.ts
 *
 * "Photometric witness" — a pure-data reconstruction of what the scanner
 * captured at and immediately around a single point. Given a clicked
 * point index, the cloud's positions, and the cloud's stored sRGB
 * Uint8 colours, builds a small RGBA8 thumbnail by:
 *
 *   1. Finding the K nearest neighbours in world space (linear-scan KNN —
 *      no spatial index dependency, so the module ships as a leaf).
 *   2. Computing the tangent plane at the centre point via PCA on the
 *      neighbour offsets. The eigenvector with the smallest variance is
 *      the surface normal; the other two span the patch plane.
 *   3. Projecting each neighbour onto the (u, v) basis and rasterising
 *      it as a soft disk into a size × size RGBA8 buffer.
 *
 * The result is the analyst's photometric witness: every pixel comes
 * from a real captured colour, sRGB-decoded once and rendered without
 * tone mapping or HDR compression. Pairs with `colorProvenance.ts` —
 * the patch shows what the scanner saw, the provenance card shows the
 * underlying numerical values.
 *
 * Pure data — no DOM, no three.js, unit-tested in Node — so the module
 * ships through the same module-graph seam every Stream A leaf uses.
 */

/** A 3D vector — `[x, y, z]`. */
export type Vec3 = readonly [number, number, number];

/** Result of `buildPatchView`: the RGBA8 buffer + metadata for the inspector. */
export interface PatchView {
  /** Width / height in pixels. */
  readonly size: number;
  /** Interleaved RGBA8 pixel buffer (length `size * size * 4`). */
  readonly rgba: Uint8ClampedArray;
  /** How many points contributed to the patch (≤ k + 1, includes centre). */
  readonly hits: number;
  /** Patch coverage in [0, 1] — fraction of pixels touched by any splat. */
  readonly coverage: number;
  /** Tangent-plane normal in world space — for downstream display. */
  readonly normal: Vec3;
  /** Half-extent of the (u, v) plane mapped onto the patch, m. */
  readonly extent: number;
  /** Centre-point world position. */
  readonly centre: Vec3;
}

/** Inputs to `buildPatchView`. */
export interface PatchViewInput {
  /** Index of the centre point (0..N-1). */
  pointIndex: number;
  /** Interleaved xyz positions, length 3·N. */
  positions: Float32Array;
  /** Interleaved sRGB Uint8 colours, length 3·N (matches `positions` order). */
  colorsU8: Uint8Array;
  /** Neighbours to gather (default 64). Capped to [1, 1024]. */
  k?: number;
  /** Patch size in pixels (default 48). Capped to [16, 256]. */
  size?: number;
  /**
   * Splat radius in pixels (default 1.5). Smaller = sharper but more
   * holes; larger = smoother but blurrier. The optimum scales with
   * point density relative to `extent` — the function picks a default
   * if `splatRadius` is omitted.
   */
  splatRadius?: number;
  /**
   * Half-extent of the patch in metres (default `auto` — chosen from
   * the 90th percentile of neighbour distances so the patch fills
   * itself but does not waste pixels on empty edges).
   */
  extent?: number | 'auto';
}

const MIN_K = 1;
const MAX_K = 1024;
const MIN_SIZE = 16;
const MAX_SIZE = 256;
const DEFAULT_K = 64;
const DEFAULT_SIZE = 48;
const DEFAULT_SPLAT_RADIUS = 1.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len < 1e-12 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Piecewise sRGB → linear (IEC 61966-2-1). Matches three.js's
 * `Color.SRGBToLinear` and the loader's `toFloatColors`. Kept inline so
 * the module stays a pure leaf — no cross-module dependency.
 */
function srgb8ToLinearFloat(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * Find the K nearest neighbours of `centre` in `positions` (excluding
 * the centre itself). Returns the indices ordered by ascending distance.
 *
 * Implementation note: a linear scan with a max-heap of size k. O(N log k)
 * worst case, which is more than fast enough at the < 5 M points the
 * inspector ever touches in one shot (the renderer holds the full cloud
 * but the inspector only samples the resident set).
 */
function knn(
  centre: Vec3,
  positions: Float32Array,
  selfIndex: number,
  k: number,
): { indices: number[]; distances: number[] } {
  const n = positions.length / 3;
  // Use parallel typed arrays so the inner loop stays branchless on the
  // common path.
  const heapIdx = new Int32Array(k);
  const heapDistSq = new Float32Array(k);
  let heapSize = 0;

  function heapifyUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapDistSq[parent] < heapDistSq[i]) {
        const tmpD = heapDistSq[parent];
        heapDistSq[parent] = heapDistSq[i];
        heapDistSq[i] = tmpD;
        const tmpI = heapIdx[parent];
        heapIdx[parent] = heapIdx[i];
        heapIdx[i] = tmpI;
        i = parent;
      } else break;
    }
  }

  function heapifyDown(i: number): void {
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let largest = i;
      if (left < heapSize && heapDistSq[left] > heapDistSq[largest]) largest = left;
      if (right < heapSize && heapDistSq[right] > heapDistSq[largest]) largest = right;
      if (largest === i) break;
      const tmpD = heapDistSq[i];
      heapDistSq[i] = heapDistSq[largest];
      heapDistSq[largest] = tmpD;
      const tmpI = heapIdx[i];
      heapIdx[i] = heapIdx[largest];
      heapIdx[largest] = tmpI;
      i = largest;
    }
  }

  for (let i = 0; i < n; i++) {
    if (i === selfIndex) continue;
    const dx = positions[i * 3] - centre[0];
    const dy = positions[i * 3 + 1] - centre[1];
    const dz = positions[i * 3 + 2] - centre[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (heapSize < k) {
      heapIdx[heapSize] = i;
      heapDistSq[heapSize] = d2;
      heapSize++;
      heapifyUp(heapSize - 1);
    } else if (d2 < heapDistSq[0]) {
      heapIdx[0] = i;
      heapDistSq[0] = d2;
      heapifyDown(0);
    }
  }

  // Drain the heap into ascending-distance order.
  const indices: number[] = new Array(heapSize);
  const distances: number[] = new Array(heapSize);
  for (let pos = heapSize - 1; pos >= 0; pos--) {
    indices[pos] = heapIdx[0];
    distances[pos] = Math.sqrt(heapDistSq[0]);
    heapDistSq[0] = heapDistSq[pos];
    heapIdx[0] = heapIdx[pos];
    heapSize--;
    heapifyDown(0);
  }
  return { indices, distances };
}

/**
 * Tangent-plane basis at the centre point — `(u, v)` span the plane and
 * `n` is the normal. Computed by PCA on the centred neighbour offsets:
 * the eigenvector with smallest variance is the normal, the other two
 * span the plane.
 *
 * Implementation uses the power-iteration trick on the 3 × 3 covariance
 * matrix: deflate the largest eigenvector to find the second, cross them
 * for the third. Avoids a dense eigen-solver and stays branch-light.
 */
function tangentBasis(
  centre: Vec3,
  positions: Float32Array,
  neighbourIndices: readonly number[],
): { u: Vec3; v: Vec3; n: Vec3 } {
  const n = neighbourIndices.length;
  if (n < 3) {
    // Underdetermined — fall back to world axes, with +Z as normal.
    return { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
  }
  // Covariance matrix C[3][3]. Symmetric, so we only need the upper half.
  let cxx = 0;
  let cxy = 0;
  let cxz = 0;
  let cyy = 0;
  let cyz = 0;
  let czz = 0;
  for (let i = 0; i < n; i++) {
    const idx = neighbourIndices[i];
    const dx = positions[idx * 3] - centre[0];
    const dy = positions[idx * 3 + 1] - centre[1];
    const dz = positions[idx * 3 + 2] - centre[2];
    cxx += dx * dx;
    cxy += dx * dy;
    cxz += dx * dz;
    cyy += dy * dy;
    cyz += dy * dz;
    czz += dz * dz;
  }
  const inv = 1 / n;
  cxx *= inv;
  cxy *= inv;
  cxz *= inv;
  cyy *= inv;
  cyz *= inv;
  czz *= inv;

  // Power iteration for the largest eigenvector.
  function mul(v: Vec3): Vec3 {
    return [
      cxx * v[0] + cxy * v[1] + cxz * v[2],
      cxy * v[0] + cyy * v[1] + cyz * v[2],
      cxz * v[0] + cyz * v[1] + czz * v[2],
    ];
  }

  let v1: Vec3 = normalize([1, 1, 1]);
  for (let i = 0; i < 20; i++) {
    v1 = normalize(mul(v1));
  }

  // Deflate: build C' = C − λ₁ v₁ v₁ᵀ, then iterate for the second.
  const lambda1 = dot(mul(v1), v1);
  const dxx = cxx - lambda1 * v1[0] * v1[0];
  const dxy = cxy - lambda1 * v1[0] * v1[1];
  const dxz = cxz - lambda1 * v1[0] * v1[2];
  const dyy = cyy - lambda1 * v1[1] * v1[1];
  const dyz = cyz - lambda1 * v1[1] * v1[2];
  const dzz = czz - lambda1 * v1[2] * v1[2];

  function mul2(v: Vec3): Vec3 {
    return [
      dxx * v[0] + dxy * v[1] + dxz * v[2],
      dxy * v[0] + dyy * v[1] + dyz * v[2],
      dxz * v[0] + dyz * v[1] + dzz * v[2],
    ];
  }

  // Start from a direction perpendicular to v1 so we don't trivially
  // converge back to it.
  let seed: Vec3 = Math.abs(v1[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  // Project seed perpendicular to v1.
  const proj = dot(seed, v1);
  seed = normalize([seed[0] - proj * v1[0], seed[1] - proj * v1[1], seed[2] - proj * v1[2]]);
  let v2: Vec3 = seed;
  for (let i = 0; i < 20; i++) {
    v2 = normalize(mul2(v2));
  }

  // Third axis from the cross product. The smallest-variance axis is the
  // normal.
  const v3 = normalize(cross(v1, v2));

  // Variance along each axis tells us which is the normal.
  const var1 = dot(mul(v1), v1);
  const var2 = dot(mul(v2), v2);
  const var3 = dot(mul(v3), v3);
  if (var1 <= var2 && var1 <= var3) return { u: v2, v: v3, n: v1 };
  if (var2 <= var1 && var2 <= var3) return { u: v1, v: v3, n: v2 };
  return { u: v1, v: v2, n: v3 };
}

/**
 * Build a small RGBA8 photometric witness of the point's surroundings.
 *
 * Returns a populated `PatchView` even when only a handful of neighbours
 * are reachable — `coverage` lets the inspector show a low-confidence
 * badge on sparse regions.
 */
export function buildPatchView(input: PatchViewInput): PatchView | null {
  const totalPoints = input.positions.length / 3;
  if (totalPoints === 0) return null;
  if (input.pointIndex < 0 || input.pointIndex >= totalPoints) return null;

  const size = clamp(input.size ?? DEFAULT_SIZE, MIN_SIZE, MAX_SIZE);
  const k = clamp(input.k ?? DEFAULT_K, MIN_K, MAX_K);
  const splatRadius = Math.max(0.25, input.splatRadius ?? DEFAULT_SPLAT_RADIUS);

  const centre: Vec3 = [
    input.positions[input.pointIndex * 3],
    input.positions[input.pointIndex * 3 + 1],
    input.positions[input.pointIndex * 3 + 2],
  ];

  // KNN + tangent plane.
  const { indices: neighbours, distances } = knn(
    centre,
    input.positions,
    input.pointIndex,
    k,
  );
  const { u, v, n } = tangentBasis(centre, input.positions, neighbours);

  // Choose `extent` from the 90th-percentile neighbour distance — keeps
  // the patch full of data without a long-tail neighbour wasting frame.
  let extent: number;
  if (input.extent === undefined || input.extent === 'auto') {
    if (distances.length === 0) extent = 1;
    else {
      const sorted = distances.slice().sort((a, b) => a - b);
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      extent = p90 > 0 ? p90 : 1;
    }
  } else {
    extent = Math.max(1e-6, input.extent);
  }

  // RGBA8 buffer + accumulated weight per pixel (for soft-splat compositing).
  const rgba = new Uint8ClampedArray(size * size * 4);
  // Float weight + linear-RGB accumulators so multiple splats blend
  // additively and we sRGB-encode at the end.
  const rAccum = new Float32Array(size * size);
  const gAccum = new Float32Array(size * size);
  const bAccum = new Float32Array(size * size);
  const wAccum = new Float32Array(size * size);

  // Splat a single (u, v) sample into the accumulators with a soft
  // disk falloff so neighbour contributions blend smoothly.
  function splat(uPos: number, vPos: number, rL: number, gL: number, bL: number): void {
    // Convert (u, v) ∈ [-extent, +extent] to pixel coords in [0, size).
    const px = ((uPos / extent) * 0.5 + 0.5) * size;
    const py = ((vPos / extent) * 0.5 + 0.5) * size;
    if (px < -splatRadius || px > size + splatRadius) return;
    if (py < -splatRadius || py > size + splatRadius) return;
    const xMin = Math.max(0, Math.floor(px - splatRadius));
    const xMax = Math.min(size - 1, Math.ceil(px + splatRadius));
    const yMin = Math.max(0, Math.floor(py - splatRadius));
    const yMax = Math.min(size - 1, Math.ceil(py + splatRadius));
    const r2 = splatRadius * splatRadius;
    for (let yi = yMin; yi <= yMax; yi++) {
      for (let xi = xMin; xi <= xMax; xi++) {
        const dx = xi - px;
        const dy = yi - py;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        // Smooth quadratic falloff: w = (1 - d²/r²)²
        const t = 1 - d2 / r2;
        const w = t * t;
        const i = yi * size + xi;
        rAccum[i] += rL * w;
        gAccum[i] += gL * w;
        bAccum[i] += bL * w;
        wAccum[i] += w;
      }
    }
  }

  // Splat the centre first so it always wins on a tie.
  const centreR = srgb8ToLinearFloat(input.colorsU8[input.pointIndex * 3]);
  const centreG = srgb8ToLinearFloat(input.colorsU8[input.pointIndex * 3 + 1]);
  const centreB = srgb8ToLinearFloat(input.colorsU8[input.pointIndex * 3 + 2]);
  splat(0, 0, centreR, centreG, centreB);

  let hits = 1;
  for (const idx of neighbours) {
    const dx = input.positions[idx * 3] - centre[0];
    const dy = input.positions[idx * 3 + 1] - centre[1];
    const dz = input.positions[idx * 3 + 2] - centre[2];
    const offset: Vec3 = [dx, dy, dz];
    const uPos = dot(offset, u);
    const vPos = dot(offset, v);
    if (Math.abs(uPos) > extent || Math.abs(vPos) > extent) continue;
    const rL = srgb8ToLinearFloat(input.colorsU8[idx * 3]);
    const gL = srgb8ToLinearFloat(input.colorsU8[idx * 3 + 1]);
    const bL = srgb8ToLinearFloat(input.colorsU8[idx * 3 + 2]);
    splat(uPos, vPos, rL, gL, bL);
    hits++;
  }

  // Resolve accumulators → RGBA8 with linear → sRGB at the final step.
  let covered = 0;
  for (let i = 0; i < size * size; i++) {
    const w = wAccum[i];
    if (w > 1e-6) {
      const r = rAccum[i] / w;
      const g = gAccum[i] / w;
      const b = bAccum[i] / w;
      rgba[i * 4] = linearFloatToSrgb8(r);
      rgba[i * 4 + 1] = linearFloatToSrgb8(g);
      rgba[i * 4 + 2] = linearFloatToSrgb8(b);
      rgba[i * 4 + 3] = 255;
      covered++;
    } else {
      // Transparent so the inspector card can draw a checker / dim grid.
      rgba[i * 4] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
    }
  }

  return {
    size,
    rgba,
    hits,
    coverage: covered / (size * size),
    normal: n,
    extent,
    centre,
  };
}

/** Linear [0, 1] → sRGB-encoded Uint8 [0, 255]. Inverse of `srgb8ToLinearFloat`. */
function linearFloatToSrgb8(v: number): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}
