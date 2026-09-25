import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTrajectory,
  NAV_TRAJECTORY_NAMES,
  NAV_FRAME_MS,
  stepFrame,
  trajectoryDigest,
  type NavStep,
} from '../src/perf/navTrajectories';
import { NavDriver, DRIVE_SLOT, cameraDigest, FIXED_NAV_DT_SEC, SETTLE_UPDATES, withinRest, angleBetween, type NavDriverEnv } from '../src/perf/navDriver';
import { NAV_DRIVE_SLOT, navDrive, stepNav, type NavDriveSink } from '../src/perf/navProbeHook';
import { runRenderFrame, type RenderLoopHost } from '../src/render/renderLoop';

const slots = globalThis as Record<string, unknown>;
afterEach(() => { delete slots[NAV_DRIVE_SLOT]; });

describe('trajectories', () => {
  it('are deterministic and have stable digests', () => {
    for (const name of NAV_TRAJECTORY_NAMES) {
      const a = buildTrajectory(name);
      const b = buildTrajectory(name);
      expect(a).toEqual(b);
      expect(trajectoryDigest(a)).toBe(trajectoryDigest(b));
      expect(trajectoryDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    }
    const digests = NAV_TRAJECTORY_NAMES.map((n) => trajectoryDigest(buildTrajectory(n)));
    expect(new Set(digests).size).toBe(NAV_TRAJECTORY_NAMES.length);
  });

  it('keeps positions inside the normalized canvas and times on the frame clock', () => {
    for (const name of NAV_TRAJECTORY_NAMES) {
      const steps = buildTrajectory(name, { dense: { x: 0.8, y: 0.3 } });
      expect(steps.length).toBeGreaterThan(0);
      let prev = -1;
      for (const s of steps) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(1);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(1);
        const f = stepFrame(s);
        expect(Math.abs(f * NAV_FRAME_MS - s.tMs)).toBeLessThan(1e-5);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });

  it('pairs pointer presses and key presses', () => {
    for (const name of NAV_TRAJECTORY_NAMES) {
      let down = 0;
      const keys = new Set<string>();
      for (const s of buildTrajectory(name)) {
        if (s.kind === 'pointerdown') down++;
        if (s.kind === 'pointerup') down--;
        expect(down === 0 || down === 1).toBe(true);
        if (s.kind === 'key') {
          const [code, edge] = s.key.split(':');
          if (edge === 'down') keys.add(code); else keys.delete(code);
        }
      }
      expect(down).toBe(0);
      expect(keys.size).toBe(0);
    }
  });

  it('steers the fly-through and zoom shock toward the dense hint', () => {
    const centre = buildTrajectory('zoomShock');
    const hinted = buildTrajectory('zoomShock', { dense: { x: 0.7, y: 0.4 } });
    expect(trajectoryDigest(centre)).not.toBe(trajectoryDigest(hinted));
    const lastWheel = hinted.filter((s) => s.kind === 'wheel').at(-1)!;
    expect([lastWheel.x, lastWheel.y]).toEqual([0.7, 0.4]);
    expect(lastWheel.deltaY).toBeLessThan(0);
    const fly = buildTrajectory('flythrough', { dense: { x: 0.7, y: 0.4 } });
    const moves = fly.filter((s) => s.kind === 'pointermove');
    expect(moves.some((s) => s.x === 0.7 && s.y === 0.4)).toBe(true);
  });

  it('holds still for 3 s at the end of stop-and-inspect', () => {
    const steps = buildTrajectory('stopInspect');
    const up = steps.findIndex((s) => s.kind === 'pointerup');
    expect(steps.length - 1 - up).toBe(1);
    expect(steps.at(-1)!.tMs - steps[up].tMs).toBeCloseTo(3000, 6);
  });
});

/**
 * A fake browser: manual animation frames and recorded events. Each tick runs
 * the render loop first (integrating what the sink hands it, reporting the
 * pose `pose()` returns before each update), then the driver's frame.
 */
function fakeEnv(pose: (update: number) => number = () => 0) {
  const queue: (() => void)[] = [];
  const log: { updates: number; type: string; x: number; y: number; buttons: number; target: string }[] = [];
  let updates = 0;
  let loopRuns = true;
  const canvas = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
    dispatchEvent: (e: Event) => { log.push({ updates, ...(e as unknown as { type: string; x: number; y: number; buttons: number }), target: 'canvas' }); return true; },
    setPointerCapture: (_id: number): void => { throw new Error('NotFoundError'); },
  };
  const env: NavDriverEnv = {
    canvas: () => canvas,
    keyTarget: { dispatchEvent: (e: Event) => { log.push({ updates, ...(e as unknown as { type: string; x: number; y: number; buttons: number }), target: 'window' }); return true; } },
    raf: (cb) => { queue.push(cb); },
    makeEvent: (_s: NavStep, x: number, y: number, buttons: number, type: string) => ({ type, x, y, buttons }) as unknown as Event,
    slots,
  };
  const tick = () => {
    if (loopRuns && navDrive()) {
      stepNav(1 / 30, () => {
        navDrive()!.pose([pose(updates), 0, 0], [0, 0, 0], [0, 0, 1]);
        updates++;
      });
    }
    const cbs = queue.splice(0);
    for (const cb of cbs) cb();
  };
  return {
    env, log, tick, canvas,
    pending: () => queue.length,
    updates: () => updates,
    /** Stall the render loop (a dropped or sleeping frame). */
    setLoop: (on: boolean) => { loopRuns = on; },
  };
}

/** Let the driver's awaits resolve between frames. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function drain(f: ReturnType<typeof fakeEnv>, each: (k: number) => void = () => {}, max = 5000): Promise<number> {
  let k = 0;
  for (; k < max && f.pending() > 0; k++) { each(k); f.tick(); await flush(); }
  return k;
}

describe('driver sequencing', () => {
  it('dispatches each step with canvas coordinates and held buttons, restoring the canvas after', async () => {
    const f = fakeEnv(() => 1);
    const steps = buildTrajectory('stopInspect');
    const done = new NavDriver(f.env).run('stopInspect', { fixedStep: true });
    expect(navDrive()?.fixedDtSec).toBe(FIXED_NAV_DT_SEC);
    await drain(f);
    const result = await done;
    expect(f.log.map((e) => e.type)).toEqual(steps.map((s) => s.kind));
    for (let k = 0; k < steps.length; k++) {
      expect(f.log[k].x).toBeCloseTo(10 + steps[k].x * 200, 9);
      expect(f.log[k].y).toBeCloseTo(20 + steps[k].y * 100, 9);
    }
    const upAt = f.log.findIndex((e) => e.type === 'pointerup');
    expect(f.log.slice(1, upAt).every((e) => e.buttons === 1)).toBe(true);
    expect(f.log.at(-1)!.buttons).toBe(0);
    expect(result.trajectoryDigest).toBe(trajectoryDigest(steps));
    expect(result.finalCameraDigest).toBe(cameraDigest([1, 0, 0], [0, 0, 0], [0, 0, 1]));
    expect(result.settled).toBe(true);
    expect(navDrive()).toBeNull();
    expect(() => f.canvas.setPointerCapture(1)).toThrow();
  });

  it('in fixed-step mode integrates one step per step-clock frame between inputs, even when the loop stalls', async () => {
    const run = async (stall: (k: number) => boolean) => {
      const f = fakeEnv((u) => (u < 20 ? 0 : Math.min(u, 360)));
      const done = new NavDriver(f.env).run('scrub', { fixedStep: true });
      await drain(f, (k) => f.setLoop(!stall(k)));
      const r = await done;
      return { r, at: f.log.map((e) => e.updates) };
    };
    const steady = await run(() => false);
    const stalled = await run((k) => k % 3 === 1 || (k > 100 && k < 140));
    const steps = buildTrajectory('scrub');
    const base = steady.at[0];
    expect(steady.at.map((u) => u - base)).toEqual(steps.map((s) => stepFrame(s) - stepFrame(steps[0])));
    expect(stalled.at.map((u) => u - stalled.at[0])).toEqual(steady.at.map((u) => u - base));
    expect(stalled.r.finalCameraDigest).toBe(steady.r.finalCameraDigest);
    expect(stalled.r.settled && steady.r.settled).toBe(true);
  });

  it('sends key steps to the key target', async () => {
    const f = fakeEnv();
    const done = new NavDriver(f.env).run('scrub');
    await drain(f);
    await done;
    const keys = f.log.filter((e) => e.target === 'window');
    expect(keys.map((e) => e.type)).toEqual(Array.from({ length: 16 }, (_, k) => (k % 2 === 0 ? 'keydown' : 'keyup')));
  });

  it('waits for the pose to stop changing, before the first step and after the last', async () => {
    // The pose moves for the first 30 updates (a load glide) and again for 150 after input starts.
    let firstInput = -1;
    const f = fakeEnv((u) => (u < 30 ? u : firstInput < 0 ? 30 : Math.min(u, firstInput + 150)));
    const done = new NavDriver(f.env).run('zoomShock');
    await drain(f, () => { if (firstInput < 0 && f.log.length > 0) firstInput = f.updates(); });
    const r = await done;
    expect(f.log[0].updates).toBeGreaterThanOrEqual(30 + SETTLE_UPDATES);
    expect(r.startCameraDigest).toBe(cameraDigest([30, 0, 0], [0, 0, 0], [0, 0, 1]));
    expect(r.finalCameraDigest).toBe(cameraDigest([firstInput + 150, 0, 0], [0, 0, 0], [0, 0, 1]));
    expect(r.fixedStep).toBe(false);
    expect(r.settled).toBe(true);
  });

  it('counts navigation updates, so a loop that only updates on a heartbeat still settles', async () => {
    const f = fakeEnv((u) => Math.min(u, 20));
    const done = new NavDriver(f.env).run('zoomShock');
    // The render loop runs one frame in eight once the input is over (an idle heartbeat).
    await drain(f, (k) => f.setLoop(f.log.length < buildTrajectory('zoomShock').length || k % 8 === 0));
    expect((await done).settled).toBe(true);
  });

  it('holds rest to a tolerance relative to the scene, not an absolute one', () => {
    // A pan by `x` moves position and target together; `ty` moves the target alone (a turn).
    const at = (x: number, ty = 0) => ({ position: [356_000 + x, 3_972_000, 2000], target: [356_000 + x, 3_972_000 + ty, 1900], up: [0, 0, 1] });
    // A 0.5 mm pan in a 1.4 km scene is rest; 5 mm is not.
    expect(withinRest(at(0), at(0.0005), 1414)).toBe(true);
    expect(withinRest(at(0), at(0.005), 1414)).toBe(false);
    expect(withinRest(at(0), at(0, 0.005), 1414)).toBe(false);
    expect(angleBetween([1, 0, 0], [1, 1e-8, 0])).toBeCloseTo(1e-8, 15);
    expect(angleBetween([0, 0, 1], [0, 0, 1])).toBe(0);
    const tilted = { ...at(0), up: [0, Math.sin(1e-6), Math.cos(1e-6)] };
    expect(withinRest(at(0), tilted, 1414)).toBe(false);
  });

  it('reports an unsettled run when the pose never holds', async () => {
    const f = fakeEnv((u) => u);
    const done = new NavDriver(f.env).run('zoomShock');
    await drain(f);
    expect((await done).settled).toBe(false);
  });

  it('rejects an unknown name and a second concurrent run', async () => {
    const f = fakeEnv();
    const d = new NavDriver(f.env);
    await expect(d.run('nope' as never)).rejects.toThrow(/unknown trajectory/);
    const first = d.run('orbit');
    await expect(d.run('orbit')).rejects.toThrow(/already playing/);
    await drain(f);
    await first;
  });
});

describe('fixed-step seam', () => {
  it('uses the slot name the hook reads', () => {
    expect(DRIVE_SLOT).toBe(NAV_DRIVE_SLOT);
  });

  function host(seen: { nav: number[]; orbit: number[]; recorded: number[] }): RenderLoopHost {
    const noop = () => {};
    const over: Partial<RenderLoopHost> = {
      advanceFrameClock: () => 0.043,
      recordFrame: (d) => { seen.recorded.push(d); },
      updateNav: (d) => { seen.nav.push(d); },
      maintainOrbitCenter: (d) => { seen.orbit.push(d); },
    };
    return new Proxy(over as RenderLoopHost, {
      get: (target, key: string) => (key in target ? (target as unknown as Record<string, unknown>)[key]
        : key === 'shouldRenderFrame' || key === 'hasStreaming' ? () => false
          : key === 'toolMode' ? () => 'orbit'
            : key === 'sweepState' ? () => 'none'
              : key === 'navQuality' ? undefined
                : key.endsWith('UntilMs') ? () => 0 : () => noop()),
    });
  }

  it('integrates the clock delta without a driver or on the frame clock, and exactly the queued fixed steps otherwise', () => {
    const seen = { nav: [] as number[], orbit: [] as number[], recorded: [] as number[] };
    runRenderFrame(host(seen));
    let owed = 3;
    const sink: NavDriveSink = {
      fixedDtSec: FIXED_NAV_DT_SEC,
      takeSteps: () => { const n = owed; owed = 0; return n; },
      pose: () => {},
    };
    slots[NAV_DRIVE_SLOT] = sink;
    runRenderFrame(host(seen)); // three queued steps
    runRenderFrame(host(seen)); // none queued: navigation holds
    slots[NAV_DRIVE_SLOT] = { fixedDtSec: null, takeSteps: () => 0, pose: () => {} } satisfies NavDriveSink;
    runRenderFrame(host(seen));
    const F = FIXED_NAV_DT_SEC;
    expect(seen.nav).toEqual([0.043, F, F, F, 0.043]);
    expect(seen.orbit).toEqual([0.043, F, F, F, 0.043]);
    expect(seen.recorded).toEqual([0.043, 0.043, 0.043, 0.043]);
  });

  it('hashes a pose at 1e-6', () => {
    expect(cameraDigest([1.0000001, -0, 2], [0, 0, 0], [0, 0, 1])).toBe(cameraDigest([1, 0, 2], [0, 0, 0], [0, 0, 1]));
    expect(cameraDigest([1.000002, 0, 2], [0, 0, 0], [0, 0, 1])).not.toBe(cameraDigest([1, 0, 2], [0, 0, 0], [0, 0, 1]));
  });
});
