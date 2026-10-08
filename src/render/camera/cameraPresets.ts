/**
 * cameraPresets.ts
 *
 * Pure data layer for v0.3.9 "Smart camera presets" — Top, Iso,
 * Oblique, Planar. Given a description of the visible cloud's
 * bounding sphere and the up axis, return the world-space
 * (position, target) tuple the Viewer should tween to.
 *
 * Why pure: the Viewer owns three.js + the tween scheduler; this
 * module owns the geometry. Keeping them apart means the preset
 * math is unit-testable without booting a renderer, and the same
 * math can serve session restore, share-link rebuild, and the
 * upcoming command palette without any of those callers reaching
 * into three.js types.
 *
 * The four presets are designed to feel like CAD-tool standards:
 *
 *   - Top     — camera directly above the centroid along worldUp,
 *               looking straight down. A small forward bias on the
 *               position keeps OrbitControls' "right" vector
 *               well-defined (a pure top-down looking along worldUp
 *               is a gimbal-lock case for spherical controls).
 *
 *   - Iso     — classic 45° azimuth, 35° elevation isometric pose
 *               (the same angle convention Blender / Maya use). The
 *               horizontal heading is rotated 45° clockwise from the
 *               input horizontal axis so the analyst gets a clean
 *               three-quarter view of the dominant extent.
 *
 *   - Oblique — matches the existing v0.3.5 `frameAll()` opening
 *               pose: horizontal heading, lifted ~35° toward worldUp.
 *               Re-exposed as a named preset for keyboard access
 *               (`O` key) and command palette indexing.
 *
 *   - Planar  — look along the input horizontal axis (zero elevation),
 *               i.e. a true side-on elevation view. Useful for
 *               surveying built-environment scans where the analyst
 *               wants the building elevation.
 *
 * With the visible bounds supplied, the distance is the box fit
 * (`fitBoxDistance`) for the pose's own direction and the viewport aspect,
 * keeping `FRAME_EDGE_RESERVE` clear at each edge. Without them it falls back
 * to the sphere fit `dist = (radius / sin(fov / 2)) * pad`.
 */

/**
 * Sphere-fit padding for a preset or standard view called without bounds.
 * Below 1.0 this is a deliberately tight crop: it can cut off the ends of a
 * thin diagonal cloud. The viewer always passes the visible bounds, which
 * switches to the box fit with {@link FRAME_EDGE_RESERVE} instead.
 */
export const CAMERA_FRAME_PAD = 0.85;

/** Names a preset. Stable string — persisted in `.olvsession`. */
export type CameraPresetName = 'top' | 'iso' | 'oblique' | 'planar';

/** Every preset name in stable display order. */
export const CAMERA_PRESET_ORDER: readonly CameraPresetName[] = [
  'top',
  'iso',
  'oblique',
  'planar',
] as const;

/** Short display label used by the UI chips and command palette. */
export const CAMERA_PRESET_LABEL: Readonly<Record<CameraPresetName, string>> = {
  top: 'Top',
  iso: 'Iso',
  oblique: 'Oblique',
  planar: 'Planar',
};

/**
 * Keyboard shortcut for each preset. Case-insensitive at the handler.
 *
 * Iso has no key: bare `I` belongs to the Inspect tool (see
 * `bindShortcuts`), and binding both produced a tool-toggle + camera-snap
 * double fire (v0.4.4 fix). Iso stays reachable via the NavBar button and
 * the command palette. An empty string means "no key chip, no binding".
 */
export const CAMERA_PRESET_KEY: Readonly<Record<CameraPresetName, string>> = {
  top: 'T',
  iso: '',
  oblique: 'O',
  planar: 'P',
};

/** A 3D point in world space (plain object — no three.js dependency). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Everything the preset math needs from the live viewer. The Viewer
 * shapes its `_visibleBoundingSphere()` + `_horizontalAxis()` outputs
 * into this struct at call time.
 */
