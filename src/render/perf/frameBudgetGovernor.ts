/**
 * frameBudgetGovernor.ts
 *
 * How much of a frame each optional piece of work may have.
 *
 * The viewer already shrinks its backing store as the refinement phase
 * advances, already paces the streaming scheduler off the same phase, and
 * already meters GPU commits. Each of those decides on its own what a slow
 * frame means, so on a loaded machine they can disagree: the resolution steps
 * down while a commit batch of the size chosen for a fast frame is still being
 * uploaded, and the frame that was meant to get cheaper gets more expensive.
 *
 * This module answers the question once. It reads the frame times the loop
 * already measures and returns a bounded policy, and the callers apply it. It
 * decides nothing about WHAT to draw, only how much of the frame the optional
 * parts may take.
 *
 * ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────────────
 * Nothing here can move a measured number. Pixel ratio, Eye Dome Lighting,
 * peripheral shading and hover detail are display; the GPU commit scale and
 * streaming urgency change WHEN resident points arrive, never which points a
 * node holds or what a measurement reads from them. Export renders at ratio 1
 * through `Viewer._renderAtSize` and never consults this policy at all.
 *
 * ── THE PHASE IS NOT DECIDED AGAIN ──────────────────────────────────────────
 * The band comes from `bandFor`, the same mapping the scheduler cadence uses,
 * so the governor and the scheduler cannot hold different opinions about
 * whether the camera is moving. A fourth vocabulary for the same four states
 * is exactly the disagreement this module exists to remove.
 *
 * ── LOAD ────────────────────────────────────────────────────────────────────
 * Load is a fraction in `[0, 1]`, 0 at or under the target frame time and 1 at
 * twice it. The median carries it; a single high frame contributes at half
 * weight, because one slow frame is usually a decode landing rather than a
 * machine that cannot keep up, and reacting to it at full weight is how a
 * governor starts flapping.
 *
 * ── HYSTERESIS ──────────────────────────────────────────────────────────────
 * Every switch has a drop threshold above its restore threshold, and inside
 * the gap the previous answer stands. The caller therefore passes the policy
 * it applied last frame; the module keeps no state of its own. The continuous
 * knob has the same problem in a different shape, so `dprPressure` is
 * quantised onto `DPR_PRESSURE_STEP` rather than tracking load exactly: a knob
 * that follows a noisy median precisely is a knob that moves every frame.
 *
 * Pure: no DOM, no three.js, no clock, no module state.
 */
import type { RefinementPhase } from '../refinementPhase';
import { bandFor, type CadenceBand } from '../streaming/schedulerCadence';

/** 60 Hz, in milliseconds. The frame time load is measured against. */
export const TARGET_FRAME_MS = 1000 / 60;

/** Load reaches 1 at twice the target frame time. */
const OVERLOAD_SPAN = 2;

/** A single high frame counts at half the weight of the median. */
const SPIKE_WEIGHT = 0.5;

/** `dprPressure` is quantised onto this step so it cannot follow noise. */
export const DPR_PRESSURE_STEP = 0.25;

/**
 * Load at which each switch turns off, and the lower load at which it comes
 * back. Between the two the previous answer stands.
 *
 * Eye Dome Lighting is given the most room because it is the most visible of
 * the three: a shading pass that blinks is worse to look at than one that
 * stays off through a rough patch.
 */
export const SWITCH_THRESHOLDS = Object.freeze({
  edl: Object.freeze({ drop: 0.45, restore: 0.25 }),
  continuity: Object.freeze({ drop: 0.30, restore: 0.15 }),
  detailedHover: Object.freeze({ drop: 0.55, restore: 0.35 }),
});

/**
 * The floor under `gpuCommitScale` while anything is pending.
 *
 * Strictly positive for the same reason `MIN_COVERAGE_FACTOR` is: a scale of
 * zero does not defer the upload, it stops it, and a scan that stops uploading
 * while the machine is loaded never gets to the frame where the load falls.
 */
export const MIN_COMMIT_SCALE = 0.1;

/**
 * v2 presentation outputs. `renderScale` multiplies the backing-store ratio
 * and `pointBudgetFraction` the drawn instance count of each point mesh.
 * Both only fall while moving, never rise until the camera stops, and the
 * render scale climbs back one step per `RESTORE_FRAMES` stationary frames.
 * Neither reaches a buffer an analysis reads: the drawn count is a draw
 * parameter, the positions behind it are untouched.
 */
