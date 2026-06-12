/**
 * objectMetrics.ts
 *
 * Measurements that make sense for a scanned OBJECT (a phone scan of a chair,
 * a sculpture, a room) rather than a terrain height field:
 *
 *   - oriented bounding box (L × W × H) from PCA — the object's true extent
 *     regardless of how it sits in the scan frame, plus the axis-aligned box
 *     for reference;
 *   - envelope volume (the OBB volume) — an honest bound, NOT a solid volume
 *     (a point cloud has no watertight interior; that needs a mesh);
 *   - median nearest-neighbour spacing — the scan's effective resolution;
 *   - angular completeness — the fraction of viewing directions around the
 *     object's centroid that actually have returns, i.e. how much of the
 *     surface was captured vs occluded / missed;
 *   - longest dimension — max(L, W, H) of the OBB, the "how big is it"
 *     headline figure capture apps lead with;
 *   - bounding-box surface area — 2(LW + LH + WH) of the OBB, an APPROXIMATE
 *     bound (the envelope's skin), NOT the object's true mesh surface, which is
 *     not well defined on a raw point cloud and is not fabricated here.
 *
 * Pure data, deterministic, O(sampled). The volume and surface area reported
 * are envelope (bounding-box) figures, never solid / watertight measurements.
 */

export interface BoxDims {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

export interface ObjectMetrics {
  readonly pointCount: number;
  /** Oriented (PCA) bounding box, sides sorted long→short. */
  readonly obb: BoxDims;
  /** Axis-aligned bounding box, sides sorted long→short. */
  readonly aabb: BoxDims;
  /** max(L, W, H) of the OBB — the headline "how big is it" dimension. */
  readonly longestDimensionM: number;
  /** OBB volume — an envelope bound, not a solid volume. */
  readonly envelopeVolumeM3: number;
  /** OBB surface area 2(LW+LH+WH) — a bounding-box approximation, not the mesh skin. */
  readonly surfaceAreaM2: number;
  /** Median nearest-neighbour distance (scan resolution). */
  readonly medianSpacingM: number;
  /** 0..100 — share of viewing directions around the centroid with returns. */
  readonly completenessPct: number;
}

export interface ObjectMetricsParams {
  /** Max points sampled for bounds / PCA. Default 60000. */
  readonly maxSamples?: number;
  /** Points sampled for the O(n²) spacing/completeness passes. Default 2000. */
  readonly probeSamples?: number;
  /**
   * Honest source/resident point count when `positions` is itself already a
   * strided gather of a larger scan. Feeds the spacing correction below so the
   * reported resolution describes the SCAN, not the gather. Defaults to the
   * point count of `positions`.
   */
  readonly sourcePointCount?: number;
}

/** Jacobi eigen-decomposition of a symmetric 3×3 — returns column eigenvectors. */
function jacobiEigen3(a: number[][]): number[][] {
  const m = a.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 64; iter++) {
    let p = 0, q = 1, max = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > max) { max = Math.abs(m[0][2]); p = 0; q = 2; }
    if (Math.abs(m[1][2]) > max) { max = Math.abs(m[1][2]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const phi = 0.5 * Math.atan2(2 * m[p][q], m[q][q] - m[p][p]);
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const mkp = m[k][p], mkq = m[k][q];
      m[k][p] = c * mkp - s * mkq;
      m[k][q] = s * mkp + c * mkq;
    }
    for (let k = 0; k < 3; k++) {
      const mpk = m[p][k], mqk = m[q][k];
      m[p][k] = c * mpk - s * mqk;
      m[q][k] = s * mpk + c * mqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  // Columns of v are the eigenvectors.
  return [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]],
  ];
}

const sortedBox = (a: number, b: number, c: number): BoxDims => {
  const s = [a, b, c].sort((x, y) => y - x);
  return { lengthM: s[0], widthM: s[1], heightM: s[2] };
};

