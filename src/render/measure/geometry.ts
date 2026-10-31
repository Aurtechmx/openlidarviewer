/**
 * geometry.ts
 *
 * Pure measurement mathematics — segment lengths, polyline totals, polygon
 * area (own-plane and horizontal/map projection), 3-point angles, slope, and
 * vertical delta. No three.js, no DOM: unit-tested in Node.
 *
 * Every function takes plain `Vec3` tuples in one consistent coordinate space.
 * Distances, areas, angles and slopes are translation-invariant, so working in
 * the cloud's local space gives correct results; only absolute-coordinate
 * *display* needs the cloud origin added back, which the caller handles.
 */

import type { Vec3 } from '../navMath';
import { float32Spacing, PRECISION_BUDGET_M, formatPrecisionMetres } from '../../geo/inMemoryPrecision';
import type { Measurement } from './types';

const EPSILON = 1e-9;

// ── small vector helpers ────────────────────────────────────────────────────

function sub(minuend: Vec3, subtrahend: Vec3): Vec3 {
  return [
    minuend[0] - subtrahend[0],
    minuend[1] - subtrahend[1],
    minuend[2] - subtrahend[2],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len < EPSILON ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Compass azimuth (degrees, 0–360, clockwise from north) of the horizontal
 * direction from `a` to `b`, measured in the map plane perpendicular to `up`.
 *
 * North is world +Y projected into that plane (the convention for a Z-up
 * projected CRS); if `up` is itself nearly parallel to +Y — e.g. a Y-up phone
 * scan — world +Z is used as the north reference instead so the basis stays
 * well-defined. East is `north × up`, giving the expected 90° = due east.
 * Returns NaN when the segment is purely vertical (no horizontal component).
 */
export function bearingDegrees(a: Vec3, b: Vec3, up: Vec3): number {
  const dir = sub(b, a);
  const u = normalize(up);
  if (length(u) < EPSILON) return Number.NaN;
  // Pick a world axis to derive north from; avoid the one parallel to up.
  const worldNorth: Vec3 = Math.abs(dot(u, [0, 1, 0])) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const north = normalize([
    worldNorth[0] - dot(worldNorth, u) * u[0],
    worldNorth[1] - dot(worldNorth, u) * u[1],
    worldNorth[2] - dot(worldNorth, u) * u[2],
  ]);
  const east = normalize(cross(north, u));
  const dNorth = dot(dir, north);
  const dEast = dot(dir, east);
  if (Math.abs(dNorth) < EPSILON && Math.abs(dEast) < EPSILON) return Number.NaN;
  let deg = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** Straight-line distance between two points. */
export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

// ── polyline ────────────────────────────────────────────────────────────────

/** Length of each consecutive segment of a polyline. */
export function segmentLengths(points: Vec3[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push(distance(points[i - 1], points[i]));
  }
  return out;
}

/**
 * Polyline measurement: per-segment lengths, the running cumulative total
 * after each segment, and the grand total.
 */
export function polylineLength(points: Vec3[]): {
  segments: number[];
  cumulative: number[];
  total: number;
} {
  const segments = segmentLengths(points);
  const cumulative: number[] = [];
  let running = 0;
  for (const s of segments) {
    running += s;
    cumulative.push(running);
  }
  return { segments, cumulative, total: running };
}

// ── polygon area ────────────────────────────────────────────────────────────

/**
 * Newell normal of a polygon — a vector perpendicular to the polygon's
 * best-fit plane whose magnitude is twice the polygon's area. Robust for the
 * slightly non-planar vertex rings that real picked polygons always produce.
 */
export function newellNormal(points: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = points.length;
  if (n === 0) return [0, 0, 0];
  // Terms are taken relative to the first vertex: the normal of a closed ring
  // does not depend on the origin, and the products stay small far from it.
  const o = points[0];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2] - 2 * o[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0] - 2 * o[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1] - 2 * o[1]);
  }
  return [nx, ny, nz];
}

/**
 * Vector (Newell) area of the polygon — half the magnitude of the Newell
 * normal. For a PLANAR ring this equals the polygon's area in its own plane;
 * for the slightly non-planar rings real picks produce it is a LOWER BOUND
 * on the true surface area (folded-away components cancel in the vector
 * sum), never the area of a draped surface. "True surface area" was an
 * overclaim; this is the honest statement of what the number is.
 */
