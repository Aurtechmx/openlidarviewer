/**
 * boundingVolume.ts — 3D Tiles bounding volumes turned into usable geometry.
 *
 * `tileset.ts` parses the three volume forms and `tileTransform.ts` moves the
 * two Cartesian ones through a tile transform. What a culler actually needs is
 * one step further on: the corners of an oriented box, a conservative
 * axis-aligned bound for any of the three forms, and an honest "is the camera
 * inside this volume" test.
 *
 * The one subtle case is `region`. A region is a curved patch of the WGS84
 * ellipsoid, and the hull of its eight geographic corners does NOT contain it:
 * the surface bulges outward between the corners, so a corner-only AABB
 * under-bounds the volume and culls tiles that are on screen. See
 * `regionToAabb` for the method used instead.
 *
 * Pure: no fetch, no DOM, no renderer types. Float64 throughout.
 */

export interface Aabb {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137.0;
/** WGS84 inverse flattening. */
export const WGS84_INV_F = 298.257223563;
/** WGS84 flattening. */
export const WGS84_F = 1 / WGS84_INV_F;
/** WGS84 first eccentricity squared, e2 = f * (2 - f). */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** WGS84 semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);

const TWO_PI = Math.PI * 2;

/**
 * The eight corners of an oriented bounding box.
 *
 * The twelve numbers are centre(3) then three half-axis VECTORS, not three
 * half-extents: the axes may be rotated and need not be orthogonal. Corners are
 * therefore centre ± xHalf ± yHalf ± zHalf over all eight sign combinations,
 * and reading the twelve values as an axis-aligned min/max would silently drop
 * every rotation.
 */
export function boxCorners(box: readonly number[]): [number, number, number][] {
  const cx = box[0]!, cy = box[1]!, cz = box[2]!;
  const ax = box[3]!, ay = box[4]!, az = box[5]!;
  const bx = box[6]!, by = box[7]!, bz = box[8]!;
  const dx = box[9]!, dy = box[10]!, dz = box[11]!;

  const out: [number, number, number][] = [];
  for (const sa of [-1, 1]) {
    for (const sb of [-1, 1]) {
      for (const sd of [-1, 1]) {
        out.push([
          cx + sa * ax + sb * bx + sd * dx,
          cy + sa * ay + sb * by + sd * dy,
          cz + sa * az + sb * bz + sd * dz,
        ]);
      }
    }
  }
  return out;
}

/** Axis-aligned bounds of a point set. Throws on an empty set: there is no answer. */
export function aabbFromPoints(points: readonly (readonly number[])[]): Aabb {
  if (points.length === 0) throw new Error('aabbFromPoints: no points.');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      const v = p[i]!;
      if (v < min[i]!) min[i] = v;
      if (v > max[i]!) max[i] = v;
    }
  }
  return { min, max };
}

/** Axis-aligned bounds of an oriented box: its corners, then their extent. */
export function boxToAabb(box: readonly number[]): Aabb {
  return aabbFromPoints(boxCorners(box));
}

/** Axis-aligned bounds of `[cx, cy, cz, radius]`. */
export function sphereToAabb(sphere: readonly number[]): Aabb {
  const [cx, cy, cz, r] = [sphere[0]!, sphere[1]!, sphere[2]!, Math.abs(sphere[3]!)];
  return { min: [cx - r, cy - r, cz - r], max: [cx + r, cy + r, cz + r] };
}

/** Geodetic (radians, metres) to ECEF metres on the WGS84 ellipsoid. */
export function geodeticToEcef(lon: number, lat: number, h: number): [number, number, number] {
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + h) * cosLat * Math.cos(lon),
    (n + h) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + h) * sinLat,
  ];
}

export interface RegionAabbOptions {
  /**
   * Upper bound on the angular step between samples, radians. Smaller is
   * tighter and slower; the outward pad shrinks with the square of it.
   */
  readonly maxStep?: number;
  /** Hard cap on samples per axis, so a whole-globe region stays cheap. */
  readonly maxSamplesPerAxis?: number;
}