export function objectMetrics(
  positions: Float32Array | ReadonlyArray<number>,
  params: ObjectMetricsParams = {},
): ObjectMetrics {
  const n = Math.floor(positions.length / 3);
  const empty: ObjectMetrics = {
    pointCount: n,
    obb: { lengthM: 0, widthM: 0, heightM: 0 },
    aabb: { lengthM: 0, widthM: 0, heightM: 0 },
    longestDimensionM: 0,
    envelopeVolumeM3: 0,
    surfaceAreaM2: 0,
    medianSpacingM: 0,
    completenessPct: 0,
  };
  if (n < 4) return empty;

  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 60000));
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  let cx = 0, cy = 0, cz = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const x = positions[b], y = positions[b + 1], z = positions[b + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    sx.push(x); sy.push(y); sz.push(z);
    cx += x; cy += y; cz += z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const m = sx.length;
  if (m < 4) return empty;
  cx /= m; cy /= m; cz /= m;

  // ── PCA covariance → principal axes → OBB extents ──
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < m; i++) {
    const dx = sx[i] - cx, dy = sy[i] - cy, dz = sz[i] - cz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz;
    xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  const cov = [
    [xx / m, xy / m, xz / m],
    [xy / m, yy / m, yz / m],
    [xz / m, yz / m, zz / m],
  ];
  const axes = jacobiEigen3(cov);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m; i++) {
    const dx = sx[i] - cx, dy = sy[i] - cy, dz = sz[i] - cz;
    for (let a = 0; a < 3; a++) {
      const proj = dx * axes[a][0] + dy * axes[a][1] + dz * axes[a][2];
      if (proj < lo[a]) lo[a] = proj;
      if (proj > hi[a]) hi[a] = proj;
    }
  }
  const obb = sortedBox(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const aabb = sortedBox(maxX - minX, maxY - minY, maxZ - minZ);

  // ── median nearest-neighbour spacing (probe subsample, brute force) ──
  const probeN = Math.min(m, Math.max(50, Math.floor(params.probeSamples ?? 2000)));
  const pStride = Math.max(1, Math.floor(m / probeN));
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  for (let i = 0; i < m; i += pStride) { px.push(sx[i]); py.push(sy[i]); pz.push(sz[i]); }
  const P = px.length;
  const nnDist: number[] = [];
  for (let i = 0; i < P; i++) {
    let best = Infinity;
    for (let j = 0; j < P; j++) {
      if (j === i) continue;
      const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    if (Number.isFinite(best)) nnDist.push(Math.sqrt(best));
  }
  nnDist.sort((a, b) => a - b);
  const probeSpacingM = nnDist.length ? nnDist[Math.floor(nnDist.length / 2)] : 0;
  // The probe measures the spacing of P points; the SCAN has N (≥ P) points
  // over the same surface. For uniform sampling of a 2-D manifold (what a
  // scanned surface is) spacing scales as 1/√density, so the scan's spacing is
  // the probe's × √(P/N). Without this the figure was inflated ~√(N/P) — e.g.
  // ~5.5× on a 60 k gather probed at 2 000 (the v0.4.3 audit finding). N is
  // the caller-supplied source count when the gather is itself a stride.
  const fullCount = Math.max(
    n,
    Number.isFinite(params.sourcePointCount) && (params.sourcePointCount as number) > 0
      ? Math.floor(params.sourcePointCount as number)
      : 0,
  );
  const medianSpacingM =
    P > 0 && fullCount > P ? probeSpacingM * Math.sqrt(P / fullCount) : probeSpacingM;

  // ── angular completeness — share of direction bins (from centroid) hit ──
  const LON = 24, LAT = 12;
  const bins = new Uint8Array(LON * LAT);
  for (let i = 0; i < m; i++) {
    const dx = sx[i] - cx, dy = sy[i] - cy, dz = sz[i] - cz;
    const r = Math.hypot(dx, dy, dz);
    if (r < 1e-9) continue;
    const lon = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI); // 0..1
    const lat = Math.acos(Math.max(-1, Math.min(1, dz / r))) / Math.PI; // 0..1
    let lo2 = Math.floor(lon * LON); if (lo2 >= LON) lo2 = LON - 1;
    let la2 = Math.floor(lat * LAT); if (la2 >= LAT) la2 = LAT - 1;
    bins[la2 * LON + lo2] = 1;
  }
  let hit = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i]) hit++;
  const completenessPct = (100 * hit) / (LON * LAT);

  const { lengthM: L, widthM: W, heightM: H } = obb;
  return {
    pointCount: n,
    obb,
    aabb,
    longestDimensionM: Math.max(L, W, H),
    envelopeVolumeM3: L * W * H,
    surfaceAreaM2: 2 * (L * W + L * H + W * H),
    medianSpacingM,
    completenessPct,
  };
}
