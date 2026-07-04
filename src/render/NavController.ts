/**
 * NavController.ts
 *
 * Game-style camera navigation for the viewer: four modes (orbit, walk, fly,
 * pan), WASD movement, pointer-lock mouse-look, sprint, and eased camera
 * tweens for smooth framing and focus.
 *
 * Design:
 *  - **Orbit** — the default. OrbitControls drives the camera; the mouse
 *    rotates / pans / zooms around a target.
 *  - **Walk** — first-person. WASD moves on the horizontal plane (you keep
 *    your height); Space / C change height deliberately.
 *  - **Fly** — free 6-DOF. WASD moves along the look direction, so you fly
 *    wherever you point; Space / C still nudge straight up / down.
 *  - **Pan** — the v0.5.5 hand tool (program §P1). A primary drag grabs the
 *    whole scene and slides it under the pointer 1:1 on a plane locked at
 *    pointer-down; wheel keeps dollying via OrbitControls. Middle-mouse drag
 *    is the same grab temporarily, in ANY mode. Gated by `?handPan=off`.
 *
 * The movement maths lives in `navMath.ts` and the hand-tool geometry in
 * `panMath.ts` (both pure, unit-tested). This file owns the browser-bound
 * parts: input listeners, pointer lock/capture, cursors, and applying the
 * result to a three.js camera. Like `Viewer.ts`, it must not be imported
 * in Node / Vitest tests.
 *
 * Up-axis: the controller works with an arbitrary world-up vector so a Z-up
 * LAS survey and a Y-up phone scan both navigate correctly.
 */

import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  desiredVelocity,
  smoothVelocity,
  easeInOutCubic,
  orbitOffset,
} from './navMath';
import type { Vec3, OrbitKeys } from './navMath';
import {
  intersectRayPlane,
  panGestureKind,
  panModeForKey,
  panPlaneDelta,
  screenPanDelta,
} from './panMath';
import {
  normalizeWheelDeltaPx,
  applyWheelImpulse,
  stepDolly,
  isDollySettled,
} from './wheelDollyMath';
import { readDevFlags } from '../perf/devFlags';

/** The four navigation modes ('pan' is the v0.5.5 hand tool, program §P1). */
export type NavMode = 'orbit' | 'walk' | 'fly' | 'pan';

/** A saveable camera viewpoint: where it sits and what it looks at. */
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** Hooks the app wires up so the UI and viewer can react to navigation. */
export interface NavCallbacks {
  /** Fired whenever the active mode changes. */
  onModeChange?: (mode: NavMode) => void;
  /** Fired when the pointer-lock (mouse-look) state changes. */
  onPointerLockChange?: (locked: boolean) => void;
  /** `R` — reset / re-frame the view. */
  onReset?: () => void;
  /** `F` — focus on whatever is centred in the view. */
  onFocusCenter?: () => void;
  /** `H` — toggle the controls help overlay. */
  onToggleHelp?: () => void;
}

interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  elapsed: number;
  duration: number;
}

/** Sprint multiplier applied while Shift is held. */
const SPRINT = 3;
/** Mouse-look sensitivity, radians per pixel of movement. */
const LOOK_SENSITIVITY = 0.0022;
/** Pitch is clamped just shy of straight up / down to avoid a degenerate camera. */
const MAX_PITCH = 1.535; // ~88°
/** Largest delta-time step honoured — guards against huge jumps after a stall. */
const MAX_DT = 0.1;

// ── P2 wheel/trackpad dolly tuning (program §P2) ─────────────────────────────
// These are FEEL constants — the numbers a maintainer tunes against real wheels
// and trackpads on-device. The maths that consumes them is pinned by
// tests/wheelDollyMath.test.ts; only the feel lives here.
/** Log-space velocity added per CSS pixel of normalised wheel delta. */
const WHEEL_SENSITIVITY = 0.006;
/** Exponential velocity decay per second — how quickly a flick settles. */
const WHEEL_FRICTION = 12;
/** Symmetric ceiling on accumulated dolly velocity (anti-runaway). */
const MAX_DOLLY_VELOCITY = 3;
/** Fallback CSS line height for `deltaMode === LINE` wheels. */
const WHEEL_LINE_HEIGHT_PX = 16;
/** Arrow-key orbit angular speed, radians per second (~4 s for a full turn). */
const ORBIT_KEY_SPEED = 1.6;

export class NavController {
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _controls: OrbitControls;
  private readonly _cb: NavCallbacks;

  private _mode: NavMode = 'orbit';
  private _hasCloud = false;

  // ── Look orientation (walk / fly) ──────────────────────────────────────
  private _yaw = 0;
  private _pitch = 0;
  private _worldUp = new THREE.Vector3(0, 1, 0);
  private _refForward = new THREE.Vector3(0, 0, -1);
  private _refRight = new THREE.Vector3(1, 0, 0);

  // ── Movement state ─────────────────────────────────────────────────────
  private readonly _keys = {
    forward: false, backward: false, left: false, right: false,
    up: false, down: false,
  };
  private _sprint = false;
  private _velocity: Vec3 = [0, 0, 0];
  private _baseSpeed = 10;
  private _speedMultiplier = 1;