export interface PresetInput {
  /** Centroid of the visible bounding sphere. */
  readonly center: Vec3;
  /** Bounding-sphere radius. Treated as 1 when 0. */
  readonly radius: number;
  /** Scene world-up axis. Must be a unit vector. */
  readonly worldUp: Vec3;
  /**
   * A horizontal heading (perpendicular to `worldUp`). The Viewer's
   * `_horizontalAxis()` returns a stable choice for the current
   * scan; this seed is what the iso/oblique/planar presets rotate
   * around. Must be a unit vector.
   */
  readonly horizontal: Vec3;
  /** Perspective camera FOV in degrees. */
  readonly fovDeg: number;
  /**
   * Optional radius multiplier on the fit distance. Larger = more
   * padding around the cloud. Only the sphere fit reads it; a call that
   * passes `boxMin` / `boxMax` is fitted to the box instead.
   */
  readonly pad?: number;
  /**
   * The visible axis-aligned bounds. When both are given the pose is fitted to
   * the box as seen from the requested direction, with {@link FRAME_EDGE_RESERVE}
   * kept free at every screen edge, and the target is the box centre.
   */
  readonly boxMin?: Vec3;
  readonly boxMax?: Vec3;
  /** Viewport width / height for the box fit. Defaults to 1. */
  readonly aspect?: number;
}

/**
 * The preset input for an axis-aligned box: its bounding sphere (centre and
 * half-diagonal, as `Box3.getBoundingSphere` gives) plus the box itself, so the
 * pose is fitted to the bounds.
 */
export function presetInputForBounds(
  box: { readonly min: Vec3; readonly max: Vec3 },
  worldUp: Vec3,
  horizontal: Vec3,
  lens: { readonly fovDeg: number; readonly aspect: number },
): PresetInput {
  const center = scale(add(box.min, box.max), 0.5);
  const radius = length(add(box.max, scale(box.min, -1))) / 2;
  return {
    center,
    radius,
    worldUp,
    horizontal,
    fovDeg: lens.fovDeg,
    aspect: lens.aspect,
    boxMin: box.min,
    boxMax: box.max,
  };
}

/** Result of a preset evaluation. */
export interface PresetPose {
  readonly position: Vec3;
  readonly target: Vec3;
}

// ── internal vector helpers (no three.js) ──────────────────────────

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-9) return { x: 1, y: 0, z: 0 };
  return scale(a, 1 / len);
}

/**
 * Rotate vector `v` around unit axis `axis` by `angle` radians using
 * Rodrigues' formula. Used to spin the horizontal heading for the
 * iso/oblique tilts without pulling in three.js's Vector3.
 */
function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const oneMinusCos = 1 - cosA;
  const dotAV = dot(axis, v);
  const crossAV = cross(axis, v);
  return {
    x: v.x * cosA + crossAV.x * sinA + axis.x * dotAV * oneMinusCos,
    y: v.y * cosA + crossAV.y * sinA + axis.y * dotAV * oneMinusCos,
    z: v.z * cosA + crossAV.z * sinA + axis.z * dotAV * oneMinusCos,
  };
}

/**
 * Sphere-fit camera distance for a given FOV and padding. The standard
 * derivation: a sphere of radius r perfectly fills a perspective
 * frustum of vertical half-angle θ at distance `r / sin(θ)`.
 */
function fitDistance(radius: number, fovDeg: number, pad: number): number {
  const r = radius > 0 ? radius : 1;
  const fovRad = (fovDeg * Math.PI) / 180;
  return (r / Math.sin(fovRad / 2)) * pad;
}

/**
 * Share of the half-screen kept clear at each edge by the box-fitted standard
 * views and presets: every corner of the bounds projects inside |NDC| <= 0.95.
 */
export const FRAME_EDGE_RESERVE = 0.05;

/**
 * Fit distance and target for a pose looking along `-dir` (`dir` points from
 * the target toward the camera). With bounds this is the box fit with the
 * vertical and horizontal fields both narrowed by {@link FRAME_EDGE_RESERVE};
 * without them it falls back to the sphere fit.
 */
