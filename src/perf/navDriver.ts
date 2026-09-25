/**
 * The `?benchmark=nav` camera driver: `window.__olvNavDriver`.
 *
 * Plays a scripted trajectory (`navTrajectories.ts`) by dispatching synthetic
 * pointer, wheel and keyboard events on the viewer canvas, so the input runs
 * through the production navigation listeners. It advances one nominal 60 Hz
 * step-clock frame per real animation frame: the input sequence is the same
 * on every run while frame timing stays real. The navigation probe's window
 * listeners record each dispatched event's `timeStamp` in its input ring.
 *
 * Navigation integrates time-based damping, wheel inertia and keyboard orbit
 * over the frame clock's delta, so the pose a trajectory ends at depends on
 * real frame timing. `fixedStep: true` makes the driver own navigation's
 * clock for the run: each step-clock frame queues one 1/60 s step, and the
 * render loop integrates exactly the queued steps (`stepNav`), so input and
 * integration interleave identically on every run. The replay check uses it.
 * Frame recording and adaptive quality keep the real delta either way.
 *
 * Before the first step and after the last one the driver waits for the
 * camera to come to rest, and hashes the pose at both ends. At rest means
 * {@link SETTLE_UPDATES} consecutive navigation updates that each moved the
 * camera position and target by at most {@link REST_REL_TOL} times the scene
 * scale and turned the view and up directions by at most
 * {@link REST_ANGLE_TOL} rad. The scene scale is the bounds diagonal the
 * caller passes, else the camera-to-target distance of the first reported
 * pose (the framed view). It counts navigation updates, not animation frames,
 * because a loop at rest updates navigation only on its idle heartbeat; the
 * wait gives up after {@link MAX_SETTLE_UPDATES} updates or
 * {@link MAX_SETTLE_WAIT_FRAMES} animation frames.
 */
import { canonicalJson } from '../canonicalHash';
import { sha256Hex } from '../terrain/export/sha256';
import type { NavDriveSink } from './navProbeHook';
import {
  buildTrajectory,
  NAV_TRAJECTORY_NAMES,
  stepFrame,
  trajectoryDigest,
  type NavSceneHint,
  type NavStep,
  type NavTrajectoryName,
} from './navTrajectories';

/** Mirrors `NAV_DRIVE_SLOT` in navProbeHook.ts; a value import would put that module in a shared chunk. */
export const DRIVE_SLOT = '__olvNavDrive';

/** The fixed navigation step, in seconds. */
export const FIXED_NAV_DT_SEC = 1 / 60;
/** Consecutive navigation updates within tolerance that count as at rest. */
export const SETTLE_UPDATES = 10;
/** Upper bound on the navigation updates spent waiting for rest. */
export const MAX_SETTLE_UPDATES = 600;
/** Upper bound on the animation frames spent waiting for rest (30 s at 60 Hz). */
export const MAX_SETTLE_WAIT_FRAMES = 1800;
/** Upper bound on the frames a step waits for queued fixed steps to integrate. */
export const MAX_STEP_WAIT_FRAMES = 600;
/** Position tolerance per update, as a fraction of the scene scale. */
export const REST_REL_TOL = 1e-6;
/** Direction tolerance per update, in radians. */
export const REST_ANGLE_TOL = 1e-7;

/** The canvas surface the driver needs. */
export interface NavDriverCanvas {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  dispatchEvent(e: Event): boolean;
  setPointerCapture?(id: number): void;
}

/** Host services, injectable so the sequencing is testable without a browser. */
export interface NavDriverEnv {
  canvas(): NavDriverCanvas | null;
  /** Keyboard events go here (the navigation key listeners are on the window). */
  keyTarget: { dispatchEvent(e: Event): boolean };
  raf(cb: () => void): void;
  /** Build the DOM event for a step at client coordinates. */
  makeEvent(step: NavStep, clientX: number, clientY: number, buttons: number, type: string): Event;
  /** The global the drive slot lives on. */
  slots: Record<string, unknown>;
}

export interface NavDriveOptions {
  fixedStep?: boolean;
  hint?: NavSceneHint;
  /** Scene bounds diagonal, in world units, for the rest tolerance. */
  sceneDiagonal?: number;
}

export interface NavDriveResult {
  name: NavTrajectoryName;
  trajectoryDigest: string;
  /** Pose digest at rest before the first step. */
  startCameraDigest: string;
  finalCameraDigest: string;
  steps: number;
  /** Animation frames from the first step to the settled end. */
  frames: number;
  fixedStep: boolean;
  settled: boolean;
  /** Where a run that did not settle stopped waiting: at rest before input, during input, or at the end. */
  unsettledAt: 'start' | 'input' | 'end' | null;
}

/** Round a pose component to 1e-6 (and fold -0 into 0) for hashing. */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