  // ── Keyboard orbit (arrow keys, orbit mode) ────────────────────────────
  private readonly _orbitKeys: OrbitKeys = {
    left: false, right: false, up: false, down: false,
  };
  /** Eased angular velocity: [yawRate, pitchRate, unused] in radians/second. */
  private _orbitVel: Vec3 = [0, 0, 0];

  // ── Pointer lock ───────────────────────────────────────────────────────
  private _locked = false;

  // ── Input gate — cleared while another tool (e.g. Measure) owns input ──
  private _inputEnabled = true;

  // ── Camera tween ───────────────────────────────────────────────────────
  private _tween: Tween | null = null;

  // ── Hand tool (pan) — v0.5.5 P1 ────────────────────────────────────────
  /** `?handPan` dev flag, read once at construction (default true). */
  private readonly _handPan: boolean = readDevFlags().handPan;

  // ── Wheel / trackpad dolly (P2) ────────────────────────────────────────
  /**
   * `?wheelDolly` dev flag: `true` (default) = the app-owned, refresh-rate-
   * independent log-space dolly below; `false` (`?wheelDolly=legacy`) hands the
   * wheel back to OrbitControls' built-in zoom (the v0.5.4 behaviour). Read once.
   */
  private readonly _wheelDolly: boolean = readDevFlags().wheelDolly === 'default';
  /** Current log-space dolly velocity, integrated each frame by `_stepWheelDolly`. */
  private _dollyVelocity = 0;
  /** Pointer id of the active grab, or null when idle. */
  private _panPointerId: number | null = null;
  /** The grabbed world point `W` — fixed for the whole gesture. */
  private _panGrab: Vec3 = [0, 0, 0];
  /** The locked plane: a point on it and its normal (camera forward). */
  private _panPlanePoint: Vec3 = [0, 0, 0];
  private _panPlaneNormal: Vec3 = [0, 0, 0];
  /** Screen-space fallback state (grazing rays): last client position. */
  private _panFallback = false;
  private _panLastX = 0;
  private _panLastY = 0;
  private _panFallbackDist = 1;
  /** Touch pointers currently down — a 2nd finger hands off to the Viewer's
   *  two-finger recogniser, so the grab cancels itself then. */
  private readonly _panTouches = new Set<number>();
  /** Whether this controller currently owns the canvas cursor. */
  private _ownsCursor = false;
  /** OrbitControls one-finger action saved across the pan-mode remap. */
  private _savedTouchOne: THREE.TOUCH | undefined | null = null;
  private _savedMouseLeft: THREE.MOUSE | undefined | null = null;

  // ── Scratch vectors (reused to avoid per-frame allocation) ─────────────
  private readonly _vForward = new THREE.Vector3();
  private readonly _vHoriz = new THREE.Vector3();
  private readonly _vRight = new THREE.Vector3();
  private readonly _vTmp = new THREE.Vector3();
  private readonly _dollyDir = new THREE.Vector3();
  private readonly _dollyFwd = new THREE.Vector3();

  // Pointer position (NDC) captured on the last wheel event, so the inertial
  // dolly can keep zooming toward where the wheel happened (cursor-centred zoom).
  private _dollyNdcX = 0;
  private _dollyNdcY = 0;
  private _dollyCursorValid = false;