function poseFit(input: PresetInput, dir: Vec3): { dist: number; target: Vec3 } {
  const { boxMin, boxMax } = input;
  if (!boxMin || !boxMax) {
    return { dist: fitDistance(input.radius, input.fovDeg, input.pad ?? CAMERA_FRAME_PAD), target: input.center };
  }
  const tanV = Math.tan((input.fovDeg * Math.PI) / 360) * (1 - FRAME_EDGE_RESERVE);
  const dist = fitBoxDistance({
    boxMin,
    boxMax,
    look: scale(dir, -1),
    worldUp: input.worldUp,
    fovDeg: (Math.atan(tanV) * 360) / Math.PI,
    aspect: input.aspect ?? 1,
    pad: 1,
  });
  const target = scale(add(boxMin, boxMax), 0.5);
  return { dist, target };
}

/** Inputs to {@link fitBoxDistance}. */
export interface BoxFitInput {
  readonly boxMin: Vec3;
  readonly boxMax: Vec3;
  /** Unit vector from the camera toward the target (the look direction). */
  readonly look: Vec3;
  readonly worldUp: Vec3;
  readonly fovDeg: number;
  /** Viewport aspect = width / height. */
  readonly aspect: number;
  /** Small margin around the box; default 1.05. */
  readonly pad?: number;
}

/**
 * Distance from the box centre at which the WHOLE axis-aligned box just fits
 * the camera frustum, honouring both the vertical FOV and the aspect-scaled
 * horizontal FOV. Unlike a bounding-sphere fit this adapts to the box shape: a
 * flat wide scan fills the frame instead of leaving the empty top/bottom of its
 * (much larger) bounding sphere, and a tall scan isn't over-zoomed. Pure +
 * deterministic, so it's unit-tested without a camera.
 */
export function fitBoxDistance(input: BoxFitInput): number {
  const c: Vec3 = {
    x: (input.boxMin.x + input.boxMax.x) / 2,
    y: (input.boxMin.y + input.boxMax.y) / 2,
    z: (input.boxMin.z + input.boxMax.z) / 2,
  };
  const look = normalize(input.look);
  // Camera basis; guard the look ∥ worldUp (gimbal) degenerate case.
  let right = cross(look, input.worldUp);
  if (length(right) < 1e-6) right = cross(look, { x: 1, y: 0, z: 0 });
  if (length(right) < 1e-6) right = cross(look, { x: 0, y: 1, z: 0 });
  right = normalize(right);
  const up = normalize(cross(right, look));
  const tanV = Math.tan((input.fovDeg * Math.PI) / 180 / 2);
  const tanH = tanV * Math.max(input.aspect, 1e-3);

  let dist = 0;
  for (let i = 0; i < 8; i++) {
    const a: Vec3 = {
      x: ((i & 1) ? input.boxMax.x : input.boxMin.x) - c.x,
      y: ((i & 2) ? input.boxMax.y : input.boxMin.y) - c.y,
      z: ((i & 4) ? input.boxMax.z : input.boxMin.z) - c.z,
    };
    const ar = Math.abs(dot(a, right));
    const au = Math.abs(dot(a, up));
    const af = dot(a, look);
    // Need |au| <= (af + D)·tanV and |ar| <= (af + D)·tanH for every corner.
    dist = Math.max(dist, au / tanV - af, ar / tanH - af);
  }
  return Math.max(dist, 1e-3) * (input.pad ?? 1.05);
}

// ── presets ───────────────────────────────────────────────────────

/**
 * Compute the (position, target) tuple for a named camera preset.
 * Pure: deterministic for a given input, no side effects, no
 * three.js types. Throws on an unknown preset name.
 */
