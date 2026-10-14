/**
 * viewCubeMath.ts
 *
 * Pure geometry behind the on-canvas ViewCube / compass gizmo. No three.js, no
 * DOM, so it is unit-tested in Node and the lazy widget (`src/ui/viewCube.ts`)
 * stays a thin renderer over it.
 *
 * The cube does two jobs:
 *   1. Show which way the camera is facing — it turns with the camera's full
 *      orientation (pitch, yaw and roll) in the scene's own up-axis frame.
 *   2. Turn the camera when a face, edge or corner is clicked: the faces are
 *      the six axis-aligned views the toolbar already exposes (v0.4.6), the
 *      edges and corners the 20 directions between them.
 */

/** The six axis-aligned standard views the gizmo can snap to. */
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/**
 * Camera heading around the world up axis, in degrees [0, 360), from the
 * horizontal components of its forward vector. 0° = looking toward +North (the
 * `back` view looks north), increasing clockwise through East.
 *
 * `forwardEast` / `forwardNorth` are the camera forward vector's components in
 * the world ground plane (the two axes that are NOT the up axis); the caller
 * picks them from the scan's up-axis convention (Z-up vs Y-up).
 */
export function compassHeadingDeg(forwardEast: number, forwardNorth: number): number {
  if (!Number.isFinite(forwardEast) || !Number.isFinite(forwardNorth)) return 0;
  if (forwardEast === 0 && forwardNorth === 0) return 0;
  const deg = (Math.atan2(forwardEast, forwardNorth) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * Below this horizontal magnitude of the (unit) forward vector the heading is
 * not trustworthy: the camera looks within ~0.57 degrees of straight up or
 * down, where atan2 of two near-zero components flips with floating-point
 * noise. 0.01 = sin(0.573 degrees). Consumers keep their last reliable heading
 * instead of snapping the rose back to north.
 */
export const NEAR_VERTICAL_HORIZONTAL_EPS = 0.01;

/**
 * {@link compassHeadingDeg} with a near-vertical guard: when the forward
 * vector's horizontal component magnitude is below
 * {@link NEAR_VERTICAL_HORIZONTAL_EPS} (or non-finite), returns `lastReliableDeg`
 * — NaN by default, which a display that unwraps with {@link unwrapAngleDeg}
 * treats as "hold the previous angle". Otherwise the canonical heading.
 */
export function stableHeadingDeg(forwardEast: number, forwardNorth: number, lastReliableDeg = Number.NaN): number {
  if (!Number.isFinite(forwardEast) || !Number.isFinite(forwardNorth)) return lastReliableDeg;
  if (Math.hypot(forwardEast, forwardNorth) < NEAR_VERTICAL_HORIZONTAL_EPS) return lastReliableDeg;
  return compassHeadingDeg(forwardEast, forwardNorth);
}

/**
 * Continuous display angle: moves from `prevDisplayDeg` to the angle that is
 * congruent to `nextCanonicalDeg` (mod 360) along the SHORTEST delta, so a CSS
 * rotation never spins the long way round when a heading crosses 0/360
 * (359 -> 1 moves +2, 1 -> 359 moves -2) and repeated turns accumulate.
 * A non-finite `nextCanonicalDeg` returns `prevDisplayDeg` unchanged; a
 * non-finite `prevDisplayDeg` (no display yet) starts from the canonical angle.
 * An exact half-turn resolves to +180.
 */
export function unwrapAngleDeg(prevDisplayDeg: number, nextCanonicalDeg: number): number {
  if (!Number.isFinite(nextCanonicalDeg)) return prevDisplayDeg;
  if (!Number.isFinite(prevDisplayDeg)) return nextCanonicalDeg;
  const prev = prevDisplayDeg;
  let delta = (((nextCanonicalDeg - prev) % 360) + 360) % 360; // [0, 360)
  if (delta > 180) delta -= 360;
  return prev + delta;
}

/*
 * The 3D ViewCube.
 *
 * Everything below works in the SCENE BASIS: three orthonormal axes
 * `[east, north, up]`, where `up` is the scene's declared up axis, `north` is
 * the Viewer's stable horizontal axis (`_horizontalAxis`, the +Y axis of a
 * Z-up scan, which is grid north on a projected CRS) and `east = north × up`.
 * The Viewer converts to and from world space; nothing here knows three.js.
 */

/** A vector in the scene basis: `[east, north, up]`. */
export type SceneVec = readonly [number, number, number];

/** Sign of one basis component of a cube target: -1, 0 or +1. */
export type CubeSign = -1 | 0 | 1;

/** What part of the cube a target is. */
export type CubeTargetKind = 'face' | 'edge' | 'corner';

/** One of the 26 clickable cube targets. */
export interface CubeTarget {
  /** Stable id, e.g. `top`, `north-east`, `top-south-west`. */
  readonly id: string;
  readonly kind: CubeTargetKind;
  /** Which side of the cube along `[east, north, up]`. */
  readonly signs: readonly [CubeSign, CubeSign, CubeSign];
  /** For a face: the standard view it reproduces (same direction conventions). */
  readonly view: StandardView | null;
}

/** Camera direction for a cube target: `dir` points from the pivot to the camera. */
export interface CubeOrientation {
  readonly dir: SceneVec;
  /** The camera's screen-up for that view, orthogonal to `dir`. */
  readonly up: SceneVec;
}

/**
 * The faces, keyed by the standard view whose direction they reproduce. These
 * are the conventions of `standardViewPose` (cameraPresets.ts) restated in the
 * scene basis: front looks from +horizontal (+north), right from
 * `up × horizontal` (-east), top from +up.
 */
const FACE_SIGNS: Readonly<Record<StandardView, readonly [CubeSign, CubeSign, CubeSign]>> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, 1, 0],
  back: [0, -1, 0],
  right: [-1, 0, 0],
  left: [1, 0, 0],
};