/** Half a degree. Fine enough that the pad below stays around a hundred metres. */
const DEFAULT_MAX_STEP = (0.5 * Math.PI) / 180;
const DEFAULT_MAX_SAMPLES_PER_AXIS = 512;

/**
 * A conservative ECEF axis-aligned bound for a `region` volume.
 *
 * `region` is `[west, south, east, north, minHeight, maxHeight]`, longitude and
 * latitude in radians on WGS84 / EPSG:4979, heights in metres. `west > east`
 * means the region crosses the antimeridian and is handled by unwrapping east
 * forward by 2*pi rather than by splitting the region in two.
 *
 * METHOD: dense grid sampling of the two bounding height surfaces, plus a
 * closed-form outward pad.
 *
 * Why not corners. Every ECEF coordinate of the surface is, along a line of
 * constant latitude, a sinusoid in longitude; along a meridian it is a smooth
 * curve in latitude. Both bulge away from the chord between their endpoints, so
 * the extreme of a coordinate generally falls in the INTERIOR of the patch, not
 * at a corner. A 90-degree-wide equatorial region is the blunt example: its
 * corners reach x = R*cos(45deg), while the region itself reaches x = R. A
 * corner-only AABB would be short by nearly a third of the Earth's radius.
 *
 * Why this is conservative. Only the two extreme heights are sampled because
 * every ECEF coordinate is monotone in h at fixed (lon, lat) — the h terms
 * enter as (N + h)*cos(lat)*cos(lon), (N + h)*cos(lat)*sin(lon) and
 * (N*(1-e2) + h)*sin(lat), each linear in h — so no interior height can exceed
 * both surfaces. Across one grid cell of angular width `step`, each coordinate
 * is a C2 function of the angle whose second derivative is bounded in magnitude
 * by the maximum geocentric radius R = a + max(0, maxHeight), so its excursion
 * beyond the values at the cell endpoints is at most R * step^2 / 8 per angular
 * axis. The returned bound is the sampled extent grown outward by twice that,
 * once for longitude and once for latitude, with a further factor of two of
 * headroom for the latitude dependence of the prime-vertical radius N. The
 * result is an over-bound, never an under-bound, which is the only direction
 * that is safe for culling.
 */
export function regionToAabb(region: readonly number[], opts: RegionAabbOptions = {}): Aabb {
  const west = region[0]!;
  const south = region[1]!;
  let east = region[2]!;
  const north = region[3]!;
  const minHeight = region[4]!;
  const maxHeight = region[5]!;

  // Antimeridian crossing: unwrap east forward so the span is positive.
  if (east < west) east += TWO_PI;

  const lonSpan = east - west;
  const latSpan = north - south;

  const maxStep = opts.maxStep ?? DEFAULT_MAX_STEP;
  const cap = opts.maxSamplesPerAxis ?? DEFAULT_MAX_SAMPLES_PER_AXIS;
  const divisions = (span: number): number =>
    Math.min(cap, Math.max(1, Math.ceil(Math.abs(span) / maxStep)));

  const nLon = divisions(lonSpan);
  const nLat = divisions(latSpan);

  const heights = minHeight === maxHeight ? [minHeight] : [minHeight, maxHeight];

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i <= nLon; i++) {
    const lon = west + (lonSpan * i) / nLon;
    for (let j = 0; j <= nLat; j++) {
      const lat = south + (latSpan * j) / nLat;
      for (const h of heights) {
        const p = geodeticToEcef(lon, lat, h);
        for (let k = 0; k < 3; k++) {
          if (p[k]! < min[k]!) min[k] = p[k]!;
          if (p[k]! > max[k]!) max[k] = p[k]!;
        }
      }
    }
  }

  const radius = WGS84_A + Math.max(0, maxHeight);
  const lonStep = Math.abs(lonSpan) / nLon;
  const latStep = Math.abs(latSpan) / nLat;
  // R * step^2 / 8 per axis, doubled for the N(lat) dependence.
  const pad = (radius * (lonStep * lonStep + latStep * latStep)) / 4;

  return {
    min: [min[0]! - pad, min[1]! - pad, min[2]! - pad],
    max: [max[0]! + pad, max[1]! + pad, max[2]! + pad],
  };
}

