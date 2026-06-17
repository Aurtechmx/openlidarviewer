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
 * The distance formula is the standard sphere-fit-to-FOV:
 *   `dist = (radius / sin(fov / 2)) * pad`
 * Default `pad` is 1.2, matching `Viewer.frameAll()`.
 */

/**
 * Sphere-fit padding shared by `Viewer.frameAll()` and every camera preset.
 * 0.85 (was 1.2) opens a scan ~25% closer so it fills the viewport and the
 * Top / Oblique / Planar views read as distinctly different framings rather
 * than near-identical far shots. Sub-1.0 only trims the empty volume of a flat
 * scan's bounding sphere; the points stay in frame.
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
   * padding around the cloud. Defaults to 1.2 (matches frameAll).
   */
  readonly pad?: number;
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
  const pad = input.pad ?? CAMERA_FRAME_PAD;
  const dist = fitDistance(input.radius, input.fovDeg, pad);
  const up = normalize(input.worldUp);
  const horiz = normalize(input.horizontal);
  const target = input.center;

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
      const position = add(target, scale(dir, dist));
      return { position, target };
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
      const position = add(target, scale(dir, dist));
      return { position, target };
    }
    case 'oblique': {
      // The v0.3.5 frameAll() opening pose: horizontal heading
      // lifted ~35° (0.61 rad) toward worldUp. Re-named for
      // keyboard + command-palette access.
      const elevation = 0.61;
      const dir = normalize(
        add(scale(horiz, Math.cos(elevation)), scale(up, Math.sin(elevation))),
      );
      const position = add(target, scale(dir, dist));
      return { position, target };
    }
    case 'planar': {
      // Look horizontally along the dominant axis — true side
      // elevation view. Useful for built-environment scans where
      // the analyst wants the building elevation. No vertical
      // component on the direction.
      const dir = horiz;
      const position = add(target, scale(dir, dist));
      return { position, target };
    }
  }
  // Exhaustive switch above — this is unreachable, but TypeScript's
  // narrowing can't always prove it through a Record-typed name.
  throw new Error(`Unknown camera preset: ${String(name)}`);
}

// ── Six standard (axis-aligned) views ──────────────────────────────
//
// The Polycam-style "look straight at a face" views: Top / Bottom along the
// world-up axis, and Front / Back / Left / Right around the two horizontal
// axes. Distinct from the angled presets above — these look straight down an
// axis so a wall or floor reads flat and can be measured without skew. Pairing
// them with the viewer's near-orthographic (very narrow FOV) projection gives
// a parallel, distortion-free view.

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
  const pad = input.pad ?? CAMERA_FRAME_PAD;
  const dist = fitDistance(input.radius, input.fovDeg, pad);
  const up = normalize(input.worldUp);
  const horiz = normalize(input.horizontal);
  // The second horizontal axis, perpendicular to both up and the seed.
  const horiz2 = normalize(cross(up, horiz));
  const target = input.center;

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
  return { position: add(target, scale(dir, dist)), target };
}