const AXIS_WORDS: readonly (readonly [string, string])[] = [
  ['east', 'west'],
  ['north', 'south'],
  ['top', 'bottom'],
];

function targetId(signs: readonly [CubeSign, CubeSign, CubeSign]): string {
  // Vertical first, then north/south, then east/west: "top-north-east".
  const parts: string[] = [];
  for (const axis of [2, 1, 0]) {
    const s = signs[axis];
    if (s !== 0) parts.push(AXIS_WORDS[axis][s > 0 ? 0 : 1]);
  }
  return parts.join('-');
}

function viewForSigns(signs: readonly [CubeSign, CubeSign, CubeSign]): StandardView | null {
  for (const [view, s] of Object.entries(FACE_SIGNS) as [StandardView, readonly CubeSign[]][]) {
    if (s[0] === signs[0] && s[1] === signs[1] && s[2] === signs[2]) return view;
  }
  return null;
}

/** All 26 targets: 6 faces, then 12 edges, then 8 corners. */
export const CUBE_TARGETS: readonly CubeTarget[] = ((): CubeTarget[] => {
  const out: CubeTarget[] = [];
  const signs: CubeSign[] = [-1, 0, 1];
  for (const e of signs) for (const n of signs) for (const u of signs) {
    const s: [CubeSign, CubeSign, CubeSign] = [e, n, u];
    const nonZero = s.filter((v) => v !== 0).length;
    if (nonZero === 0) continue;
    const kind: CubeTargetKind = nonZero === 1 ? 'face' : nonZero === 2 ? 'edge' : 'corner';
    out.push({ id: targetId(s), kind, signs: s, view: viewForSigns(s) });
  }
  const rank: Record<CubeTargetKind, number> = { face: 0, edge: 1, corner: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
})();

/** The target for a standard view's face. */
export function cubeTargetForView(view: StandardView): CubeTarget {
  const t = CUBE_TARGETS.find((c) => c.view === view);
  if (!t) throw new Error(`no cube face for ${view}`);
  return t;
}

/** Tilt off the pole for straight-down / straight-up views, as `standardViewPose` uses. */
const POLE_TILT_RAD = Math.PI / 180;

function norm(v: SceneVec): SceneVec {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function dot(a: SceneVec, b: SceneVec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: SceneVec, b: SceneVec): SceneVec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Camera direction and screen-up for a cube target. A target with no
 * horizontal component (top / bottom) is nudged 1° toward +north, exactly like
 * the standard top / bottom views, so orbit controls keep a defined "right".
 * Screen-up is the scene up axis made orthogonal to the direction.
 */
export function cubeTargetOrientation(target: CubeTarget): CubeOrientation {
  const [e, n, u] = target.signs;
  let dir: SceneVec;
  if (e === 0 && n === 0) {
    dir = [0, Math.sin(POLE_TILT_RAD), u * Math.cos(POLE_TILT_RAD)];
  } else {
    dir = norm([e, n, u]);
  }
  const upAxis: SceneVec = [0, 0, 1];
  const d = dot(upAxis, dir);
  const up = norm([upAxis[0] - d * dir[0], upAxis[1] - d * dir[1], upAxis[2] - d * dir[2]]);
  return { dir, up };
}

/** The camera's orientation in the scene basis, as the Viewer reports it. */
export interface CameraOrientation {
  /** Unit view direction (where the camera looks). */
  readonly forward: SceneVec;
  /** Unit screen-up of the camera. */
  readonly up: SceneVec;
  /** Whether the scene's up axis is +Z (survey convention) rather than +Y. */
  readonly upIsZ: boolean;
}

/**
 * CSS `matrix3d` (column-major, 16 numbers) that draws scene-basis geometry as
 * the camera sees it: screen x = camera right, y = camera DOWN (CSS), z toward
 * the viewer. Feeding the camera's live orientation makes the cube follow
 * pitch, yaw and roll, not just heading.
 */
export function cubeViewMatrix(o: CameraOrientation): number[] {
  const f = norm(o.forward);
  // Re-orthogonalise up against forward (the camera's own may drift a hair).
  const d = dot(o.up, f);
  const up = norm([o.up[0] - d * f[0], o.up[1] - d * f[1], o.up[2] - d * f[2]]);
  const right = cross(f, up);
  const m: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    m.push(right[axis], -up[axis], -f[axis], 0);
  }
  m.push(0, 0, 0, 1);
  return m;
}

/** Project a scene-basis point through {@link cubeViewMatrix}: [x, y-down, z-toward-viewer]. */
export function projectCubePoint(matrix: readonly number[], p: SceneVec): SceneVec {
  return [
    matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2],
    matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2],
    matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2],
  ];
}