export function cameraPresetPose(
  name: CameraPresetName,
  input: PresetInput,
): PresetPose {
  const up = normalize(input.worldUp);
  const horiz = normalize(input.horizontal);
  const place = (dir: Vec3): PresetPose => {
    const { dist, target } = poseFit(input, dir);
    return { position: add(target, scale(dir, dist)), target };
  };

  switch (name) {
    case 'top': {
      // Look straight down. A tiny horizontal bias on the position
      // (1° tilt) keeps OrbitControls' "right" vector well-defined
      // — a pure top-down stare along worldUp is a gimbal-lock
      // case for spherical controls.
      const tilt = Math.PI / 180; // 1°
      const dir = normalize(
        add(scale(up, Math.cos(tilt)), scale(horiz, Math.sin(tilt))),
      );
      return place(dir);
    }
    case 'iso': {
      // Classic 45° azimuth, 35.264° (= atan(1/√2)) elevation iso —
      // the angle Blender's numpad-1+5 reaches and Maya's
      // viewport-iso uses. Heading is rotated 45° CW from the input
      // horizontal so the dominant extent reads at a three-quarter
      // angle.
      const elevation = Math.atan(1 / Math.sqrt(2));
      const azim = -Math.PI / 4; // 45° CW
      const headed = rotateAroundAxis(horiz, up, azim);
      const dir = normalize(
        add(
          scale(headed, Math.cos(elevation)),
          scale(up, Math.sin(elevation)),
        ),
      );
      return place(dir);
    }
    case 'oblique': {
      // The v0.3.5 frameAll() opening pose: horizontal heading
      // lifted ~35° (0.61 rad) toward worldUp. Re-named for
      // keyboard + command-palette access.
      const elevation = 0.61;
      const dir = normalize(
        add(scale(horiz, Math.cos(elevation)), scale(up, Math.sin(elevation))),
      );
      return place(dir);
    }
    case 'planar': {
      // Look horizontally along the dominant axis — true side
      // elevation view. Useful for built-environment scans where
      // the analyst wants the building elevation. No vertical
      // component on the direction.
      const dir = horiz;
      return place(dir);
    }
    // The switch is exhaustive over the union, so this arm is unreachable by
    // type. It stays as the runtime guard for a name arriving from outside
    // the type system, and lives inside the switch rather than after it so
    // `allowUnreachableCode` can keep proving the arms above are complete.
    default:
      throw new Error(`Unknown camera preset: ${String(name)}`);
  }
}

// ── Six standard (axis-aligned) views ──────────────────────────────
//
// The Polycam-style "look straight at a face" views: Top / Bottom along the
// world-up axis, and Front / Back / Left / Right around the two horizontal
// axes. Distinct from the angled presets above — these look straight down an
// axis so a wall or floor reads flat and can be measured without skew. Pairing
// them with the viewer's orthographic projection gives a parallel,
// distortion-free view.

/** Names a standard axis-aligned view. */
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Every standard view in a stable display order (top row, then sides). */
export const STANDARD_VIEW_ORDER: readonly StandardView[] = [
  'top',
  'bottom',
  'front',
  'back',
  'left',
  'right',
] as const;

/** Short display label for each standard view. */
export const STANDARD_VIEW_LABEL: Readonly<Record<StandardView, string>> = {
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
};

/**
 * Compute the (position, target) tuple for a standard axis-aligned view.
 *
 * Top / Bottom look along ±worldUp (with a 1° horizontal nudge so the
 * spherical controls keep a well-defined "right" and never gimbal-lock).
 * Front / Back look along ±the horizontal seed axis; Left / Right look along
 * ±the second horizontal axis (worldUp × horizontal). Pure + deterministic.
 */
export function standardViewPose(view: StandardView, input: PresetInput): PresetPose {
  const up = normalize(input.worldUp);
  const horiz = normalize(input.horizontal);
  // The second horizontal axis, perpendicular to both up and the seed.
  const horiz2 = normalize(cross(up, horiz));

  let dir: Vec3;
  switch (view) {
    case 'top':
    case 'bottom': {
      const sign = view === 'top' ? 1 : -1;
      const tilt = Math.PI / 180; // 1° nudge off the pole
      dir = normalize(
        add(scale(up, sign * Math.cos(tilt)), scale(horiz, Math.sin(tilt))),
      );
      break;
    }
    case 'front':
      dir = horiz;
      break;
    case 'back':
      dir = scale(horiz, -1);
      break;
    case 'right':
      dir = horiz2;
      break;
    case 'left':
      dir = scale(horiz2, -1);
      break;
  }
  const { dist, target } = poseFit(input, dir);
  return { position: add(target, scale(dir, dist)), target };
}

