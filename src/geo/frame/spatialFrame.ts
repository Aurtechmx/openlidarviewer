/**
 * spatialFrame.ts
 *
 * The conversion between the coordinates a source carries and the coordinates
 * the renderer draws.
 *
 * Every streaming source today recentres its points on one `renderOrigin` and
 * consumers recover a source coordinate by adding it back. That is exact for a
 * LAS-derived cloud in a projected CRS, where local visual up is the source's
 * own +Z and no rotation is involved. It is not sufficient for a source in a
 * geocentric frame: on a globe, +Z is the polar axis, not up, and a scene drawn
 * without rotating into a tangent frame is lying about which way is down.
 *
 * A frame is therefore a rotation and a translation, not an offset. Two
 * implementations cover what OLV reads:
 *
 *   translated-cartesian  render = source − renderOrigin
 *   local-enu             render = R · (source − anchor), R an ECEF-to-ENU basis
 *
 * The translated frame is a distinct implementation rather than the general one
 * with an identity rotation, so the arithmetic every existing consumer performs
 * is unchanged rather than merely equal to within rounding.
 *
 * WHAT THIS MODULE WILL NOT DO. It will not decide that a source is geocentric.
 * A tileset whose coordinates sit near the Earth's radius may be in EPSG:4978,
 * or it may be a local Cartesian model that happens to be large, and nothing in
 * the numbers separates the two. The frame is built from a declaration made
 * elsewhere; guessing it here would put a false CRS into every report that
 * reads the frame back.
 *
 * All arithmetic is Float64. Narrowing to Float32 belongs after the recentring
 * and the rotation, at the GPU buffer, and nowhere before it: a metre-scale
 * residual survives Float32 to well under a millimetre, and an ECEF coordinate
 * does not survive it at all.
 *
 * Pure — no DOM, no three.js, no proj4, no I/O.
 */

/** A point or vector in a Cartesian frame, Float64. */
export type Vec3 = readonly [number, number, number];

/** A freshly allocated triple, so a caller can never alias a frame's state. */
export type Vec3Out = [number, number, number];

/** Which conversion a frame performs. */
export type SpatialFrameKind = 'translated-cartesian' | 'local-enu';

/**
 * The conversion between source and render coordinates.
 *
 * Points carry the translation; vectors do not. A displacement, a normal or a
 * bounding-box half-extent must go through the vector methods, or it picks up
 * the anchor and lands somewhere near the centre of the Earth.
 */
export interface SpatialFrame {
  readonly kind: SpatialFrameKind;
  /**
   * The source coordinate that maps to render zero.
   *
   * For a translated frame this is the offset every consumer already adds back,
   * which is why the field keeps that name. For an ENU frame it is the tangent
   * point, and adding it to a render coordinate does NOT recover the source:
   * use {@link renderToSourcePoint}.
   */
  readonly renderOrigin: Vec3;

  sourceToRenderPoint(p: Vec3): Vec3Out;
  renderToSourcePoint(p: Vec3): Vec3Out;
  sourceVectorToRender(v: Vec3): Vec3Out;
  renderVectorToSource(v: Vec3): Vec3Out;

  /** Up in render space, unit length. */
  renderWorldUp(): Vec3Out;

  /**
   * True when a source coordinate is `render + renderOrigin`.
   *
   * A consumer that still performs that addition directly can ask, and refuse
   * rather than produce a coordinate that is wrong by the radius of the Earth.
   */
  readonly isTranslationOnly: boolean;
}

// ── Translated Cartesian ─────────────────────────────────────────────────────

/**
 * A frame that only recentres: `render = source − renderOrigin`.
 *
 * `up` is the source's own up axis in source coordinates, and because the frame
 * does not rotate it is also up in render space. LAS-derived sources are Z-up;
 * a Y-up model format passes `[0, 1, 0]`.
 */