/**
 * Whether a point lies inside an oriented box.
 *
 * Projection onto each half-axis, not an AABB test: for a rotated box the AABB
 * is strictly larger, so an AABB test reports "inside" for points that are
 * outside the box. Degenerate (zero-length) half-axes are treated as flat, so a
 * point must lie exactly on that axis's plane.
 */
export function pointInBox(box: readonly number[], p: readonly number[], epsilon = 0): boolean {
  const d = [p[0]! - box[0]!, p[1]! - box[1]!, p[2]! - box[2]!];
  for (let axis = 0; axis < 3; axis++) {
    const o = 3 + axis * 3;
    const ax = box[o]!, ay = box[o + 1]!, az = box[o + 2]!;
    const lenSq = ax * ax + ay * ay + az * az;
    const dot = d[0]! * ax + d[1]! * ay + d[2]! * az;
    if (lenSq === 0) {
      if (Math.abs(dot) > epsilon) return false;
      continue;
    }
    // |dot| / |axis| is the distance along the axis; compare against |axis|.
    if (Math.abs(dot) > lenSq + epsilon * Math.sqrt(lenSq)) return false;
  }
  return true;
}

/** Whether a point lies inside `[cx, cy, cz, radius]`. */
export function pointInSphere(
  sphere: readonly number[],
  p: readonly number[],
  epsilon = 0,
): boolean {
  const dx = p[0]! - sphere[0]!;
  const dy = p[1]! - sphere[1]!;
  const dz = p[2]! - sphere[2]!;
  const r = Math.abs(sphere[3]!) + epsilon;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * ECEF to geodetic (lon, lat in radians, h in metres) by Bowring's method.
 *
 * Closed form and accurate to well under a millimetre for heights anywhere near
 * the ellipsoid, which is the regime a 3D Tiles region lives in.
 */
export function ecefToGeodetic(p: readonly number[]): [number, number, number] {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  const lon = Math.atan2(y, x);
  const r = Math.hypot(x, y);
  if (r === 0) {
    // On the spin axis: latitude is a pole and longitude is arbitrary.
    const sign = z >= 0 ? 1 : -1;
    return [lon, (sign * Math.PI) / 2, Math.abs(z) - WGS84_B];
  }
  const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  const theta = Math.atan2(z * WGS84_A, r * WGS84_B);
  const lat = Math.atan2(
    z + ep2 * WGS84_B * Math.sin(theta) ** 3,
    r - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3,
  );
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = r / Math.cos(lat) - n;
  return [lon, lat, h];
}

/**
 * Whether an ECEF point lies inside a `region` volume.
 *
 * Longitude is compared as an offset forward from `west`, so an antimeridian
 * crossing needs no special case beyond the unwrap.
 */
export function pointInRegion(
  region: readonly number[],
  p: readonly number[],
  epsilon = 0,
): boolean {
  const west = region[0]!;
  const south = region[1]!;
  let east = region[2]!;
  const north = region[3]!;
  const minHeight = region[4]!;
  const maxHeight = region[5]!;
  if (east < west) east += TWO_PI;

  const [lon, lat, h] = ecefToGeodetic(p);
  if (h < minHeight - epsilon || h > maxHeight + epsilon) return false;
  if (lat < south - epsilon || lat > north + epsilon) return false;

  const span = east - west;
  if (span >= TWO_PI) return true;
  let offset = (lon - west) % TWO_PI;
  if (offset < 0) offset += TWO_PI;
  // A point just west of `west` wraps to nearly 2*pi; fold it back so the
  // epsilon tolerance still applies at that edge.
  if (offset > span && offset >= TWO_PI - epsilon) offset -= TWO_PI;
  return offset >= -epsilon && offset <= span + epsilon;
}