export function polygonAreaPlanar(points: Vec3[]): number {
  if (points.length < 3) return 0;
  return length(newellNormal(points)) / 2;
}

/**
 * Horizontal (map / footprint) area — the polygon projected onto the plane
 * perpendicular to `up`. Derived exactly from the Newell normal: the projected
 * area is the normal's component along `up`, halved.
 */
export function polygonAreaHorizontal(points: Vec3[], up: Vec3): number {
  if (points.length < 3) return 0;
  return Math.abs(dot(newellNormal(points), normalize(up))) / 2;
}

/** Perimeter of a closed polygon ring (last vertex joins back to the first). */
export function polygonPerimeter(points: Vec3[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

// ── angle ───────────────────────────────────────────────────────────────────

/**
 * Interior angle at `vertex`, formed by the rays toward `a` and `c`, in
 * degrees (0–180). Returns NaN when either arm has zero length (an end point
 * coincides with the vertex): no direction exists, so the angle is undefined,
 * not 0°. The tolerance scales with the coordinates' magnitude so float noise
 * on large coordinates is not read as a real arm. Collinear arms with non-zero
 * length are legitimate and give 0° or 180°.
 */
export function angleAtVertex(a: Vec3, vertex: Vec3, c: Vec3): number {
  const scale = Math.max(1, ...a.map(Math.abs), ...vertex.map(Math.abs), ...c.map(Math.abs));
  const tol = EPSILON * scale;
  const ra = sub(a, vertex);
  const rc = sub(c, vertex);
  if (!(length(ra) > tol) || !(length(rc) > tol)) return Number.NaN;
  const va = normalize(ra);
  const vc = normalize(rc);
  const cosine = Math.min(1, Math.max(-1, dot(va, vc)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

// ── slope ───────────────────────────────────────────────────────────────────

/** The result of {@link slopeBetween}. */
export interface Slope {
  /** Signed vertical change from `a` to `b`, measured along `up`. */
  rise: number;
  /** Horizontal distance — the component perpendicular to `up`. */
  run: number;
  /**
   * Grade as a percentage (100 · rise / run); SIGNED `±Infinity` for a
   * vertical pair (straight up = +∞, straight down = −∞ — the grade's sign
   * must agree with the rise's, exactly as `angleDeg` reads ±90°).
   */
  gradePercent: number;
  /** Inclination from horizontal, in degrees (−90 … +90). */
  angleDeg: number;
}

/**
 * Signed grade percent — the shared vertical-pair rule for
 * {@link slopeBetween} and {@link profileMetrics}: a degenerate run yields
 * ±Infinity matching the rise's sign (v0.4.3 audit: the old unsigned
 * `Infinity` reported a straight-DOWN pair as an infinite CLIMB).
 */
export function gradePercentOf(rise: number, run: number): number {
  if (run >= EPSILON) return (100 * rise) / run;
  if (rise === 0) return 0;
  return rise > 0 ? Infinity : -Infinity;
}

/** Slope from `a` to `b` relative to the world-up axis. */
export function slopeBetween(a: Vec3, b: Vec3, up: Vec3): Slope {
  const u = normalize(up);
  const d = sub(b, a);
  const rise = dot(d, u);
  const run = length(sub(d, [u[0] * rise, u[1] * rise, u[2] * rise]));
  const gradePercent = gradePercentOf(rise, run);
  const angleDeg = (Math.atan2(rise, run) * 180) / Math.PI;
  return { rise, run, gradePercent, angleDeg };
}

// ── profile (cross-section line metrics) ────────────────────────────────────

/** The full geometric description of a profile line between two points. */
export interface ProfileMetrics {
  /** Straight-line 3D length from `a` to `b`. */
  length3d: number;
  /** Horizontal (map-plane) distance, perpendicular to `up`. */
  lengthHorizontal: number;
  /** Signed vertical change from `a` to `b`, measured along `up`. */
  verticalDrop: number;
  /** Grade as a percentage (100 · rise / run); signed `±Infinity` for a vertical pair. */
  gradePercent: number;
  /** Inclination from horizontal, in degrees (−90 … +90). */
  gradeAngleDeg: number;
}

/**
 * Profile metrics for a 2-point line — the scalar half of a cross-section
 * measurement. The chart half (sampled heights along the line) lives in a
 * follow-up that wires a cloud-sampling adapter into the controller; this
 * function is pure and unit-testable in Node.
 *
 * The metrics derived here are exactly what an engineer reads off a paper
 * cross-section card: how far the line runs in 3D, how far it covers on
 * the map, how much it climbs or drops, and at what grade.
 */
export function profileMetrics(a: Vec3, b: Vec3, up: Vec3): ProfileMetrics {
  const u = normalize(up);
  const d = sub(b, a);
  const verticalDrop = dot(d, u);
  const lengthHorizontal = length(
    sub(d, [u[0] * verticalDrop, u[1] * verticalDrop, u[2] * verticalDrop]),
  );
  const length3d = length(d);
  const gradePercent = gradePercentOf(verticalDrop, lengthHorizontal);
  const gradeAngleDeg = (Math.atan2(verticalDrop, lengthHorizontal) * 180) / Math.PI;
  return {
    length3d,
    lengthHorizontal,
    verticalDrop,
    gradePercent,
    gradeAngleDeg,
  };
}

// ── datum ───────────────────────────────────────────────────────────────────

/**
 * How far a render-local height sits below the elevation the source file
 * describes: the up-axis component of the cloud's render origin.
 *
 * Clouds are recentred on load (`local = world − origin`) so f32 render coords
 * keep their precision, which means a stored local height is only an elevation
 * once the origin is added back. The gap is a constant, so every DELTA taken
 * over local heights (gain, loss, grade, relief) is already correct and needs
 * no datum at all — only an ABSOLUTE reading does. A streaming COPC makes the
 * size of it obvious: its origin is the octree cube centre, which put the
 * user's 418 m ground at −412 render units.
 *
 * A degenerate up axis or a non-finite origin yields 0 — a scan whose datum
 * cannot be established is better shown at its honest local height than shifted
 * by a number nobody can defend.
 */
export function elevationDatumOffset(origin: Vec3, up: Vec3): number {
  const offset = dot(origin, normalize(up));
  return Number.isFinite(offset) ? offset : 0;
}

// ── vertical delta (height tool) ────────────────────────────────────────────

/**
 * Vertical and horizontal offsets between two points relative to `up`.
 * `vertical` is the signed delta along `up` — the height tool's headline
 * value; `horizontal` is the distance perpendicular to `up`.
 */
export function verticalDelta(a: Vec3, b: Vec3, up: Vec3): {
  vertical: number;
  horizontal: number;
} {
  const u = normalize(up);
  const d = sub(b, a);
  const vertical = dot(d, u);
  const horizontal = length(
    sub(d, [u[0] * vertical, u[1] * vertical, u[2] * vertical]),
  );
  return { vertical, horizontal };
}

// ── box (clipping / slicing) ────────────────────────────────────────────────

/** An axis-aligned bounding box defined by two opposite corners. */
export interface BoxBounds {
  /** Per-axis minimum corner (x, y, z). */
  min: Vec3;
  /** Per-axis maximum corner (x, y, z). */
  max: Vec3;
}

/** The scalar metrics displayed in a Box measurement card. */
export interface BoxMetrics {
  /** Per-axis lengths in metres. */
  width: number;
  depth: number;
  height: number;
  /** Volume in cubic metres (width × depth × height). */
  volume: number;
  /** Surface area in square metres — handy for QA / inspection scopes. */
  surfaceArea: number;
}

/**
 * Build an axis-aligned bounding box from two corners that may be supplied
 * in any order — the corners are normalised per-axis so a drag from any
 * direction yields the same box. This is the "2-point diagonal" placement
 * model the box tool uses.
 */
export function boxFromCorners(a: Vec3, b: Vec3): BoxBounds {
  return {
    min: [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.min(a[2], b[2]),
    ],
    max: [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.max(a[2], b[2]),
    ],
  };
}

/**
 * Volume + dimensions + surface area for a box. Degenerate axes (max == min)
 * collapse the corresponding scalar to zero; the calling measurement card
 * shows that explicitly rather than silently treating it as a thin slab.
 */
/**
 * Index of the axis the `up` vector points along (the dominant component).
 * The measurement boxes are axis-aligned in render space, so a scan whose
 * vertical axis is Y needs its HEIGHT read off Y, not Z.
 */
/**
 * How far off-axis an up vector may sit and still name an axis unambiguously.
 * Up vectors arrive through matrix maths, so an exact 0 in the other two
 * components is not guaranteed; 1e-6 admits that float noise (a ~0.00006°
 * deviation) while rejecting any tilt a scan could actually carry.
 */
const AXIS_EPS = 1e-6;

/** The index of a coordinate axis: 0 = X, 1 = Y, 2 = Z. */
export type AxisIndex = 0 | 1 | 2;

/**
 * The index of the axis an up vector names — 0 = X, 1 = Y, 2 = Z.
 *
 * Throws on a genuinely tilted vector. A {@link BoxBounds} is stored as min/max
 * corners, so it is axis-aligned by construction and its "height" can only be
 * the extent along one of X, Y, Z. This previously returned the DOMINANT
 * component, which meant a tilted frame silently got the extent along the
 * nearest axis reported as its height — and that number flows on into the
 * footprint ring, the exported GeoJSON and KML polygons, and the compound-CRS
 * vertical unit conversion. Every one of those would be quietly wrong rather
 * than visibly absent.
 *
 * Supporting tilted frames needs an oriented box (a basis, not an index), which
 * is a change to the measurement's stored shape rather than to this helper. So
 * until that exists the honest answer is a refusal. Nothing in the app reaches
 * it today: every write to the viewer's world-up is exactly (0, ±1, 0) or
 * (0, 0, ±1), chosen by source format.
 */
export function upAxisIndex(up: Vec3): AxisIndex {
  const ax = Math.abs(up[0]);
  const ay = Math.abs(up[1]);
  const az = Math.abs(up[2]);
  const len = Math.hypot(ax, ay, az);
  let axis: AxisIndex;
  if (ay > ax && ay >= az) axis = 1;
  else if (ax > ay && ax >= az) axis = 0;
  else axis = 2;
  // A zero or non-finite vector names no axis, and normalising it would divide
  // by zero — refuse before the ratio test rather than propagate a NaN.
  if (Number.isFinite(len) && len > 0) {
    let dominant: number;
    if (axis === 0) dominant = ax;
    else if (axis === 1) dominant = ay;
    else dominant = az;
    if (dominant / len >= 1 - AXIS_EPS) return axis;
  }
  throw new Error(
    `Box measurements need an axis-aligned up vector (X, Y or Z); got [${up.join(', ')}]. ` +
      `A box is stored as min/max corners, so a tilted frame has no honest height — ` +
      `measuring it would report the extent along the nearest axis instead.`,
  );
}

/** The two non-vertical axes, ascending, for a given up-axis. */
function horizontalAxes(upAxis: AxisIndex): [AxisIndex, AxisIndex] {
  if (upAxis === 0) return [1, 2];
  if (upAxis === 1) return [0, 2];
  return [0, 1];
}

/**
 * Box dimensions with HEIGHT measured along the scan's up-axis.
 *
 * `up` defaults to +Z, which reproduces the historical X=width / Y=depth /
 * Z=height behaviour exactly. It matters for a Y-up frame (phone-scan meshes:
 * PLY, OBJ, GLB/glTF): reading height off Z there reports a horizontal span as
 * the height, and — since the export scales height by the VERTICAL unit factor
 * — would apply a vertical conversion to a horizontal extent on a compound CRS.
 */
export function boxMetrics(box: BoxBounds, up: Vec3 = [0, 0, 1]): BoxMetrics {
  const upAxis = upAxisIndex(up);
  const [h1, h2] = horizontalAxes(upAxis);
  const width = Math.max(0, box.max[h1] - box.min[h1]);
  const depth = Math.max(0, box.max[h2] - box.min[h2]);
  const height = Math.max(0, box.max[upAxis] - box.min[upAxis]);
  const volume = width * depth * height;
  const surfaceArea = 2 * (width * depth + depth * height + width * height);
  return { width, depth, height, volume, surfaceArea };
}

/** Why a Box reports no volume: its two corners sit at one height. */
export const BOX_NO_HEIGHT_NOTE = 'Volume withheld: the box has no height (both corners at one level); set a height to measure a volume.';

/** Why a clip-region Box reports no height or volume. */
export const CLIP_REGION_NOTE = "Clip region: drawn with Draw clipping box, it spans the scan's full height, so it has no measured height or volume.";

/** True when a box's two corners sit at one height along `up`: it has no height, so no volume. */
export function flatBox(a: Vec3, b: Vec3, up: Vec3 = [0, 0, 1]): boolean {
  return Math.abs((b[0] - a[0]) * up[0] + (b[1] - a[1]) * up[1] + (b[2] - a[2]) * up[2]) < 1e-6;
}

/**
 * The 8 corners of a box in a stable order suitable for wireframe overlay
 * rendering. Order is (low-Z then high-Z, each square traversed CCW from
 * (min-X, min-Y)):
 *
 *     bottom: 0  (-,-,-)  1  (+,-,-)  2  (+,+,-)  3  (-,+,-)
 *     top:    4  (-,-,+)  5  (+,-,+)  6  (+,+,+)  7  (-,+,+)
 */
export function boxCorners(box: BoxBounds, up: Vec3 = [0, 0, 1]): Vec3[] {
  // The FIRST four corners are the footprint ring the GeoJSON/KML exporters
  // trace, so "bottom" has to mean the low side along the scan's up-axis. With
  // the default +Z this emits the historical order byte-for-byte; on a Y-up
  // frame it traces the true ground footprint instead of a vertical slice.
  const upAxis = upAxisIndex(up);
  const [h1, h2] = horizontalAxes(upAxis);
  const at = (u: number, a: number, b: number): Vec3 => {
    const p: [number, number, number] = [0, 0, 0];
    p[upAxis] = u;
    p[h1] = a;
    p[h2] = b;
    return p;
  };
  const lo = box.min[upAxis];
  const hi = box.max[upAxis];
  const a0 = box.min[h1];
  const a1 = box.max[h1];
  const b0 = box.min[h2];
  const b1 = box.max[h2];
  // Each face traversed CCW from (min-h1, min-h2), low face first.
  return [
    at(lo, a0, b0), at(lo, a1, b0), at(lo, a1, b1), at(lo, a0, b1),
    at(hi, a0, b0), at(hi, a1, b0), at(hi, a1, b1), at(hi, a0, b1),
  ];
}

/**
 * The 12 edges of a box as pairs of corner indices. Pair with `boxCorners`
 * to render a wireframe overlay.
 */
export const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  // bottom rim
  [0, 1], [1, 2], [2, 3], [3, 0],
  // top rim
  [4, 5], [5, 6], [6, 7], [7, 4],
  // vertical pillars
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Test whether a point lies inside the box (inclusive of all six faces).
 * Used both by the inspector ("how many points are in this slice?") and as
 * the fast-path for the renderer clipping toggle.
 */
export function pointInBox(p: Vec3, box: BoxBounds): boolean {
  return (
    p[0] >= box.min[0] && p[0] <= box.max[0] &&
    p[1] >= box.min[1] && p[1] <= box.max[1] &&
    p[2] >= box.min[2] && p[2] <= box.max[2]
  );
}

/**
 * Count how many points of an interleaved x/y/z buffer fall inside the box.
 * Linear pass, branch-friendly; intended for sub-million-point inspection
 * (the Inspector's "Box contains N points" row), not per-frame culling.
 */
export function countPointsInBox(positions: Float32Array, box: BoxBounds): number {
  let n = 0;
  const N = positions.length / 3;
  for (let i = 0; i < N; i++) {
    const x = positions[i * 3];
    if (x < box.min[0] || x > box.max[0]) continue;
    const y = positions[i * 3 + 1];
    if (y < box.min[1] || y > box.max[1]) continue;
    const z = positions[i * 3 + 2];
    if (z < box.min[2] || z > box.max[2]) continue;
    n++;
  }
  return n;
}

/**
 * Express a source-frame point in an isotropic METRE frame: scale the component
 * along the (unit) up-axis by the vertical factor and the perpendicular
 * (horizontal) part by the horizontal factor. Computing 3D geometry on these
 * points is then physically correct even for a COMPOUND CRS (metre eastings over
 * foot heights) — where scaling a 3D distance or a slope grade by one factor
 * mixed the two axes and produced a self-contradictory export: grade 100 % beside
 * rise 0.3048 m / run 1 m (pass-6 M2). For a single-unit CRS both factors are
 * equal, so this is a uniform scale and every metric is byte-identical to before.
 */
export function toMetricFrame(p: Vec3, up: Vec3, h: number, v: number): Vec3 {
  const along = p[0] * up[0] + p[1] * up[1] + p[2] * up[2]; // dot(p, up)
  return [
    (p[0] - along * up[0]) * h + along * up[0] * v,
    (p[1] - along * up[1]) * h + along * up[1] * v,
    (p[2] - along * up[2]) * h + along * up[2] * v,
  ];
}

// The ring-validity verdict that gates every Area figure; re-exported so the
// export layer reaches it through the geometry module it already uses.
export { areaRingVerdict, areaWithheldReason, type AreaRingVerdict } from './areaValidity';

// ─────────────────────────────────────────────────────────────────────────────
// Position resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a measured figure can be given within the precision budget on the
 * positions its scan holds.
 *
 * Positions are held as Float32 values around a layer's local origin, so the
 * step between representable positions grows with the distance from that
 * origin (about 16 mm at 200 km). Each held position is within half a step of
 * its source per axis, so a figure computed from held positions carries an
 * error that can be bounded from the steps on the axes it uses. A figure is
 * admitted only when that bound is within the budget; otherwise it is withheld
 * with the reason, never reported as a number. The decision reads the steps,
 * not the size of the rounded result, so a separation rounded up to a whole
 * step is withheld just as one rounded down to zero is. Where every step is
 * within the budget nothing is withheld, a genuine zero included.
 *
 * Pure: the steps are read from the measurement's own points less its layer's
 * placement offset, which is the value the layer's buffer actually holds.
 */
/** The `measurementMetrics` key each kind's headline reads first. */
export const HEADLINE_METRIC_KEY: Readonly<Record<Measurement['kind'], string>> = {
  distance: 'length_m', polyline: 'length_m', profile: 'length_m', area: 'area_m2', height: 'vertical_m',
  angle: 'angle_deg', slope: 'grade_pct', box: 'volume_m3', volume: 'area_m2',
};

/** Every `measurementMetrics` key a kind's headline prints. */
export const HEADLINE_METRIC_KEYS: Readonly<Record<Measurement['kind'], readonly string[]>> = {
  distance: ['length_m'], polyline: ['length_m'], profile: ['length_m', 'vertical_m', 'grade_pct'],
  area: ['area_m2'], height: ['vertical_m'], angle: ['angle_deg'], slope: ['grade_pct', 'angle_deg'],
  box: ['width_m', 'depth_m', 'height_m', 'volume_m3'], volume: ['area_m2'],
};

/** True when any figure a kind's headline prints is among `unresolved`. */
export function headlineUnresolved(kind: Measurement['kind'], unresolved: readonly string[]): boolean {
  return HEADLINE_METRIC_KEYS[kind].some((k) => unresolved.includes(k));
}

/** The largest Float32 step, per axis and in source units, at a measurement's points. */
export interface AxisSteps {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The step each axis is held at across `points`, given the placement offset
 * between the layer's buffer and the frame the points are in. Null when a point
 * is not finite.
 */
export function positionSteps(points: readonly Vec3[], offset: Vec3 | null | undefined): AxisSteps | null {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    const sx = float32Spacing(p[0] - (offset?.[0] ?? 0));
    const sy = float32Spacing(p[1] - (offset?.[1] ?? 0));
    const sz = float32Spacing(p[2] - (offset?.[2] ?? 0));
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) return null;
    x = Math.max(x, sx); y = Math.max(y, sy); z = Math.max(z, sz);
  }
  return { x, y, z };
}

/** The larger of two step sets, axis by axis: a measurement spanning layers is held at the coarser. */
export function coarserSteps(a: AxisSteps | null, b: AxisSteps | null): AxisSteps | null {
  if (!a) return b;
  if (!b) return a;
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
}

/** The steps in metres along the horizontal plane, the up axis, and in space. */
export interface LinearSteps {
  readonly horizontal: number;
  readonly vertical: number;
  readonly spatial: number;
}

/** The index of the source axis nearest `up`. */
function nearestAxis(up: Vec3): number {
  const a = [Math.abs(up[0]), Math.abs(up[1]), Math.abs(up[2])];
  return a[2] >= a[0] && a[2] >= a[1] ? 2 : a[1] >= a[0] ? 1 : 0;
}

/** Convert axis steps to metres for a frame whose up axis is `up`. */
export function linearSteps(steps: AxisSteps, up: Vec3, unitToMetres: number, verticalToMetres = unitToMetres): LinearSteps {
  const upAxis = nearestAxis(up);
  const s = [steps.x, steps.y, steps.z];
  const horizontal = Math.max(...s.filter((_, i) => i !== upAxis)) * unitToMetres;
  const vertical = s[upAxis] * verticalToMetres;
  return { horizontal, vertical, spatial: Math.max(horizontal, vertical) };
}

/** True when the representation is coarser than the precision budget, so a figure may be withheld. */
export function overBudget(s: LinearSteps): boolean {
  return s.spatial > PRECISION_BUDGET_M;
}

/**
 * The largest error, in metres, of the separation between two held positions
 * along `axes`. The difference of two held positions is within one step per
 * axis of the true difference e, so for a separation of length L,
 * |L' - L| <= |e . u| + |e_perp|^2 / (2 L). The direction and length are read
 * from the held points, with L reduced by |e| to stay conservative. A
 * separation no longer than |e| has no bound: it cannot be told from zero.
 */
function separationError(a: Vec3, b: Vec3, k: readonly number[], s: readonly number[], axes: readonly number[]): number {
  let l2 = 0;
  let e2 = 0;
  for (const i of axes) {
    const d = (b[i]! - a[i]!) * k[i]!;
    l2 += d * d;
    e2 += s[i]! * s[i]!;
  }
  const l = Math.sqrt(l2);
  const lMin = l - Math.sqrt(e2);
  if (!(lMin > 0)) return Number.POSITIVE_INFINITY;
  let along = 0;
  for (const i of axes) along += (Math.abs((b[i]! - a[i]!) * k[i]!) / l) * s[i]!;
  return along + e2 / (2 * lMin);
}

/**
 * The `measurementMetrics` keys of `m` that cannot be given within the
 * precision budget on the positions its scan holds. Empty when every step is
 * within the budget. Horizontal figures read the horizontal axes, vertical
 * ones the up axis, and spatial ones all three; a figure derived from another
 * (a grade, a volume, an area) goes with the figures it is made from.
 */
export function unresolvedMetricKeys(
  m: Pick<Measurement, 'kind' | 'points'>,
  up: Vec3,
  unitToMetres: number,
  verticalToMetres: number,
  steps: AxisSteps | null | undefined,
): string[] {
  if (!steps) return [];
  if (!overBudget(linearSteps(steps, up, unitToMetres, verticalToMetres))) return [];
  const u = nearestAxis(up);
  const k = [0, 1, 2].map((i) => (i === u ? verticalToMetres : unitToMetres));
  const s = [steps.x, steps.y, steps.z].map((v, i) => v * k[i]!);
  const all = [0, 1, 2];
  const hz = all.filter((i) => i !== u);
  const B = PRECISION_BUDGET_M;
  const p = m.points;
  const sep = (i: number, j: number, axes: readonly number[]): number => separationError(p[i]!, p[j]!, k, s, axes);
  const ring = (axes: readonly number[]): number => {
    let e = 0;
    for (let i = 0; i < p.length; i++) e += sep(i, (i + 1) % p.length, axes);
    return e;
  };
  const verticalOver = s[u]! > B;
  const horizontalOver = Math.max(...hz.map((i) => s[i]!)) > B;
  const out = new Set<string>();
  switch (m.kind) {
    case 'distance':
      if (p.length >= 2) {
        if (sep(0, 1, all) > B) out.add('length_m');
        // Run, rise and grade, as for a profile: a grade needs both.
        if (sep(0, 1, hz) > B) out.add('horizontal_m').add('run_m').add('grade_pct');
        if (verticalOver) out.add('vertical_m').add('rise_m').add('grade_pct');
      }
      break;
    case 'polyline': {
      let e = 0;
      for (let i = 1; i < p.length; i++) e += sep(i - 1, i, all);
      if (p.length >= 2 && e > B) out.add('length_m');
      break;
    }
    case 'height':
      if (p.length >= 2) {
        if (verticalOver) out.add('vertical_m');
        if (sep(0, 1, hz) > B) out.add('horizontal_m');
      }
      break;
    case 'angle':
      if (p.length >= 3 && (sep(1, 0, all) > B || sep(1, 2, all) > B)) out.add('angle_deg');
      break;
    case 'slope':
      // A grade is rise over run: either one unresolved leaves no grade.
      if (p.length >= 2 && (verticalOver || sep(0, 1, hz) > B)) {
        for (const key of ['grade_pct', 'angle_deg', 'rise_m', 'run_m']) out.add(key);
      }
      break;
    case 'profile':
      if (p.length >= 2) {
        if (sep(0, 1, all) > B) out.add('length_m');
        if (sep(0, 1, hz) > B) out.add('horizontal_m').add('grade_pct');
        if (verticalOver) out.add('vertical_m').add('grade_pct');
      }
      break;
    case 'area':
      if (p.length >= 3 && ring(all) > B) for (const key of ['area_m2', 'horizontal_area_m2', 'perimeter_m']) out.add(key);
      break;
    case 'box':
      // Each extent is a difference along one axis, within one step of it.
      if (p.length >= 2) {
        if (horizontalOver) out.add('width_m').add('depth_m').add('volume_m3');
        if (verticalOver) out.add('height_m').add('volume_m3');
      }
      break;
    case 'volume':
      // The cut and fill are integrated from the cloud, not from these points;
      // only the footprint drawn from them is read here.
      if (p.length >= 3 && ring(hz) > B) out.add('area_m2');
      break;
  }
  return [...out];
}

/** The short form the Measure panel prints in place of a headline it cannot give. */
export function unresolvedHeadline(steps: AxisSteps, up: Vec3, unitToMetres: number, verticalToMetres = unitToMetres): string {
  const s = linearSteps(steps, up, unitToMetres, verticalToMetres);
  return `not resolved: this scan holds positions about ${formatPrecisionMetres(s.spatial)} apart, too coarse for this figure; load a smaller tile to measure it`;
}

/**
 * The panel's not-resolved headline for `m` in its unit frame, or null when
 * every figure its headline prints is resolved (or no step is known).
 */
export function unresolvedHeadlineFor(
  m: Pick<Measurement, 'kind' | 'points'>,
  steps: AxisSteps | null,
  up: Vec3,
  frame: { readonly unitToMetres: number; readonly verticalUnitToMetres: number | null },
): string | null {
  if (!steps) return null;
  const v = frame.verticalUnitToMetres ?? frame.unitToMetres;
  if (!headlineUnresolved(m.kind, unresolvedMetricKeys(m, up, frame.unitToMetres, v, steps))) return null;
  return unresolvedHeadline(steps, up, frame.unitToMetres, v);
}

/** The keys of `m` withheld in its unit frame; empty when no step is known. */
export function unresolvedKeysFor(
  m: Pick<Measurement, 'kind' | 'points'>,
  steps: AxisSteps | null,
  up: Vec3,
  frame: { readonly unitToMetres: number; readonly verticalUnitToMetres: number | null },
): string[] {
  return steps ? unresolvedMetricKeys(m, up, frame.unitToMetres, frame.verticalUnitToMetres ?? frame.unitToMetres, steps) : [];
}

/** Why some of a measurement's figures are withheld, for display and export. */
export function unresolvedReason(steps: AxisSteps, up: Vec3, unitToMetres: number, verticalToMetres = unitToMetres): string {
  const s = linearSteps(steps, up, unitToMetres, verticalToMetres);
  return (
    `not resolved: positions on this scan are held about ${formatPrecisionMetres(s.spatial)} apart, ` +
    `too coarse to give this figure within ${formatPrecisionMetres(PRECISION_BUDGET_M)}. Load a smaller tile of the source to measure it.`
  );
}