/**
 * The CSS `matrix3d` placing a face element (a square in its own x-right /
 * y-down plane) on the unit cube's face at `half` px from the centre. The face
 * is laid out as the camera would see it from that face's own view, so its
 * label reads upright when the cube is turned to it.
 */
export function cubeFaceMatrix(view: StandardView, half: number): number[] {
  const { dir, up } = cubeTargetOrientation(cubeTargetForView(view));
  const f: SceneVec = [-dir[0], -dir[1], -dir[2]];
  const x = cross(f, up);
  const normal = norm(FACE_SIGNS[view] as SceneVec);
  return [
    x[0], x[1], x[2], 0,
    -up[0], -up[1], -up[2], 0,
    normal[0], normal[1], normal[2], 0,
    normal[0] * half, normal[1] * half, normal[2] * half, 1,
  ];
}

/** Outward normal of each face in the scene basis [east, north, up]. */
export const CUBE_FACE_NORMALS: Readonly<Record<StandardView, SceneVec>> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, 1, 0], back: [0, -1, 0], right: [-1, 0, 0], left: [1, 0, 0],
};

/** Desktop (fine pointer) and touch (coarse pointer) cube geometry, in CSS px: stage box, face half-side, edge/corner target size, Home size. */
export const CUBE_SIZE = {
  fine: { box: 120, half: 34, hit: 24, home: 24 },
  coarse: { box: 156, half: 45, hit: 44, home: 44 },
} as const;

/** WCAG 2.2 target size minimum (SC 2.5.8), CSS px: no shown face may project to a box narrower than this, and `hit` is never below it. */
export const CUBE_MIN_TARGET = 24;

/** A face whose outward normal points toward the viewer by less than this is turned away or edge-on. */
export const CUBE_FACE_MIN_DEPTH = 0.12;

/** CSS `matrix(a, b, c, d, e, f)` numbers. */
export type Affine2D = readonly [number, number, number, number, number, number];

/** One face's place on screen, relative to the cube's centre. */
export interface CubeFaceLayout {
  /** Whether the face is turned toward the viewer enough to be drawn and pressed. */
  readonly visible: boolean;
  /** A square of side `2 * half`, centred on the origin, mapped to the projected face (a parallelogram: the view is orthographic). */
  readonly affine: Affine2D;
  /** The projected face centre; also the centre of its bounding box. */
  readonly cx: number;
  readonly cy: number;
}

