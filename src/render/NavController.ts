/**
 * NavController.ts
 *
 * Game-style camera navigation for the viewer: three modes (orbit, walk, fly),
 * WASD movement, pointer-lock mouse-look, sprint, and eased camera tweens for
 * smooth framing and focus.
 *
 * Design:
 *  - **Orbit** — the default. OrbitControls drives the camera; the mouse
 *    rotates / pans / zooms around a target.
 *  - **Walk** — first-person. WASD moves on the horizontal plane (you keep
 *    your height); Space / C change height deliberately.
 *  - **Fly** — free 6-DOF. WASD moves along the look direction, so you fly
 *    wherever you point; Space / C still nudge straight up / down.
 *
 * The movement maths lives in `navMath.ts` (pure, unit-tested). This file
 * owns the browser-bound parts: input listeners, pointer lock, and applying
 * the result to a three.js camera. Like `Viewer.ts`, it must not be imported
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
} from './navMath';
import type { Vec3 } from './navMath';

/** The three navigation modes. */
export type NavMode = 'orbit' | 'walk' | 'fly';

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

  // ── Pointer lock ───────────────────────────────────────────────────────
  private _locked = false;

  // ── Camera tween ───────────────────────────────────────────────────────
  private _tween: Tween | null = null;

  // ── Scratch vectors (reused to avoid per-frame allocation) ─────────────
  private readonly _vForward = new THREE.Vector3();
  private readonly _vHoriz = new THREE.Vector3();
  private readonly _vRight = new THREE.Vector3();
  private readonly _vTmp = new THREE.Vector3();

  // Bound listener references, kept so `dispose()` can remove them.
  private readonly _onKeyDown: (e: KeyboardEvent) => void;
  private readonly _onKeyUp: (e: KeyboardEvent) => void;
  private readonly _onCanvasClick: () => void;
  private readonly _onPointerLockChange: () => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;

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

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    canvas.addEventListener('click', this._onCanvasClick);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
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

  /** Switch navigation mode, syncing camera state across the transition. */
  setMode(mode: NavMode): void {
    if (mode === this._mode) return;
    const previous = this._mode;
    this._mode = mode;
    this._tween = null;
    this._velocity = [0, 0, 0];

    if (mode === 'orbit') {
      // Hand the camera back to OrbitControls: aim its target a sensible
      // distance ahead of where the camera is currently looking.
      this._syncAnglesFromCamera();
      this._computeForward(this._vForward);
      const dist = this._controls.target.distanceTo(this._camera.position) || this._baseSpeed * 4;
      this._controls.target
        .copy(this._camera.position)
        .addScaledVector(this._vForward, Math.max(dist, 1));
      this._controls.enabled = true;
      this._controls.update();
      this._exitPointerLock();
    } else {
      // Entering walk / fly: derive look angles from the live camera, and
      // take the camera away from OrbitControls.
      if (previous === 'orbit') this._syncAnglesFromCamera();
      this._controls.enabled = false;
    }

    this._cb.onModeChange?.(mode);
  }

  /**
   * Smoothly move the camera to `toPos`, looking at `toTarget`, over
   * `duration` seconds with an eased curve. Used for the Frame button and
   * double-click focus.
   */
  tweenTo(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration = 0.6): void {
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
    if (this._mode === 'orbit') {
      const offset = this._vTmp.subVectors(this._camera.position, this._controls.target);
      this.tweenTo(this._vTmp.clone().copy(point).add(offset), point);
    } else {
      this._computeForward(this._vForward);
      const backoff = Math.max(this._baseSpeed * 6, 1);
      const pos = point.clone().addScaledVector(this._vForward, -backoff);
      this.tweenTo(pos, point, 0.7);
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

    if (this._tween) {
      this._advanceTween(step);
      return;
    }

    if (this._mode === 'orbit') {
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

  /** Remove every event listener. Call when tearing the viewer down. */
  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._canvas.removeEventListener('click', this._onCanvasClick);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
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
    if (this._mode === 'orbit') return this._controls.target.clone();
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
      if (this._mode === 'orbit') {
        this._controls.target.copy(tw.toTarget);
        this._controls.enabled = true;
        this._controls.update();
      } else {
        this._syncAnglesFromCamera();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input handling
  // ─────────────────────────────────────────────────────────────────────────

  private _handleKeyDown(e: KeyboardEvent): void {
    // Never steal keys while the user is typing in a form control.
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (!this._hasCloud) return;

    // Mode + shortcut keys work in any mode.
    switch (e.code) {
      case 'Digit1': this.setMode('orbit'); return;
      case 'Digit2': this.setMode('walk'); return;
      case 'Digit3': this.setMode('fly'); return;
      case 'KeyR': this._cb.onReset?.(); return;
      case 'KeyF': this._cb.onFocusCenter?.(); return;
      case 'KeyH': this._cb.onToggleHelp?.(); return;
    }

    if (this._mode === 'orbit') return; // movement keys are inert in orbit

    if (this._setMovementKey(e.code, true)) {
      this._tween = null; // a movement key cancels an in-progress tween
      e.preventDefault();
    }
  }

  private _handleKeyUp(e: KeyboardEvent): void {
    this._setMovementKey(e.code, false);
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

  private _handleCanvasClick(): void {
    if ((this._mode === 'walk' || this._mode === 'fly') && !this._locked) {
      void this._canvas.requestPointerLock();
    }
  }

  private _handlePointerLockChange(): void {
    this._locked = document.pointerLockElement === this._canvas;
    this._cb.onPointerLockChange?.(this._locked);
  }

  private _exitPointerLock(): void {
    if (document.pointerLockElement === this._canvas) document.exitPointerLock();
  }

  private _handleMouseMove(e: MouseEvent): void {
    if (!this._locked) return;
    this._yaw -= e.movementX * LOOK_SENSITIVITY;
    this._pitch -= e.movementY * LOOK_SENSITIVITY;
    this._pitch = THREE.MathUtils.clamp(this._pitch, -MAX_PITCH, MAX_PITCH);
  }
}