/** SHA-256 (hex) of a camera pose rounded to 1e-6. */
export function cameraDigest(position: readonly number[], target: readonly number[], up: readonly number[]): string {
  const pose = { position: position.map(round6), target: target.map(round6), up: up.map(round6) };
  return sha256Hex(new TextEncoder().encode(canonicalJson(pose)));
}

/** The DOM event types one step dispatches. */
function eventTypes(step: NavStep): string[] {
  if (step.kind !== 'key') return [step.kind];
  return [step.key.endsWith(':up') ? 'keyup' : 'keydown'];
}

/** Browser event construction for {@link NavDriverEnv.makeEvent}. */
export function makeDomEvent(step: NavStep, clientX: number, clientY: number, buttons: number, type: string): Event {
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
  if (step.kind === 'wheel') return new WheelEvent(type, { ...base, deltaY: step.deltaY, deltaMode: 0, buttons });
  if (step.kind === 'key') {
    const code = step.key.slice(0, step.key.lastIndexOf(':'));
    return new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: code });
  }
  return new PointerEvent(type, {
    ...base, button: step.button, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  });
}

type Vec3 = readonly number[];

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Angle between two vectors in radians (0 when either is zero-length). */
export function angleBetween(a: Vec3, b: Vec3): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = Math.hypot(cx, cy, cz);
  return cross === 0 && dot >= 0 ? 0 : Math.atan2(cross, dot);
}

/** A reported pose. */
interface Pose { position: Vec3; target: Vec3; up: Vec3 }

/** Whether `b` is within the rest tolerance of `a` for a scene of scale `scale`. */
export function withinRest(a: Pose, b: Pose, scale: number): boolean {
  const tol = REST_REL_TOL * scale;
  if (dist(a.position, b.position) > tol || dist(a.target, b.target) > tol) return false;
  const dirA = [a.target[0] - a.position[0], a.target[1] - a.position[1], a.target[2] - a.position[2]];
  const dirB = [b.target[0] - b.position[0], b.target[1] - b.position[1], b.target[2] - b.position[2]];
  return angleBetween(dirA, dirB) <= REST_ANGLE_TOL && angleBetween(a.up, b.up) <= REST_ANGLE_TOL;
}

/** Per-run driver state shared with the sink. */
interface DriveState {
  readonly fixed: boolean;
  /** Fixed-step mode: steps queued and not yet integrated. */
  owed: number;
  /** Digest of the last reported pose. */
  pose: string;
  /** The last reported pose, for the rest check. */
  last: Pose | null;
  /** Scene scale for the rest tolerance; 0 until known. */
  scale: number;
  /** Navigation updates reported so far. */
  updates: number;
  /** Consecutive updates within the rest tolerance. */
  stable: number;
}

export class NavDriver {
  private _busy = false;
  private readonly env: NavDriverEnv;

  constructor(env: NavDriverEnv) {
    this.env = env;
  }

  get busy(): boolean {
    return this._busy;
  }

  /** Play a trajectory and resolve with its digests once the camera settles. */
  async run(name: NavTrajectoryName, options: NavDriveOptions = {}): Promise<NavDriveResult> {
    if (!NAV_TRAJECTORY_NAMES.includes(name)) throw new Error(`unknown trajectory: ${String(name)}`);
    if (this._busy) throw new Error('a trajectory is already playing');
    const canvas = this.env.canvas();
    if (!canvas) throw new Error('no viewer canvas');
    const steps = buildTrajectory(name, options.hint);
    const fixedStep = options.fixedStep === true;
    const diag = options.sceneDiagonal;
    const st: DriveState = {
      fixed: fixedStep, owed: 0, pose: '', last: null, updates: 0, stable: 0,
      scale: diag !== undefined && Number.isFinite(diag) && diag > 0 ? diag : 0,
    };
    const sink: NavDriveSink = {
      fixedDtSec: fixedStep ? FIXED_NAV_DT_SEC : null,
      takeSteps: () => {
        const n = st.owed;
        st.owed = 0;
        return n;
      },
      pose: (p, t, u) => {
        const cur: Pose = { position: [...p], target: [...t], up: [...u] };
        if (st.scale === 0) st.scale = dist(cur.position, cur.target);
        st.stable = st.last !== null && withinRest(st.last, cur, st.scale) ? st.stable + 1 : 0;
        st.last = cur;
        st.updates++;
        st.pose = cameraDigest(p, t, u);
      },
    };
    this._busy = true;
    const slots = this.env.slots;
    slots[DRIVE_SLOT] = sink;
    // A synthetic pointer is not an active pointer, so capturing it throws;
    // the drag works without capture because every move targets the canvas.
    const capture = canvas.setPointerCapture;
    const ownCapture = Object.prototype.hasOwnProperty.call(canvas, 'setPointerCapture');
    if (capture) {
      canvas.setPointerCapture = (id: number) => {
        try { capture.call(canvas, id); } catch { /* synthetic pointer */ }
      };
    }
    try {
      // Start from rest, so a load's closing glide is not part of the run.
      const before = await this._settle(st);
      const start = st.pose;
      const played = await this._play(canvas, steps, st);
      const after = await this._settle(st);
      return {
        name,
        trajectoryDigest: trajectoryDigest(steps),
        startCameraDigest: start,
        finalCameraDigest: st.pose,
        steps: steps.length,
        frames: played.frames + after.frames,
        fixedStep,
        settled: before.settled && after.settled && played.complete,
        unsettledAt: !before.settled ? 'start' : !played.complete ? 'input' : !after.settled ? 'end' : null,
      };
    } finally {
      if (ownCapture) canvas.setPointerCapture = capture;
      else delete (canvas as { setPointerCapture?: unknown }).setPointerCapture;
      if (slots[DRIVE_SLOT] === sink) delete slots[DRIVE_SLOT];
      this._busy = false;
    }
  }

