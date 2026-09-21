/**
 * renderActivityGate.test.ts — the "render this frame or skip it" decision.
 *
 * This lived as `Viewer._shouldRenderFrame` plus a scattered heartbeat counter
 * and an activity timestamp. It reads `performance.now()` and the streaming
 * scheduler, so it could only run inside a live render loop, and the parts
 * most likely to be wrong had no coverage: the exact holdover-expiry boundary,
 * the heartbeat coinciding with a render, and the PRIORITY between the four
 * reasons to render (tween, recent input, streaming busy, heartbeat).
 *
 * The gate takes an injected `now`, so every one of those is a plain Node
 * assertion. The Viewer keeps only the loop wiring and the actual `render()`.
 */

import { describe, it, expect } from 'vitest';
import {
  RenderActivityGate,
  CameraPoseWatch,
  poseDrivesCamera,
  RENDER_HOLDOVER_MS,
  IDLE_HEARTBEAT_FRAMES,
  type CameraPose,
} from '../src/render/renderActivityGate';

/** A parked gate: no input, heartbeat freshly reset, nothing streaming. */
function parked(): RenderActivityGate {
  const g = new RenderActivityGate();
  g.noteRendered(); // heartbeat -> 0
  return g;
}

const idle = { tweening: false, streamingBusy: false, commitWork: false };

describe('RenderActivityGate', () => {
  it('renders while a tween is in progress, whatever else is true', () => {
    const g = parked();
    expect(g.shouldRender(1_000_000, { tweening: true, streamingBusy: false, commitWork: false })).toBe(true);
  });

  it('renders for the full holdover window after an input bump', () => {
    const g = parked();
    g.bump(1000);
    expect(g.shouldRender(1000, idle)).toBe(true);
    expect(g.shouldRender(1000 + RENDER_HOLDOVER_MS - 1, idle)).toBe(true);
  });

  it('stops rendering exactly when the holdover expires', () => {
    const g = parked();
    g.bump(1000);
    // The check is `now < until`, so the boundary instant itself is already
    // expired. Off-by-one here would keep the GPU awake one frame too long
    // forever, or cut a frame short of the window.
    expect(g.shouldRender(1000 + RENDER_HOLDOVER_MS, idle)).toBe(false);
  });

  it('renders while streaming is loading, then stops when it goes quiet', () => {
    const g = parked();
    expect(g.shouldRender(5000, { tweening: false, streamingBusy: true, commitWork: false })).toBe(true);
    expect(g.shouldRender(5000, { tweening: false, streamingBusy: false, commitWork: false })).toBe(false);
  });

  it('draws for commit work, so uploaded geometry does not wait for a heartbeat', () => {
    // The parked gate is the whole point: no tween, no input, no fetch
    // backlog, heartbeat at zero. Before this signal the answer was false and
    // a node that had reached the GPU sat undrawn until the counter came
    // round.
    const g = parked();
    expect(g.shouldRender(9000, { ...idle, commitWork: true })).toBe(true);
    expect(g.shouldRender(9000, idle)).toBe(false);
  });

  it('fires the heartbeat once enough idle frames have passed', () => {
    const g = parked();
    // Each idle frame: the gate says skip, then the loop notes the skip. After
    // IDLE_HEARTBEAT_FRAMES of them the counter reaches the threshold and the
    // next check fires the heartbeat.
    for (let i = 0; i < IDLE_HEARTBEAT_FRAMES; i++) {
      expect(g.shouldRender(9000, idle)).toBe(false);
      g.noteSkipped();
    }
    expect(g.shouldRender(9000, idle)).toBe(true);
  });

  it('resets the heartbeat when a frame renders, so ticks are evenly spaced', () => {
    const g = parked();
    for (let i = 0; i < IDLE_HEARTBEAT_FRAMES; i++) g.noteSkipped();
    expect(g.shouldRender(9000, idle)).toBe(true);
    g.noteRendered();
    // Immediately after a render the counter is 0 again — no double heartbeat.
    expect(g.shouldRender(9000, idle)).toBe(false);
  });

  it('a fresh gate renders on its first frame (heartbeat starts armed)', () => {
    // Without an initial render the very first loop iteration must still draw,
    // or the scene never appears until the first input.
    const g = new RenderActivityGate();
    expect(g.shouldRender(0, idle)).toBe(true);
  });

  it('exposes the activity deadline for the shared moving-camera signal', () => {
    // The EDL suspend and the DPR throttle read the same deadline, so it must
    // be observable rather than private to the gate.
    const g = parked();
    g.bump(2000);
    expect(g.activityUntilMs).toBe(2000 + RENDER_HOLDOVER_MS);
  });

  it('bump assigns the deadline from the given now (unconditional, matching the loop)', () => {
    // The clock is performance.now(), which is monotonic, so successive bumps
    // only increase in practice. The gate assigns unconditionally rather than
    // taking a max — a faithful copy of the original, not a new guard.
    const g = parked();
    g.bump(1500);
    expect(g.activityUntilMs).toBe(1500 + RENDER_HOLDOVER_MS);
    g.bump(2000);
    expect(g.activityUntilMs).toBe(2000 + RENDER_HOLDOVER_MS);
  });
});

/**
 * The two deadlines, and who may extend which.
 *
 * The render deadline answers "keep drawing" and every input extends it. The
 * camera deadline answers "is the camera moving" and gates EDL, the adaptive
 * pixel ratio and the refinement phase. Reading one for the other made a
 * pointer move over a parked scene change its shading.
 */
describe('RenderActivityGate — the render and camera deadlines are separate', () => {
  it('bump extends the render deadline and leaves the camera one alone', () => {
    const g = new RenderActivityGate();
    g.bump(1000);
    expect(g.activityUntilMs).toBe(1000 + RENDER_HOLDOVER_MS);
    expect(g.cameraUntilMs).toBe(0);
  });

  it('bumpCamera extends both — camera motion always wants full-rate frames', () => {
    const g = new RenderActivityGate();
    g.bumpCamera(1000);
    expect(g.activityUntilMs).toBe(1000 + RENDER_HOLDOVER_MS);
    expect(g.cameraUntilMs).toBe(1000 + RENDER_HOLDOVER_MS);
  });
});

describe('the pose watch answers only for the modes that need it', () => {
  const pose = (x: number): CameraPose => ({
    position: { x, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  });

  it('reports the first sample as no movement, then any exact difference', () => {
    const w = new CameraPoseWatch();
    expect(w.moved(pose(0))).toBe(false);
    expect(w.moved(pose(0))).toBe(false);
    // Exact comparison: the damping tail's sub-pixel steps count as movement,
    // which is why the caller must not consult it under OrbitControls.
    expect(w.moved(pose(1e-12))).toBe(true);
  });

  it('speaks for walk and fly, which bypass OrbitControls', () => {
    expect(poseDrivesCamera('walk')).toBe(true);
    expect(poseDrivesCamera('fly')).toBe(true);
  });

  it('stays silent for orbit and pan, where the settle gate decides', () => {
    // Orbit and pan run `controls.update()` every frame, and damping keeps
    // changing the transform by amounts far below a pixel long after the view
    // has come to rest. Letting the pose comparison speak there would re-arm
    // camera activity that DampingSettleGate had just withheld, holding EDL
    // and the reduced pixel ratio for seconds after a gesture ends.
    expect(poseDrivesCamera('orbit')).toBe(false);
    expect(poseDrivesCamera('pan')).toBe(false);
  });
});