export const RENDER_SCALE_FLOOR = 0.6;
export const RENDER_SCALE_STEP = 0.2;
export const POINT_FRACTION_FLOOR = 0.4;
/** Stationary frames between two render-scale restore steps. */
export const RESTORE_FRAMES = 3;

/** What the loop measured, and what is waiting on it. */
export interface FrameBudgetInput {
  /** The refinement phase this frame. The band is derived, never passed. */
  readonly phase: RefinementPhase;
  /** A camera tween is running, which is motion the phase may not have seen yet. */
  readonly tweening: boolean;
  /** Median frame time over the recent window, in milliseconds. */
  readonly recentMedianMs: number;
  /** Highest frame time over the same window, in milliseconds. */
  readonly recentHighMs: number;
  /** Nodes decoded and waiting for a GPU commit. */
  readonly pendingGpuNodes: number;
  /** Chunks the streaming scheduler still wants. */
  readonly streamingBacklog: number;
  /** The continuity field has work it would do if allowed. */
  readonly continuityPending: boolean;
  /** Touch-first hardware, which gets the tighter ceilings. */
  readonly mobileTier: boolean;
  /** The frame time to measure against; defaults to `TARGET_FRAME_MS`. */
  readonly targetFrameMs?: number;
  /** Consecutive frames outside the moving band, for the gradual restore. */
  readonly stationaryFrames?: number;
}

/** What the frame's optional work is allowed. Every number is in `[0, 1]`. */
export interface FrameBudgetPolicy {
  /** How far to shrink the backing store: 0 leaves it alone, 1 is the floor. */
  readonly dprPressure: number;
  /** Fraction of the ordinary GPU commit batch this frame may take. */
  readonly gpuCommitScale: number;
  /** How hard the scheduler should push for coverage. */
  readonly streamingUrgency: number;
  readonly allowEdl: boolean;
  readonly allowContinuity: boolean;
  readonly allowDetailedHover: boolean;
  /** Shading quality away from the centre of the viewport. */
  readonly peripheralQualityScale: number;
  /** Backing-store scale in [RENDER_SCALE_FLOOR, 1]; 1 is the configured ratio. */
  readonly renderScale: number;
  /** Drawn fraction of each point mesh in [POINT_FRACTION_FLOOR, 1]; 1 is the configured budget. */
  readonly pointBudgetFraction: number;
  /** The band the policy was resolved for, so a trace reads back. */
  readonly band: CadenceBand;
  /** The load it was resolved at, for the same reason. */
  readonly load: number;
}

/** The policy for a frame nothing has measured yet. */
export const UNLOADED_POLICY: FrameBudgetPolicy = Object.freeze({
  dprPressure: 0,
  gpuCommitScale: 1,
  streamingUrgency: 0,
  allowEdl: true,
  allowContinuity: false,
  allowDetailedHover: true,
  peripheralQualityScale: 1,
  renderScale: 1,
  pointBudgetFraction: 1,
  band: 'idle' as CadenceBand,
  load: 0,
});

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How loaded the machine is, in `[0, 1]`.
 *
 * Exported because it is the figure every threshold below is stated against,
 * and a reader checking one of them should not have to re-derive it.
 */
export function frameLoad(input: FrameBudgetInput): number {
  const target = Number.isFinite(input.targetFrameMs) && (input.targetFrameMs ?? 0) > 0
    ? (input.targetFrameMs as number)
    : TARGET_FRAME_MS;
  const span = target * OVERLOAD_SPAN;
  const median = clamp01((input.recentMedianMs - target) / span);
  const spike = clamp01((input.recentHighMs - target) / span);
  return clamp01(Math.max(median, spike * SPIKE_WEIGHT));
}

/**
 * Resolve one switch under hysteresis. Above `drop` it is off, below
 * `restore` it is on, and between them it holds whatever it was.
 */
function holdSwitch(
  load: number,
  previous: boolean,
  thresholds: { readonly drop: number; readonly restore: number },
): boolean {
  if (load >= thresholds.drop) return false;
  if (load <= thresholds.restore) return true;
  return previous;
}

/** Quantise onto `step`, rounding up so pressure is never under-reported. */
function quantiseUp(value: number, step: number): number {
  return clamp01(Math.ceil(value / step) * step);
}

