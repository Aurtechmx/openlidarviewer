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

const EPSILON = 1e-9;

// ── small vector helpers ────────────────────────────────────────────────────

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
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
 * degrees (0–180). Returns 0 when either ray is degenerate (a coincident
 * point), so a half-placed angle measurement reads cleanly.
 */
export function angleAtVertex(a: Vec3, vertex: Vec3, c: Vec3): number {
  const va = normalize(sub(a, vertex));
  const vc = normalize(sub(c, vertex));
  if (length(va) < EPSILON || length(vc) < EPSILON) return 0;
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
function gradePercentOf(rise: number, run: number): number {
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
export function upAxisIndex(up: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(up[0]);
  const ay = Math.abs(up[1]);
  const az = Math.abs(up[2]);
  const len = Math.hypot(ax, ay, az);
  const axis: 0 | 1 | 2 = ay > ax && ay >= az ? 1 : ax > ay && ax >= az ? 0 : 2;
  // A zero or non-finite vector names no axis, and normalising it would divide
  // by zero — refuse before the ratio test rather than propagate a NaN.
  if (Number.isFinite(len) && len > 0) {
    const dominant = axis === 0 ? ax : axis === 1 ? ay : az;
    if (dominant / len >= 1 - AXIS_EPS) return axis;
  }
  throw new Error(
    `Box measurements need an axis-aligned up vector (X, Y or Z); got [${up.join(', ')}]. ` +
      `A box is stored as min/max corners, so a tilted frame has no honest height — ` +
      `measuring it would report the extent along the nearest axis instead.`,
  );
}

/** The two non-vertical axes, ascending, for a given up-axis. */
function horizontalAxes(upAxis: 0 | 1 | 2): [0 | 1 | 2, 0 | 1 | 2] {
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