  // Bound listener references, kept so `dispose()` can remove them.
  private readonly _onKeyDown: (e: KeyboardEvent) => void;
  private readonly _onKeyUp: (e: KeyboardEvent) => void;
  private readonly _onCanvasClick: () => void;
  private readonly _onPointerLockChange: () => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onBlur: () => void;
  private readonly _onPanPointerDown: (e: PointerEvent) => void;
  private readonly _onPanPointerMove: (e: PointerEvent) => void;
  private readonly _onPanPointerUp: (e: PointerEvent) => void;
  private readonly _onWheel: (e: WheelEvent) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    controls: OrbitControls,
    callbacks: NavCallbacks = {},
  ) {
    this._camera = camera;
    this._canvas = canvas;
    this._controls = controls;
    this._cb = callbacks;

    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => this._handleKeyUp(e);
    this._onCanvasClick = () => this._handleCanvasClick();
    this._onPointerLockChange = () => this._handlePointerLockChange();
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onBlur = () => this._handleBlur();
    this._onPanPointerDown = (e) => this._handlePanPointerDown(e);
    this._onPanPointerMove = (e) => this._handlePanPointerMove(e);
    this._onPanPointerUp = (e) => this._handlePanPointerUp(e);
    this._onWheel = (e) => this._handleWheel(e);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    canvas.addEventListener('click', this._onCanvasClick);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('pointerdown', this._onPanPointerDown);
    canvas.addEventListener('pointermove', this._onPanPointerMove);
    canvas.addEventListener('pointerup', this._onPanPointerUp);
    canvas.addEventListener('pointercancel', this._onPanPointerUp);
    // Middle-mouse is the temporary grab in ANY mode (program §P1). Take the
    // middle button away from OrbitControls' default drag-dolly so the two
    // handlers can't fight over the same gesture; wheel dolly is unaffected.
    if (this._handPan) {
      this._controls.mouseButtons.MIDDLE = null as unknown as THREE.MOUSE;
    }
    // P2 — take the wheel away from OrbitControls so the app-owned, refresh-rate-
    // independent log-space dolly owns it. Note: the viewer's "orthographic" mode
    // is emulated as a very long lens on THIS same perspective camera (see
    // Viewer.setOrthographic), never a separate OrthographicCamera — so zoom is a
    // dolly in both modes and this one handler covers both. `passive: false` lets
    // `preventDefault` stop the page from scrolling under the canvas.
    if (this._wheelDolly) {
      this._controls.enableZoom = false;
      canvas.addEventListener('wheel', this._onWheel, { passive: false });
    }
    // A held key is released only by `keyup`, which the window receives only
    // while focused. On any focus loss (alt-tab, OS shortcut, switching apps)
    // the `keyup` is dropped, so without this the camera would keep orbiting
    // or moving indefinitely on return. Reset all input when focus is lost.
    window.addEventListener('blur', this._onBlur);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /** The currently active navigation mode. */
  get mode(): NavMode {
    return this._mode;
  }

  /** Whether mouse-look (pointer lock) is currently engaged. */
  get pointerLocked(): boolean {
    return this._locked;
  }

  /**
   * Whether a camera tween (Frame All, Focus, applyPose) is currently
   * advancing. The Viewer's orbit-centre refinement reads this to suspend
   * itself mid-tween — otherwise the refinement lerp would compete with the
   * tween's own target interpolation and produce a perceptible wobble.
   */
  get isTweening(): boolean {
    return this._tween !== null;
  }

  /**
   * Set the world "up" axis. LAS/LAZ surveys are Z-up; phone scans are Y-up —
   * passing the right axis makes walk/fly and the horizon behave correctly.
   */
  setWorldUp(up: THREE.Vector3): void {
    this._worldUp.copy(up).normalize();
    // Build a stable horizontal reference frame perpendicular to up.
    const seed = Math.abs(this._worldUp.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    this._refRight.crossVectors(seed, this._worldUp).normalize();
    this._refForward.crossVectors(this._worldUp, this._refRight).normalize();
  }

  /** Base movement speed in world units per second (set from the cloud size). */
  setBaseSpeed(speed: number): void {
    this._baseSpeed = speed;
  }

  /** User speed multiplier from the speed slider (1 = default). */
  setSpeedMultiplier(multiplier: number): void {
    this._speedMultiplier = Math.max(0.05, multiplier);
  }

  /** Mark that a cloud is loaded — enables the keyboard shortcuts. */
  setHasCloud(hasCloud: boolean): void {
    this._hasCloud = hasCloud;
  }

  /**
   * Enable or disable all navigation input. Disabling freezes the camera so
   * another tool — distance measurement — can own pointer clicks cleanly.
   */
  setInputEnabled(enabled: boolean): void {
    this._inputEnabled = enabled;
    if (!enabled) {
      this._clearMovementKeys();
      this._clearOrbitKeys();
      this._cancelPanGesture();
      this._releaseCursor();
      this._controls.enabled = false;
      this._exitPointerLock();
    } else {
      this._controls.enabled = this._mode === 'orbit' || this._mode === 'pan';
      this._applyIdleCursor();
    }
  }

  /** Switch navigation mode, syncing camera state across the transition. */
  setMode(mode: NavMode): void {
    if (mode === this._mode) return;
    // Pan mode is unreachable when the `?handPan=off` dev flag disabled the
    // hand tool — including programmatic paths (saved sessions, embeds).
    if (mode === 'pan' && !this._handPan) return;
    const previous = this._mode;
    this._mode = mode;
    this._tween = null;
    // Clear all held input across the transition — a movement key held
    // during a mode switch must not carry over as phantom input; an
    // unfinished hand-tool drag must cancel safely, never carry over.
    this._clearMovementKeys();
    this._clearOrbitKeys();
    this._cancelPanGesture();

    // Orbit and pan are both OrbitControls-driven: pan keeps the controls
    // live for wheel dolly and damping, but takes the primary drag away
    // (see `_applyPanInputMap`) so the hand owns it.
    if (mode === 'orbit' || mode === 'pan') {
      if (previous !== 'orbit' && previous !== 'pan') {
        // Hand the camera back to OrbitControls: aim its target a sensible
        // distance ahead of where the camera is currently looking.
        this._syncAnglesFromCamera();
        this._computeForward(this._vForward);
        const dist = this._controls.target.distanceTo(this._camera.position) || this._baseSpeed * 4;
        this._controls.target
          .copy(this._camera.position)
          .addScaledVector(this._vForward, Math.max(dist, 1));
      }
      this._controls.enabled = true;
      this._controls.update();
      this._exitPointerLock();
    } else {
      // Entering walk / fly: derive look angles from the live camera, and
      // take the camera away from OrbitControls.
      if (previous === 'orbit' || previous === 'pan') this._syncAnglesFromCamera();
      this._controls.enabled = false;
    }

    this._applyPanInputMap();
    this._applyIdleCursor();
    this._cb.onModeChange?.(mode);
  }

  /** Whether the hand tool is available (`?handPan` dev flag, default on). */
  get handPanEnabled(): boolean {
    return this._handPan;
  }

  /**
   * Whether a hand-tool grab is live right now (pan-mode primary drag or the
   * middle-mouse temporary grab in any mode). The Viewer's per-frame
   * orbit-centre maintenance reads this to suspend itself — exactly like its
   * `_userInteracting` gate for OrbitControls gestures — so the soft-clamp
   * lerp never fights a live drag.
   */
  get panDragging(): boolean {
    return this._panPointerId !== null;
  }

  /**
   * Smoothly move the camera to `toPos`, looking at `toTarget`, over
   * `duration` seconds with an eased curve. Used for the Frame button,
   * double-click focus, and share-link pose restoration.
   *
   * Default duration bumped 0.6 → 0.8 s in v0.3.6's smoothness pass —
   * matches Google's <model-viewer> default camera transition (~0.8 s),
   * pairs naturally with the lower OrbitControls damping, and gives the
   * cubic-eased curve enough headroom that the start/stop are felt as
   * acceleration, not snaps.
   */
  tweenTo(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration = 0.8): void {
    this._tween = {
      fromPos: this._camera.position.clone(),
      fromTarget: this._currentLookTarget(),
      toPos: toPos.clone(),
      toTarget: toTarget.clone(),
      elapsed: 0,
      duration: Math.max(0.0001, duration),
    };
  }

  /**
   * Focus on a world-space `point`.
   * In orbit mode this recentres the view on the point, keeping the current
   * angle and distance. In walk/fly it flies to a vantage point near it.
   */
  focusOn(point: THREE.Vector3): void {
    if (this._mode === 'orbit' || this._mode === 'pan') {
      const offset = this._vTmp.subVectors(this._camera.position, this._controls.target);
      this.tweenTo(this._vTmp.clone().copy(point).add(offset), point);
    } else {
      this._computeForward(this._vForward);
      const backoff = Math.max(this._baseSpeed * 6, 1);
      const pos = point.clone().addScaledVector(this._vForward, -backoff);
      this.tweenTo(pos, point, 0.8);
    }
  }

  /** Capture the current camera viewpoint, so it can be restored later. */
  getPose(): CameraPose {
    const t = this._currentLookTarget();
    const p = this._camera.position;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  /** Glide the camera to a previously captured viewpoint. */
  applyPose(pose: CameraPose): void {
    this.tweenTo(
      new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
      new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]),
    );
  }

  /** Advance navigation by `dt` seconds. Called once per rendered frame. */
  update(dt: number): void {
    const step = Math.min(Math.max(dt, 0), MAX_DT);

    // Input disabled (e.g. measuring): keep the camera frozen — but still let
    // any in-progress tween finish.
    if (!this._inputEnabled) {
      if (this._tween) this._advanceTween(step);
      return;
    }

    if (this._tween) {
      this._advanceTween(step);
      return;
    }

    if (this._mode === 'orbit' || this._mode === 'pan') {
      // Pan keeps the keyboard orbit and OrbitControls damping/wheel alive;
      // the hand drag itself is event-driven (pointermove), not per-frame.
      this._applyKeyboardOrbit(step);
      // P2 — integrate any in-flight dolly velocity BEFORE `controls.update()`
      // re-reads the pose.
      this._stepWheelDolly(step);
      this._controls.update();
      return;
    }

    // Walk / fly: integrate velocity, then orient the camera.
    this._computeForward(this._vForward);
    this._vHoriz.copy(this._refForward)
      .multiplyScalar(Math.cos(this._yaw))
      .addScaledVector(this._refRight, Math.sin(this._yaw));
    this._vRight.crossVectors(this._vHoriz, this._worldUp).normalize();

    const moveForward = this._mode === 'fly' ? this._vForward : this._vHoriz;
    const speed = this._baseSpeed * this._speedMultiplier * (this._sprint ? SPRINT : 1);
    const target = desiredVelocity(
      this._keys,
      [moveForward.x, moveForward.y, moveForward.z],
      [this._vRight.x, this._vRight.y, this._vRight.z],
      [this._worldUp.x, this._worldUp.y, this._worldUp.z],
      speed,
    );
    this._velocity = smoothVelocity(this._velocity, target, step);

    this._camera.position.x += this._velocity[0] * step;
    this._camera.position.y += this._velocity[1] * step;
    this._camera.position.z += this._velocity[2] * step;

    this._applyOrientation();
  }

  // ── P2 wheel / trackpad dolly ──────────────────────────────────────────

  /**
   * Wheel handler: accumulate a log-space dolly impulse. The maths is in
   * `wheelDollyMath` (unit-tested); this only feeds it. Runs only while
   * OrbitControls is enabled (orbit / pan), so it never fights a modal tool.
   * Sign: a positive `deltaY` (scroll down) grows the eye distance → zoom OUT.
   * The viewer's "ortho" mode is a narrow-FOV perspective camera on this same
   * object, so the dolly is the correct zoom in both modes.
   */
  private _handleWheel(e: WheelEvent): void {
    if (!this._wheelDolly || !this._inputEnabled || !this._controls.enabled) return;
    // P9 — wheel ownership: only dolly events that belong to the interactive
    // viewport (the canvas itself). A wheel over a panel targets the panel and
    // must never reach the camera; panels also stop propagation, so this is a
    // defensive second gate that stays correct if the listener ever moves to a
    // container.
    const target = e.target as Node | null;
    if (target !== this._canvas && !(target !== null && this._canvas.contains(target))) return;
    if (this._mode !== 'orbit' && this._mode !== 'pan') return;
    e.preventDefault();
    // Capture the pointer in NDC so the cursor-centred dolly keeps driving toward
    // where the wheel happened for the whole inertial tail, not just this frame.
    const w = Math.max(1, this._canvas.clientWidth);
    const h = Math.max(1, this._canvas.clientHeight);
    this._dollyNdcX = (e.offsetX / w) * 2 - 1;
    this._dollyNdcY = -(e.offsetY / h) * 2 + 1;
    this._dollyCursorValid = true;
    const px = normalizeWheelDeltaPx(
      e.deltaY,
      e.deltaMode,
      WHEEL_LINE_HEIGHT_PX,
      window.innerHeight || 800,
    );
    this._dollyVelocity = applyWheelImpulse(
      this._dollyVelocity,
      px,
      WHEEL_SENSITIVITY,
      MAX_DOLLY_VELOCITY,
    );
  }

  /**
   * Integrate the dolly velocity for one frame: scale the camera↔target distance
   * by `exp(velocity · dt)`, clamped to OrbitControls' own min/max distance so
   * the app-owned dolly can never punch past the limits the rest of the app
   * relies on. When the pointer is known (a wheel event captured it), the zoom
   * is cursor-centred — the world point under the pointer stays fixed — matching
   * OrbitControls' `zoomToCursor`, which the legacy wheel path still uses. Falls
   * back to a target pivot when no pointer is known. No-op once velocity settles.
   */
  private _stepWheelDolly(dt: number): void {
    if (!this._wheelDolly || isDollySettled(this._dollyVelocity)) return;
    const s = stepDolly(this._dollyVelocity, dt, WHEEL_FRICTION);
    this._dollyVelocity = s.velocity;
    if (s.scale === 1) return;
    const target = this._controls.target;
    const offset = this._vTmp.subVectors(this._camera.position, target);
    const dist = offset.length();
    if (!(dist > 1e-6)) return;
    let next = dist * s.scale;
    const min = this._controls.minDistance;
    const max = this._controls.maxDistance;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);

    // Cursor-centred zoom: translate the camera along the world ray through the
    // captured pointer position by the change in radius, then re-seat the target
    // along the (unchanged) view direction at the new radius. This keeps the
    // world point under the pointer stationary — the OrbitControls zoomToCursor
    // behaviour. Falls back to the target pivot when no pointer is known (e.g. a
    // keyboard-driven step) or the ray degenerates.
    if (this._dollyCursorValid) {
      this._camera.updateMatrixWorld();
      const dir = this._dollyDir
        .set(this._dollyNdcX, this._dollyNdcY, 0.5)
        .unproject(this._camera)
        .sub(this._camera.position);
      const len = dir.length();
      if (len > 1e-6) {
        dir.multiplyScalar(1 / len);
        const forward = this._dollyFwd.copy(offset).multiplyScalar(-1 / dist);
        this._camera.position.addScaledVector(dir, dist - next);
        target.copy(this._camera.position).addScaledVector(forward, next);
        return;
      }
    }

    // Fallback — target pivot.
    offset.multiplyScalar(next / dist);
    this._camera.position.copy(target).add(offset);
  }

  /** Remove every event listener. Call when tearing the viewer down. */
  dispose(): void {
    this._cancelPanGesture();
    this._releaseCursor();
    this._canvas.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._canvas.removeEventListener('click', this._onCanvasClick);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('blur', this._onBlur);
    this._canvas.removeEventListener('pointerdown', this._onPanPointerDown);
    this._canvas.removeEventListener('pointermove', this._onPanPointerMove);
    this._canvas.removeEventListener('pointerup', this._onPanPointerUp);
    this._canvas.removeEventListener('pointercancel', this._onPanPointerUp);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Camera maths
  // ─────────────────────────────────────────────────────────────────────────

  /** Write the current look direction (yaw + pitch) into `out`. */
  private _computeForward(out: THREE.Vector3): void {
    // Horizontal heading from yaw, then tilt by pitch toward world-up.
    this._vHoriz.copy(this._refForward)
      .multiplyScalar(Math.cos(this._yaw))
      .addScaledVector(this._refRight, Math.sin(this._yaw));
    out.copy(this._vHoriz)
      .multiplyScalar(Math.cos(this._pitch))
      .addScaledVector(this._worldUp, Math.sin(this._pitch))
      .normalize();
  }

  /** Point the camera along the current yaw/pitch. */
  private _applyOrientation(): void {
    this._computeForward(this._vForward);
    this._camera.up.copy(this._worldUp);
    this._vTmp.copy(this._camera.position).add(this._vForward);
    this._camera.lookAt(this._vTmp);
  }

  /** Derive yaw/pitch from the camera's current world direction. */
  private _syncAnglesFromCamera(): void {
    this._camera.getWorldDirection(this._vForward);
    const dotUp = THREE.MathUtils.clamp(this._vForward.dot(this._worldUp), -1, 1);
    this._pitch = Math.asin(dotUp);
    // Horizontal component of the look direction.
    this._vHoriz.copy(this._vForward).addScaledVector(this._worldUp, -dotUp);
    if (this._vHoriz.lengthSq() > 1e-9) {
      this._vHoriz.normalize();
      this._yaw = Math.atan2(
        this._vHoriz.dot(this._refRight),
        this._vHoriz.dot(this._refForward),
      );
    }
  }

  /** The point the camera is currently looking at (for tween start state). */
  private _currentLookTarget(): THREE.Vector3 {
    if (this._mode === 'orbit' || this._mode === 'pan') return this._controls.target.clone();
    this._computeForward(this._vForward);
    return this._camera.position.clone().add(this._vForward);
  }

  private _advanceTween(dt: number): void {
    const tw = this._tween;
    if (!tw) return;
    tw.elapsed += dt;
    const e = easeInOutCubic(tw.elapsed / tw.duration);

    this._camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    this._vTmp.lerpVectors(tw.fromTarget, tw.toTarget, e);
    this._camera.up.copy(this._worldUp);
    this._camera.lookAt(this._vTmp);

    if (tw.elapsed >= tw.duration) {
      this._tween = null;
      if (this._mode === 'orbit' || this._mode === 'pan') {
        this._controls.target.copy(tw.toTarget);
        this._controls.enabled = true;
        this._controls.update();
      } else {
        this._syncAnglesFromCamera();
      }
    }
  }

  /**
   * Arrow-key orbit: yaw and pitch the camera around the OrbitControls target,
   * preserving distance. The angular velocity is eased toward the key-driven
   * target (frame-rate independent), so a tap nudges the view and a hold
   * glides — then settles smoothly when the key is released. Mouse orbit,
   * panning and zoom are untouched.
   */
  private _applyKeyboardOrbit(step: number): void {
    const targetYaw =
      ((this._orbitKeys.left ? 1 : 0) - (this._orbitKeys.right ? 1 : 0)) *
      ORBIT_KEY_SPEED;
    const targetPitch =
      ((this._orbitKeys.up ? 1 : 0) - (this._orbitKeys.down ? 1 : 0)) *
      ORBIT_KEY_SPEED;
    this._orbitVel = smoothVelocity(
      this._orbitVel,
      [targetYaw, targetPitch, 0],
      step,
      8,
    );

    const yaw = this._orbitVel[0] * step;
    const pitch = this._orbitVel[1] * step;
    if (Math.abs(yaw) < 1e-6 && Math.abs(pitch) < 1e-6) return;

    const t = this._controls.target;
    const rotated = orbitOffset(
      [
        this._camera.position.x - t.x,
        this._camera.position.y - t.y,
        this._camera.position.z - t.z,
      ],
      [this._worldUp.x, this._worldUp.y, this._worldUp.z],
      yaw,
      pitch,
    );
    this._camera.position.set(t.x + rotated[0], t.y + rotated[1], t.z + rotated[2]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input handling
  // ─────────────────────────────────────────────────────────────────────────

  private _handleKeyDown(e: KeyboardEvent): void {
    // Never steal keys while the user is typing in a form control.
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (!this._hasCloud || !this._inputEnabled) return;

    // Mode + shortcut keys work in any mode. Digit4 joins the Digit1/2/3
    // group and G toggles the hand tool from anywhere; both are inert when
    // `?handPan=off` disabled the tool (panModeForKey returns null then).
    switch (e.code) {
      case 'Digit1': this.setMode('orbit'); return;
      case 'Digit2': this.setMode('walk'); return;
      case 'Digit3': this.setMode('fly'); return;
      case 'KeyR': this._cb.onReset?.(); return;
      case 'KeyF': this._cb.onFocusCenter?.(); return;
      case 'KeyH': this._cb.onToggleHelp?.(); return;
      case 'Digit4':
      case 'KeyG': {
        const next = panModeForKey(e.code, this._mode, this._handPan);
        if (next) this.setMode(next);
        return;
      }
    }

    if (this._mode === 'orbit' || this._mode === 'pan') {
      // Arrow keys orbit the camera; WASD and the rest stay inert in orbit.
      if (this._setOrbitKey(e.code, true)) {
        this._tween = null; // a keyboard orbit cancels an in-progress tween
        e.preventDefault();
      }
      return;
    }

    if (this._setMovementKey(e.code, true)) {
      this._tween = null; // a movement key cancels an in-progress tween
      e.preventDefault();
    }
  }

  private _handleKeyUp(e: KeyboardEvent): void {
    this._setMovementKey(e.code, false);
    this._setOrbitKey(e.code, false);
  }

  /** Apply a key code to the movement state; returns true if it was a nav key. */
  private _setMovementKey(code: string, pressed: boolean): boolean {
    switch (code) {
      case 'KeyW': case 'ArrowUp': this._keys.forward = pressed; return true;
      case 'KeyS': case 'ArrowDown': this._keys.backward = pressed; return true;
      case 'KeyA': case 'ArrowLeft': this._keys.left = pressed; return true;
      case 'KeyD': case 'ArrowRight': this._keys.right = pressed; return true;
      case 'Space': this._keys.up = pressed; return true;
      case 'KeyC': case 'ControlLeft': this._keys.down = pressed; return true;
      case 'ShiftLeft': case 'ShiftRight': this._sprint = pressed; return true;
      default: return false;
    }
  }

  /**
   * Apply a key code to the keyboard-orbit state; returns true if it was an
   * orbit key (the four arrows, used to orbit the camera in orbit mode).
   */
  private _setOrbitKey(code: string, pressed: boolean): boolean {
    switch (code) {
      case 'ArrowLeft': this._orbitKeys.left = pressed; return true;
      case 'ArrowRight': this._orbitKeys.right = pressed; return true;
      case 'ArrowUp': this._orbitKeys.up = pressed; return true;
      case 'ArrowDown': this._orbitKeys.down = pressed; return true;
      default: return false;
    }
  }

  /** Release every keyboard-orbit key and zero its eased velocity. */
  private _clearOrbitKeys(): void {
    this._orbitKeys.left = false;
    this._orbitKeys.right = false;
    this._orbitKeys.up = false;
    this._orbitKeys.down = false;
    this._orbitVel = [0, 0, 0];
  }

  /** Release every movement / sprint key and zero the walk-fly velocity. */
  private _clearMovementKeys(): void {
    this._keys.forward = false;
    this._keys.backward = false;
    this._keys.left = false;
    this._keys.right = false;
    this._keys.up = false;
    this._keys.down = false;
    this._sprint = false;
    this._velocity = [0, 0, 0];
  }

  /**
   * Focus-loss reset: drop every held key so a lost `keyup` can't strand the
   * camera in a continuous orbit or walk. Safe to call at any time.
   */
  private _handleBlur(): void {
    this._clearMovementKeys();
    this._clearOrbitKeys();
    // A grab in flight when focus is lost would never see its pointerup —
    // cancel it (and restore the idle cursor) rather than strand it.
    this._cancelPanGesture();
  }

  private _handleCanvasClick(): void {
    if (!this._inputEnabled) return;
    if ((this._mode === 'walk' || this._mode === 'fly') && !this._locked) {
      void this._canvas.requestPointerLock();
    }
  }

  private _handlePointerLockChange(): void {
    const wasLocked = this._locked;
    this._locked = document.pointerLockElement === this._canvas;
    // Mouse-look just ended (Esc, OS app-switch). Stop any walk/fly motion so
    // the camera doesn't keep drifting while the pointer is free.
    if (wasLocked && !this._locked) this._clearMovementKeys();
    this._cb.onPointerLockChange?.(this._locked);
  }

  private _exitPointerLock(): void {
    if (document.pointerLockElement === this._canvas) document.exitPointerLock();
  }

  private _handleMouseMove(e: MouseEvent): void {
    if (!this._locked) return;
    // Mouse right → look right, mouse left → look left.
    this._yaw += e.movementX * LOOK_SENSITIVITY;
    this._pitch -= e.movementY * LOOK_SENSITIVITY;
    this._pitch = THREE.MathUtils.clamp(this._pitch, -MAX_PITCH, MAX_PITCH);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hand tool — grab and drag the whole scene (v0.5.5 P1)
  //
  // The geometry lives in panMath.ts (pure, unit-tested): at pointer-down a
  // plane through the orbit target, normal along camera forward, is locked;
  // every move re-intersects the pointer ray with THAT plane and translates
  // camera + target by (grab − hit). Orientation and camera-target distance
  // are preserved exactly, and the grabbed point stays under the pointer.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * In pan mode, take the primary mouse drag and the one-finger touch away
   * from OrbitControls (rotate) so the hand owns them; wheel keeps dollying
   * through the still-enabled controls. Leaving pan restores the exact
   * previous mappings — including the Viewer's custom touch model, where the
   * two-finger recogniser owns TWO and OrbitControls only ever sees ONE.
   */
  private _applyPanInputMap(): void {
    const buttons = this._controls.mouseButtons as { LEFT: THREE.MOUSE | null };
    const touches = this._controls.touches as { ONE: THREE.TOUCH | null };
    if (this._mode === 'pan') {
      if (this._savedMouseLeft === null) this._savedMouseLeft = buttons.LEFT ?? undefined;
      if (this._savedTouchOne === null) this._savedTouchOne = touches.ONE ?? undefined;
      buttons.LEFT = null;
      touches.ONE = null;
    } else {
      if (this._savedMouseLeft !== null) {
        buttons.LEFT = this._savedMouseLeft ?? null;
        this._savedMouseLeft = null;
      }
      if (this._savedTouchOne !== null) {
        touches.ONE = this._savedTouchOne ?? null;
        this._savedTouchOne = null;
      }
    }
  }

  /** The idle cursor this controller owns: an open hand in pan mode. */
  private _applyIdleCursor(): void {
    if (this._mode === 'pan' && this._inputEnabled) {
      this._canvas.style.cursor = 'grab';
      this._ownsCursor = true;
    } else {
      this._releaseCursor();
    }
  }

  /** Clear the canvas cursor, but only if this controller set it. */
  private _releaseCursor(): void {
    if (!this._ownsCursor) return;
    this._canvas.style.cursor = '';
    this._ownsCursor = false;
  }

  private _handlePanPointerDown(e: PointerEvent): void {
    // Track touch count regardless of eligibility — the count itself is an
    // input to it (a second finger belongs to the two-finger recogniser).
    if (e.pointerType === 'touch') this._panTouches.add(e.pointerId);
    if (!this._inputEnabled || this._locked) return;
    // A second finger while a one-finger grab is live: hand off cleanly.
    if (e.pointerType === 'touch' && this._panTouches.size > 1) {
      this._cancelPanGesture();
      return;
    }
    if (this._panPointerId !== null) return; // one grab at a time
    const kind = panGestureKind({
      button: e.button,
      pointerType: e.pointerType,
      mode: this._mode,
      handPanEnabled: this._handPan,
      activeTouchCount: this._panTouches.size,
    });
    if (!kind) return;
    // Middle-click autoscroll / paste must not race the grab.
    if (e.button === 1) e.preventDefault();

    // Lock the plane: through the orbit target, normal = camera forward.
    // In walk/fly (temporary grab) the stale orbit target still gives a
    // sensible grab depth; the fallback distance guards the degenerate case.
    this._camera.updateMatrixWorld();
    this._camera.getWorldDirection(this._vForward);
    const t = this._controls.target;
    this._panPlanePoint = [t.x, t.y, t.z];
    this._panPlaneNormal = [this._vForward.x, this._vForward.y, this._vForward.z];
    this._panFallbackDist = Math.max(this._camera.position.distanceTo(t), 1e-6);
    this._panLastX = e.clientX;
    this._panLastY = e.clientY;

    const grab = this._panRayHit(e);
    if (grab) {
      this._panGrab = grab;
      this._panFallback = false;
    } else {
      // Grazing / degenerate at pointer-down — run the whole gesture on the
      // screen-space model (world-units-per-pixel at target distance).
      this._panFallback = true;
    }

    this._panPointerId = e.pointerId;
    try {
      this._canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone (device quirk) — the gesture will
      // simply end with the naturally delivered pointerup.
    }
    this._canvas.style.cursor = 'grabbing';
    this._ownsCursor = true;
    this._tween = null; // grabbing the scene cancels an in-flight tween
  }

  private _handlePanPointerMove(e: PointerEvent): void {
    if (this._panPointerId !== e.pointerId) return;
    if (!this._inputEnabled) {
      this._cancelPanGesture();
      return;
    }
    let delta: Vec3 | null = null;
    if (!this._panFallback) {
      this._camera.updateMatrixWorld();
      const dir = this._panRayDir(e);
      const p = this._camera.position;
      delta = panPlaneDelta(
        [p.x, p.y, p.z],
        dir,
        this._panGrab,
        this._panPlanePoint,
        this._panPlaneNormal,
      );
    }
    if (!delta) {
      // Screen-space fallback: camera right/up straight from the matrix.
      const m = this._camera.matrix.elements;
      delta = screenPanDelta(
        e.clientX - this._panLastX,
        e.clientY - this._panLastY,
        Math.max(1, this._canvas.clientHeight),
        this._camera.fov,
        this._panFallbackDist,
        [m[0], m[1], m[2]],
        [m[4], m[5], m[6]],
      );
    }
    this._panLastX = e.clientX;
    this._panLastY = e.clientY;
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return;
    // Translate camera AND target by the same world vector — distance and
    // orientation preserved exactly; then let OrbitControls re-read its
    // spherical state so damping resumes from the new pose.
    this._camera.position.x += delta[0];
    this._camera.position.y += delta[1];
    this._camera.position.z += delta[2];
    this._controls.target.x += delta[0];
    this._controls.target.y += delta[1];
    this._controls.target.z += delta[2];
    if (this._controls.enabled) this._controls.update();
  }

  private _handlePanPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._panTouches.delete(e.pointerId);
    if (this._panPointerId !== e.pointerId) return;
    this._endPanGesture();
  }

  /** End the active grab: release capture and restore the idle cursor. */
  private _endPanGesture(): void {
    if (this._panPointerId === null) return;
    try {
      this._canvas.releasePointerCapture(this._panPointerId);
    } catch {
      // Already released — ignore.
    }
    this._panPointerId = null;
    this._panFallback = false;
    this._applyIdleCursor();
  }

  /**
   * Cancel an unfinished grab safely — mode change, tool activation, focus
   * loss, or a second finger. The camera simply stays where the last applied
   * step left it (the drag is direct 1:1 — there is no inertia in P1).
   */
  private _cancelPanGesture(): void {
    this._endPanGesture();
  }

  /** The pointer's world-space ray direction (normalized). */
  private _panRayDir(e: PointerEvent): Vec3 {
    const w = Math.max(1, this._canvas.clientWidth);
    const h = Math.max(1, this._canvas.clientHeight);
    const ndcX = (e.offsetX / w) * 2 - 1;
    const ndcY = -(e.offsetY / h) * 2 + 1;
    this._vTmp.set(ndcX, ndcY, 0.5).unproject(this._camera).sub(this._camera.position).normalize();
    return [this._vTmp.x, this._vTmp.y, this._vTmp.z];
  }

  /** Intersect the pointer ray with the locked plane, or null when grazing. */
  private _panRayHit(e: PointerEvent): Vec3 | null {
    const dir = this._panRayDir(e);
    const p = this._camera.position;
    return intersectRayPlane([p.x, p.y, p.z], dir, this._panPlanePoint, this._panPlaneNormal);
  }
}