/** One edge or corner target's place on screen, relative to the cube's centre. */
export interface CubeSpotLayout {
  readonly id: string;
  /** Whether it is shown and pressable: on the near side, and clear of every other target. */
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
}

export interface CubeHitLayout {
  readonly faces: Readonly<Record<StandardView, CubeFaceLayout>>;
  readonly spots: readonly CubeSpotLayout[];
}

/**
 * The whole screen layout of the cube's 26 targets for one view matrix, as
 * plain geometry, so the hit regions never depend on how a browser hit-tests
 * CSS 3D.
 *
 * The view is orthographic, so every visible face is a parallelogram and the
 * visible faces tile the cube's silhouette without overlapping. Edge and
 * corner targets are circles of diameter `hit` drawn ABOVE the faces. They
 * are admitted front-most first, and one is dropped when it would sit within
 * a diameter of an admitted spot or cover a visible face's centre. So at every
 * orientation each shown target's centre belongs to that target alone, and no
 * two circles overlap: a press on a face can never fire an edge or corner.
 * Every shown face is at least `CUBE_MIN_TARGET` wide and tall, and `hit`
 * should be too, so no shown target needs the spacing exemption.
 */
export function layoutCubeTargets(m: readonly number[], half: number, hit: number): CubeHitLayout {
  const faces = {} as Record<StandardView, CubeFaceLayout>;
  const faceCentres: { x: number; y: number }[] = [];
  for (const view of Object.keys(CUBE_FACE_NORMALS) as StandardView[]) {
    const n = CUBE_FACE_NORMALS[view];
    const c = projectCubePoint(m, [n[0] * half, n[1] * half, n[2] * half]);
    const { dir, up } = cubeTargetOrientation(cubeTargetForView(view));
    const f: SceneVec = [-dir[0], -dir[1], -dir[2]];
    const xAxis = cross(f, up);
    const yAxis: SceneVec = [-up[0], -up[1], -up[2]];
    const px = projectCubePoint(m, xAxis);
    const py = projectCubePoint(m, yAxis);
    // A face seen at a glancing angle projects to a sliver; below the minimum
    // target size on either side it is not drawn or pressable (its view stays
    // reachable through the neighbouring faces, the Home strip's menu and the palette).
    const w = 2 * half * (Math.abs(px[0]) + Math.abs(py[0]));
    const h = 2 * half * (Math.abs(px[1]) + Math.abs(py[1]));
    const visible = projectCubePoint(m, n)[2] > CUBE_FACE_MIN_DEPTH && Math.min(w, h) >= CUBE_MIN_TARGET;
    faces[view] = { visible, affine: [px[0], px[1], py[0], py[1], c[0], c[1]], cx: c[0], cy: c[1] };
    if (visible) faceCentres.push({ x: c[0], y: c[1] });
  }
  const candidates = CUBE_TARGETS.filter((t) => t.kind !== 'face').map((t) => {
    const [x, y, z] = projectCubePoint(m, [t.signs[0] * half, t.signs[1] * half, t.signs[2] * half]);
    return { id: t.id, x, y, z };
  });
  // Front-most first; the id breaks exact ties so the result is deterministic.
  const order = [...candidates].sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : 1));
  const admitted: { x: number; y: number }[] = [];
  const shown = new Set<string>();
  for (const c of order) {
    if (c.z <= half * 0.15) continue; // far side
    const clearOfFaces = faceCentres.every((f) => Math.hypot(f.x - c.x, f.y - c.y) >= hit / 2);
    const clearOfSpots = admitted.every((a) => Math.hypot(a.x - c.x, a.y - c.y) >= hit);
    if (!clearOfFaces || !clearOfSpots) continue;
    admitted.push({ x: c.x, y: c.y });
    shown.add(c.id);
  }
  return { faces, spots: candidates.map((c) => ({ id: c.id, visible: shown.has(c.id), x: c.x, y: c.y })) };
}

/**
 * Which face the camera is looking at squarely: the face whose outward normal
 * is within ~10° of the direction back to the camera. Null between faces.
 */