export function createTranslatedFrame(
  renderOrigin: Vec3,
  up: Vec3 = [0, 0, 1],
): SpatialFrame {
  const o0 = renderOrigin[0], o1 = renderOrigin[1], o2 = renderOrigin[2];
  const u = normalize(up);
  return {
    kind: 'translated-cartesian',
    renderOrigin: [o0, o1, o2],
    isTranslationOnly: true,
    sourceToRenderPoint: (p) => [p[0] - o0, p[1] - o1, p[2] - o2],
    renderToSourcePoint: (p) => [p[0] + o0, p[1] + o1, p[2] + o2],
    sourceVectorToRender: (v) => [v[0], v[1], v[2]],
    renderVectorToSource: (v) => [v[0], v[1], v[2]],
    renderWorldUp: () => [u[0], u[1], u[2]],
  };
}

// ── Local ENU about an ECEF anchor ───────────────────────────────────────────

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137.0;
/** WGS84 inverse flattening. */
export const WGS84_INV_F = 298.257223563;

/**
 * Geodetic latitude and longitude of an ECEF position, in radians.
 *
 * Bowring's closed form. Height is not returned because the ENU basis does not
 * need it: the rotation is fixed by the surface normal direction alone.
 *
 * Exported for its own test. A latitude that is wrong by a degree still yields
 * an orthonormal rotation, so every round-trip assertion would pass while the
 * scene sat visibly tilted.
 */
export function ecefToGeodeticAngles(p: Vec3): { lat: number; lon: number } {
  const a = WGS84_A;
  const f = 1 / WGS84_INV_F;
  const b = a * (1 - f);
  const e2 = f * (2 - f);
  const ep2 = (a * a - b * b) / (b * b);
  const [x, y, z] = p;
  const r = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  // On the polar axis the parametric latitude is ±90° and `r` is zero, which
  // atan2 resolves without a divide.
  const theta = Math.atan2(z * a, r * b);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const lat = Math.atan2(z + ep2 * b * st * st * st, r - e2 * a * ct * ct * ct);
  return { lat, lon };
}

/**
 * A local east-north-up frame tangent to the ellipsoid beneath `anchor`.
 *
 * Render X is east, Y is north, Z is up, so render world-up is `[0, 0, 1]` and
 * the rest of the viewer needs no globe-specific case.
 *
 * The anchor is subtracted before the rotation, in Float64, so the multiply
 * only ever sees a residual: a value of a few kilometres rather than the six
 * thousand kilometres an ECEF coordinate carries. Rotating first and
 * subtracting after would lose roughly the low six digits of every coordinate.
 */
export function createLocalEnuFrame(anchor: Vec3): SpatialFrame {
  const { lat, lon } = ecefToGeodeticAngles(anchor);
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);

  // Rows of R: east, north, up, each a unit vector in ECEF.
  const ex = -sLon,        ey = cLon,         ez = 0;
  const nx = -sLat * cLon, ny = -sLat * sLon, nz = cLat;
  const ux = cLat * cLon,  uy = cLat * sLon,  uz = sLat;

  const a0 = anchor[0], a1 = anchor[1], a2 = anchor[2];

  const rotate = (x: number, y: number, z: number): Vec3Out => [
    ex * x + ey * y + ez * z,
    nx * x + ny * y + nz * z,
    ux * x + uy * y + uz * z,
  ];
  // R is orthonormal, so the inverse is the transpose: columns become rows.
  const unrotate = (e: number, n: number, u: number): Vec3Out => [
    ex * e + nx * n + ux * u,
    ey * e + ny * n + uy * u,
    ez * e + nz * n + uz * u,
  ];

  return {
    kind: 'local-enu',
    renderOrigin: [a0, a1, a2],
    isTranslationOnly: false,
    sourceToRenderPoint: (p) => rotate(p[0] - a0, p[1] - a1, p[2] - a2),
    renderToSourcePoint: (p) => {
      const v = unrotate(p[0], p[1], p[2]);
      return [v[0] + a0, v[1] + a1, v[2] + a2];
    },
    sourceVectorToRender: (v) => rotate(v[0], v[1], v[2]),
    renderVectorToSource: (v) => unrotate(v[0], v[1], v[2]),
    renderWorldUp: () => [0, 0, 1],
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Unit vector, or `[0, 0, 1]` for a zero-length input. */
function normalize(v: Vec3): Vec3Out {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0) || !Number.isFinite(len)) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}