/*
 * Framing reserve: fit a scan into the part of the view that chrome leaves free.
 *
 * The opening fit (`fitBoxDistance`) fills the whole frustum, so the
 * bottom-centre navigation widget lands on the scan the moment it opens. This
 * takes a band at the bottom of the canvas, as a fraction of its height, and
 * returns the frustum to fit against plus the offset that recentres the image
 * on what is left:
 *
 *   - the vertical field of view shrinks so the box fills only the top
 *     `1 − r` of the height, with the horizontal field kept as it was;
 *   - a lens shift of `r` in NDC (an off-axis projection window, see
 *     `setLensShift` in orthoCamera.ts) lifts the box centre to the middle of
 *     the free band. The camera and target do not move, so orbit still pivots
 *     on the box centre.
 *
 */

/** Largest share of the height a reserve may take; the scan keeps the rest. */
export const MAX_FRAMING_RESERVE = 0.4;

/** The frustum the fit should use when `reserve` of the height is taken. */
export interface ReservedFrustum {
  readonly fovDeg: number;
  readonly aspect: number;
  /** The reserve actually applied, after clamping. */
  readonly reserve: number;
}

/** Clamp a reserve fraction to [0, MAX_FRAMING_RESERVE]; NaN reads as 0. */
export function clampReserve(reserve: number): number {
  if (!Number.isFinite(reserve) || reserve <= 0) return 0;
  return Math.min(reserve, MAX_FRAMING_RESERVE);
}

/** The narrowed frustum for a bottom reserve. A zero reserve returns the input. */
export function reservedFrustum(fovDeg: number, aspect: number, reserve: number): ReservedFrustum {
  const r = clampReserve(reserve);
  if (r === 0) return { fovDeg, aspect, reserve: 0 };
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const narrowed = (Math.atan(tanV * (1 - r)) * 360) / Math.PI;
  return { fovDeg: narrowed, aspect: aspect / (1 - r), reserve: r };
}

/** Inputs to {@link openingFit}. `dir` points from the target toward the camera. */
export interface OpeningFitInput {
  readonly boxMin: Vec3;
  readonly boxMax: Vec3;
  readonly dir: Vec3;
  readonly worldUp: Vec3;
  readonly fovDeg: number;
  readonly aspect: number;
  /** Share of the canvas height kept free at the bottom; see {@link reservedFrustum}. */
  readonly reserve: number;
}

/** The opening pose, and the lens shift (NDC units) that lifts the image into the free band. */
export interface OpeningFit {
  readonly target: Vec3;
  readonly position: Vec3;
  readonly lensShift: number;
}

/**
 * Fit a box for the opening view. The target is always the box centre, so
 * orbit and zoom pivot on the scan. A bottom reserve narrows the fit and is
 * paid for with a lens shift of `reserve` in NDC (the projection window moves
 * down, so the image moves up), never by moving the target.
 */
export function openingFit(input: OpeningFitInput): OpeningFit {
  const fr = reservedFrustum(input.fovDeg, input.aspect, input.reserve);
  const dl = Math.hypot(input.dir.x, input.dir.y, input.dir.z) || 1;
  const d = { x: input.dir.x / dl, y: input.dir.y / dl, z: input.dir.z / dl };
  const dist = fitBoxDistance({
    boxMin: input.boxMin,
    boxMax: input.boxMax,
    look: { x: -d.x, y: -d.y, z: -d.z },
    worldUp: input.worldUp,
    fovDeg: fr.fovDeg,
    aspect: fr.aspect,
    pad: 1.05,
  });
  const target = {
    x: (input.boxMin.x + input.boxMax.x) / 2,
    y: (input.boxMin.y + input.boxMax.y) / 2,
    z: (input.boxMin.z + input.boxMax.z) / 2,
  };
  const position = { x: target.x + d.x * dist, y: target.y + d.y * dist, z: target.z + d.z * dist };
  return { target, position, lensShift: fr.reserve };
}