/**
 * The policy for this frame.
 *
 * `previous` is the policy the caller applied last frame, which is what the
 * hysteresis holds; passing `UNLOADED_POLICY` states that there is nothing to
 * hold. The result depends on nothing else, so the same pair of arguments
 * always resolves the same way.
 */
export function frameBudgetPolicy(
  input: FrameBudgetInput,
  previous: FrameBudgetPolicy = UNLOADED_POLICY,
): FrameBudgetPolicy {
  const band: CadenceBand = input.tweening ? 'moving' : bandFor(input.phase);
  const load = frameLoad(input);
  const mobile = input.mobileTier === true;

  // Motion is itself pressure: the visible set is changing, so the frame is
  // worth less as a picture and more as a response. The floor under pressure
  // while moving is the phase DPR step the loop already takes, stated here so
  // the two cannot drift apart.
  const motionPressure = band === 'moving' ? (mobile ? 0.5 : 0.25) : 0;
  const dprPressure = quantiseUp(Math.max(load, motionPressure), DPR_PRESSURE_STEP);

  const pending = input.pendingGpuNodes > 0;
  // Uploading competes with drawing, so a loaded frame takes a smaller batch.
  // Settling is where the batch matters most and where the camera is no longer
  // moving, so it keeps the full share until the load says otherwise.
  const commitHeadroom = band === 'moving' ? 0.5 : 1;
  const gpuCommitScale = pending
    ? Math.max(MIN_COMMIT_SCALE, clamp01(commitHeadroom * (1 - load)))
    : 1;

  // Urgency is about the hole on screen, not about the machine. A backlog
  // while moving is the case where a late decision shows, so it ranks highest
  // and the load does not soften it.
  const backlog = input.streamingBacklog > 0;
  const streamingUrgency = !backlog
    ? 0
    : band === 'moving' ? 1
      : band === 'settling' ? 0.75
        : band === 'refining' ? 0.5
          : 0.25;

  const allowEdl = band === 'idle' || band === 'refining'
    ? holdSwitch(load, previous.allowEdl, SWITCH_THRESHOLDS.edl)
    : holdSwitch(load, previous.allowEdl, SWITCH_THRESHOLDS.edl) && !mobile;

  // Continuity is spare-budget work by definition, so it runs while refining
  // and nowhere else. Idle is excluded on purpose: a parked viewer that has
  // finished refining has no visual work left, and starting some is how a
  // laptop discovers the fan.
  const allowContinuity = input.continuityPending
    && band === 'refining'
    && holdSwitch(load, previous.allowContinuity, SWITCH_THRESHOLDS.continuity);

  const allowDetailedHover = band !== 'moving'
    && holdSwitch(load, previous.allowDetailedHover, SWITCH_THRESHOLDS.detailedHover);

  // The centre is what the viewer is looking at, so the periphery is where a
  // loaded frame gives ground first. It is held at full quality once parked,
  // where a visible seam between centre and edge would have time to be read as
  // a property of the scan.
  const peripheralQualityScale = band === 'moving'
    ? clamp01(1 - 0.5 * load)
    : 1;

  // v2: while moving, drop to the level the load asks for and hold the lowest
  // level reached; stationary, restore the scale in steps and the points at once.
  const loadLevel = load > 0.5 ? 2 : load > 0 ? 1 : 0;
  let renderScale: number;
  let pointBudgetFraction: number;
  if (band === 'moving') {
    renderScale = Math.min(previous.renderScale, round1(1 - loadLevel * RENDER_SCALE_STEP));
    pointBudgetFraction = Math.min(previous.pointBudgetFraction, round1(1 - loadLevel * (1 - POINT_FRACTION_FLOOR) / 2));
  } else {
    const n = input.stationaryFrames ?? RESTORE_FRAMES;
    const due = n > 0 && n % RESTORE_FRAMES === 0;
    renderScale = due ? Math.min(1, round1(previous.renderScale + RENDER_SCALE_STEP)) : previous.renderScale;
    pointBudgetFraction = 1;
  }
  renderScale = Math.max(RENDER_SCALE_FLOOR, renderScale);
  pointBudgetFraction = Math.max(POINT_FRACTION_FLOOR, pointBudgetFraction);

  return Object.freeze({
    dprPressure,
    gpuCommitScale,
    streamingUrgency,
    allowEdl,
    allowContinuity,
    allowDetailedHover,
    peripheralQualityScale,
    renderScale,
    pointBudgetFraction,
    band,
    load,
  });
}