  /**
   * Wait until {@link SETTLE_UPDATES} consecutive navigation updates are within
   * the rest tolerance, for at most {@link MAX_SETTLE_UPDATES} updates or
   * {@link MAX_SETTLE_WAIT_FRAMES} animation frames. In fixed-step mode one
   * step is queued at a time and the wait ends only with none outstanding,
   * so the pose it ends on is the same on every run.
   */
  private async _settle(st: DriveState): Promise<{ frames: number; settled: boolean }> {
    st.stable = 0;
    const from = st.updates;
    let frames = 0;
    for (;;) {
      await this._frame();
      frames++;
      if (st.stable >= SETTLE_UPDATES && (!st.fixed || st.owed === 0)) return { frames, settled: true };
      if (st.updates - from >= MAX_SETTLE_UPDATES || frames >= MAX_SETTLE_WAIT_FRAMES) return { frames, settled: false };
      if (st.fixed && st.owed === 0) st.owed = 1;
    }
  }

  private _frame(): Promise<void> {
    return new Promise((resolve) => this.env.raf(resolve));
  }

  /**
   * Dispatch each step on its nominal frame. In fixed-step mode every frame
   * of the step clock queues one navigation step, and a frame with input
   * waits until the steps before it are integrated, so input and steps
   * interleave the same way on every run.
   */
  private async _play(
    canvas: NavDriverCanvas,
    steps: readonly NavStep[],
    st: DriveState,
  ): Promise<{ frames: number; complete: boolean }> {
    let buttons = 0;
    let i = 0;
    let frame = 0;
    let frames = 0;
    let waited = 0;
    while (i < steps.length) {
      await this._frame();
      frames++;
      if (stepFrame(steps[i]) <= frame && st.owed > 0) {
        if (++waited > MAX_STEP_WAIT_FRAMES) return { frames, complete: false };
        continue;
      }
      waited = 0;
      const box = canvas.getBoundingClientRect();
      while (i < steps.length && stepFrame(steps[i]) <= frame) {
        const s = steps[i++];
        if (s.kind === 'pointerdown') buttons |= 1 << s.button;
        if (s.kind === 'pointerup') buttons &= ~(1 << s.button);
        const cx = box.left + s.x * box.width;
        const cy = box.top + s.y * box.height;
        for (const type of eventTypes(s)) {
          const e = this.env.makeEvent(s, cx, cy, buttons, type);
          (s.kind === 'key' ? this.env.keyTarget : canvas).dispatchEvent(e);
        }
      }
      if (st.fixed) st.owed++;
      frame++;
    }
    return { frames, complete: true };
  }
}

export interface NavDriverHandle {
  run(name: NavTrajectoryName, options?: NavDriveOptions): Promise<NavDriveResult>;
  readonly trajectories: readonly NavTrajectoryName[];
}

/** Install `window.__olvNavDriver`; a second call returns the first handle. */
export function installNavDriver(win: Window & { __olvNavDriver?: NavDriverHandle }): NavDriverHandle {
  if (win.__olvNavDriver) return win.__olvNavDriver;
  const driver = new NavDriver({
    canvas: () => win.document.querySelector<HTMLCanvasElement>('canvas.olv-canvas'),
    keyTarget: win,
    raf: (cb) => win.requestAnimationFrame(() => cb()),
    makeEvent: makeDomEvent,
    slots: win as unknown as Record<string, unknown>,
  });
  const handle: NavDriverHandle = {
    run: (name, options) => driver.run(name, options),
    trajectories: NAV_TRAJECTORY_NAMES,
  };
  win.__olvNavDriver = handle;
  return handle;
}