export function activeCubeFace(o: CameraOrientation, cosLimit = 0.985): StandardView | null {
  const back = norm([-o.forward[0], -o.forward[1], -o.forward[2]]);
  let best: StandardView | null = null;
  let bestDot = cosLimit;
  for (const [view, s] of Object.entries(FACE_SIGNS) as [StandardView, SceneVec][]) {
    const c = dot(back, s);
    if (c >= bestDot) { bestDot = c; best = view; }
  }
  return best;
}

/**
 * The face label policy for the cube.
 *
 *   - `geographic`: the scene is Z-up AND its CRS is known, so +north is the
 *     CRS's +Y axis (grid north on a projected CRS). The four side faces read
 *     N / E / S / W by the direction they face; top and bottom read Top /
 *     Bottom.
 *   - otherwise: truthful local names. A local / unknown-CRS scan, or a Y-up
 *     scan whose horizontal axes are not a map grid, never gets N/E labels it
 *     cannot substantiate; its faces carry the standard view names.
 */
export function cubeFaceLabel(view: StandardView, geographic: boolean): string {
  if (geographic) {
    const s = FACE_SIGNS[view];
    if (s[1] === 1) return 'N';
    if (s[1] === -1) return 'S';
    if (s[0] === 1) return 'E';
    if (s[0] === -1) return 'W';
  }
  return VIEW_TITLE[view];
}

const VIEW_TITLE: Readonly<Record<StandardView, string>> = {
  top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right',
};

/**
 * Accessible name for a cube target, honest about the scan's frame. Phrased as
 * "… face / edge / corner" so it never collides with the toolbar's own "Top
 * view" / "Front view (axis aligned)" buttons.
 */
export function cubeTargetName(target: CubeTarget, geographic: boolean): string {
  if (target.view) {
    const label = cubeFaceLabel(target.view, geographic);
    if (geographic && label.length === 1) {
      const word = { N: 'Grid north', S: 'South', E: 'East', W: 'West' }[label as 'N' | 'S' | 'E' | 'W'];
      return `${word} face`;
    }
    return `${label} face`;
  }
  const words = target.id.split('-').map((w) => {
    if (geographic) return w;
    // Local frame: speak in standard-view terms, never compass words.
    return { north: 'front', south: 'back', east: 'left', west: 'right', top: 'top', bottom: 'bottom' }[w] ?? w;
  });
  const name = words.join('-');
  return `${name[0].toUpperCase()}${name.slice(1)} ${target.kind}`;
}

/**
 * An axis-aligned rectangle the cube must not cover, in the host's coordinate
 * space.
 */
export interface PlacementRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/**
 * Where to put the cube in its host, or null when no clear place exists.
 *
 * The preferred place is the top-right corner. Every position built from the
 * corner and from the edges of each obstacle (just left of, just right of,
 * just below or just above it) is tried, and the clear, in-host position
 * nearest the corner wins, so the cube moves as little as it must. Returning
 * null means the cube should be hidden rather than drawn over a control: it
 * never covers one.
 */
export function placeCube(
  host: { readonly width: number; readonly height: number },
  size: number | { readonly width: number; readonly height: number },
  obstacles: readonly PlacementRect[],
  margin = 14,
  gap = 10,
): { readonly left: number; readonly top: number } | null {
  const w = typeof size === 'number' ? size : size.width;
  const h = typeof size === 'number' ? size : size.height;
  const cornerLeft = host.width - margin - w;
  const xs = [cornerLeft, ...obstacles.flatMap((o) => [o.left - gap - w, o.right + gap])];
  const ys = [margin, ...obstacles.flatMap((o) => [o.bottom + gap, o.top - gap - h])];
  const clear = (l: number, t: number): boolean =>
    obstacles.every((o) => !(l < o.right + gap && l + w > o.left - gap && t < o.bottom + gap && t + h > o.top - gap));
  const inside = (l: number, t: number): boolean =>
    l >= margin && t >= margin && l + w <= host.width - margin && t + h <= host.height - margin;
  let best: { left: number; top: number } | null = null;
  let bestD = Infinity;
  for (const l of xs) {
    for (const t of ys) {
      if (!inside(l, t) || !clear(l, t)) continue;
      const d = (l - cornerLeft) ** 2 + (t - margin) ** 2;
      if (d < bestD) { bestD = d; best = { left: Math.round(l), top: Math.round(t) }; }
    }
  }
  return best;
}
