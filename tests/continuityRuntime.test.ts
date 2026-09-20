import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ContinuityRuntime,
  type ContinuityFrameInput,
  type ContinuityRuntimeOptions,
} from '../src/render/continuity/ContinuityRuntime';
import type { DisplayState } from '../src/render/continuity/continuityField';
import type { BackendSupport } from '../src/render/continuity/continuityTier';
import type { CapabilityOptIn } from '../src/render/continuity/mobilePolicy';

/** A backend that can carry everything. */
const FULL_SUPPORT: BackendSupport = {
  historyTextures: true,
  historyFits: true,
  depthNeighbourhood: true,
};

/** Everything opted in — what a session with the flags set looks like. */
const ALL_OPT_IN: CapabilityOptIn = {
  coverageSizing: true,
  microGapFill: true,
  temporalAccumulation: true,
  evidenceLens: true,
};

function display(over: Partial<DisplayState> = {}): DisplayState {
  return {
    camera: 'c0',
    projection: 'p0',
    widthPx: 1280,
    heightPx: 720,
    dpr: 2,
    renderOrigin: 'o0',
    dataset: 'd0',
    lodFrontier: 'f0',
    classFilter: 'all',
    scalarFilter: 'none',
    clip: 'none',
    colorMode: 'rgb',
    rgbSettings: 'default',
    pointSizeMode: 'fixed',
    splatMode: 'off',
    edl: 'on',
    deviceGeneration: 1,
    ...over,
  };
}

function frame(over: Partial<ContinuityFrameInput> = {}): ContinuityFrameInput {
  return {
    display: display(),
    requestedTier: 'full',
    refinement: 'full-refine',
    viewport: { widthPx: 1280, heightPx: 720 },
    pressure: { aboveHighMs: 0, belowLowMs: 0 },
    memoryPressure: false,
    reducedMotion: false,
    ...over,
  };
}

function runtime(over: Partial<ContinuityRuntimeOptions> = {}): ContinuityRuntime {
  return new ContinuityRuntime({
    support: FULL_SUPPORT,
    touchFirst: false,
    optIn: ALL_OPT_IN,
    ...over,
  });
}

/** Push frames until the tier stops climbing, or give up. */
function settle(r: ContinuityRuntime, over: Partial<ContinuityFrameInput> = {}): string {
  let last = '';
  for (let i = 0; i < 12; i++) {
    // A fresh camera each frame would reopen the epoch; hold it still and let
    // the low-pressure promotion run.
    const plan = r.prepareFrame(frame({ pressure: { aboveHighMs: 0, belowLowMs: 10_000 }, ...over }));
    if (plan.tier === last) break;
    last = plan.tier;
  }
  return last;
}

describe('off by default', () => {
  it('grants nothing when nothing is opted into, on a backend that could carry it', () => {
    const r = runtime({ optIn: undefined });
    const tier = settle(r);
    expect(tier).toBe('source');
    const plan = r.prepareFrame(frame());
    expect(plan.active).toBe(false);
    expect(Object.values(plan.capabilities).every((on) => on === false)).toBe(true);
  });

  it('starts at the bottom even with everything opted in', () => {
    // The first frame has measured nothing, so it does not begin at the
    // ceiling and discover the device cannot hold it.
    expect(runtime().prepareFrame(frame()).tier).toBe('source');
  });
});

describe('the ceiling', () => {
  it('never exceeds what the backend carries', () => {
    const noHistory = runtime({
      support: { historyTextures: false, historyFits: true, depthNeighbourhood: true },
    });
    expect(noHistory.backendTier).toBe('closure');
    expect(noHistory.ceilingFor('full')).toBe('closure');
    expect(settle(noHistory)).toBe('closure');
  });

  it('holds a touch-first device at its policy cap', () => {
    const phone = runtime({ touchFirst: true });
    expect(phone.ceilingFor('full')).toBe('sizing');
    expect(settle(phone)).toBe('sizing');
  });

  it('never exceeds what the quality dial requested', () => {
    const r = runtime();
    expect(r.ceilingFor('sizing')).toBe('sizing');
    expect(settle(r, { requestedTier: 'sizing' })).toBe('sizing');
  });
});

describe('pressure', () => {
  it('climbs one rung at a time rather than jumping to the ceiling', () => {
    const r = runtime();
    const low = { aboveHighMs: 0, belowLowMs: 10_000 };
    const seen = [
      r.prepareFrame(frame({ pressure: low })).tier,
      r.prepareFrame(frame({ pressure: low })).tier,
      r.prepareFrame(frame({ pressure: low })).tier,
      r.prepareFrame(frame({ pressure: low })).tier,
    ];
    expect(seen).toEqual(['sizing', 'closure', 'full', 'full']);
  });

  it('gives ground one rung at a time under a slow frame', () => {
    const r = runtime();
    settle(r);
    const high = { aboveHighMs: 10_000, belowLowMs: 0 };
    expect(r.prepareFrame(frame({ pressure: high })).tier).toBe('closure');
    expect(r.prepareFrame(frame({ pressure: high })).tier).toBe('sizing');
  });
});

describe('failure', () => {
  it('drops a rung and never climbs back past it', () => {
    const r = runtime();
    expect(settle(r)).toBe('full');
    expect(r.invalidate('history-allocation-failed')).toBe('closure');
    // The device refused a history. Quick frames afterwards are not evidence
    // that it would now succeed.
    expect(settle(r)).toBe('closure');
    expect(r.ceilingFor('full')).toBe('closure');
    expect(r.lastFailure).toBe('history-allocation-failed');
  });

  it('discards the sweep, because it described a rung that just failed', () => {
    const r = runtime();
    settle(r);
    r.prepareFrame(frame());
    r.invalidate('pass-threw');
    expect(r.prepareFrame(frame()).convergence.kind).not.toBe('converged');
  });

  it('stops dropping at the bottom rather than failing', () => {
    const r = runtime();
    for (let i = 0; i < 6; i++) r.invalidate('pass-threw');
    expect(r.prepareFrame(frame()).tier).toBe('source');
  });
});

describe('the display epoch', () => {
  it('opens once and stands still while nothing relevant moves', () => {
    const r = runtime();
    const first = r.prepareFrame(frame());
    expect(first.epochChanged).toBe(true);
    const second = r.prepareFrame(frame());
    expect(second.epochChanged).toBe(false);
    expect(second.epoch).toBe(first.epoch);
  });

  it('advances when a display input changes, and says which', () => {
    const r = runtime();
    r.prepareFrame(frame());
    const moved = r.prepareFrame(frame({ display: display({ camera: 'c1' }) }));
    expect(moved.epochChanged).toBe(true);
    expect(moved.changed).toEqual(['camera']);
  });

  it('advances for every presentation input, and for nothing else', () => {
    // The brief's list, checked against the runtime rather than against the
    // diff: an input the epoch ignored would leave history describing a
    // picture that is no longer on screen.
    const base = display();
    for (const [field, value] of Object.entries({
      camera: 'moved',
      projection: 'ortho',
      widthPx: 640,
      heightPx: 480,
      dpr: 1,
      renderOrigin: 'rebased',
      dataset: 'other',
      lodFrontier: 'deeper',
      classFilter: 'ground-only',
      scalarFilter: 'narrow',
      clip: 'box',
      colorMode: 'intensity',
      rgbSettings: 'boosted',
      pointSizeMode: 'density',
      splatMode: 'soft',
      edl: 'off',
      deviceGeneration: 9,
    })) {
      const r = runtime();
      r.prepareFrame(frame({ display: base }));
      const moved = r.prepareFrame(frame({ display: display({ [field]: value }) }));
      expect(moved.epochChanged, field).toBe(true);
      expect(moved.changed, field).toEqual([field]);
    }
  });

  it('counts frames within an epoch and epochs across the session', () => {
    const r = runtime();
    r.prepareFrame(frame());
    r.prepareFrame(frame());
    expect(r.metrics().framesThisEpoch).toBe(2);
    r.prepareFrame(frame({ display: display({ colorMode: 'intensity' }) }));
    expect(r.metrics().framesThisEpoch).toBe(1);
    expect(r.metrics().epochsOpened).toBe(2);
  });
});

describe('the convergence sweep', () => {
  it('stays idle while accumulation is not granted', () => {
    const r = runtime({ optIn: undefined });
    settle(r);
    // A sweep that advanced with nothing to merge would spend a GPU on
    // phases no history collects.
    expect(r.prepareFrame(frame()).convergence.kind).toBe('idle');
    expect(r.prepareFrame(frame()).phase).toBe(null);
  });

  it('runs only at full refinement', () => {
    const r = runtime({ phaseCount: 2 });
    settle(r);
    expect(r.prepareFrame(frame({ refinement: 'moving' })).convergence.kind).toBe('idle');
    expect(r.prepareFrame(frame({ refinement: 'coverage' })).convergence.kind).toBe('idle');
  });

  it('converges in as many frames as there are phases, then stops', () => {
    const r = runtime({ phaseCount: 2 });
    settle(r);
    // Climbing to the top already spent a sweep, so open a fresh epoch and
    // count that one.
    const fresh = display({ camera: 'c-count' });
    const drawn = [
      r.prepareFrame(frame({ display: fresh })),
      r.prepareFrame(frame({ display: fresh })),
      r.prepareFrame(frame({ display: fresh })),
    ];
    // Two phases take three frames. The frame that opens the sweep draws
    // phase 0 and merges nothing yet; each later frame counts the one before
    // it, so `contributed` is always phases already merged.
    expect(drawn.map((p) => p.phase)).toEqual([0, 1, null]);
    expect(drawn.map((p) => p.convergence.kind)).toEqual(['converging', 'converging', 'converged']);
    expect(drawn[2].accumulate).toBe(false);
  });

  it('restarts when the epoch moves, whatever the camera did', () => {
    const r = runtime({ phaseCount: 2 });
    settle(r);
    r.prepareFrame(frame());
    r.prepareFrame(frame());
    const after = r.prepareFrame(frame({ display: display({ colorMode: 'elevation' }) }));
    expect(after.convergence.kind).toBe('converging');
  });
});

describe('the lens', () => {
  it('is reported only while its capability is granted', () => {
    const r = runtime();
    const viewport = { widthPx: 1280, heightPx: 720 };
    r.setLensIntent({ kind: 'open', source: 'pointer' }, viewport);
    // At `source` nothing is granted, so the plan reports a closed lens even
    // though the lens itself is open.
    expect(r.prepareFrame(frame()).lens.enabled).toBe(false);
    settle(r);
    expect(r.prepareFrame(frame()).lens.enabled).toBe(true);
  });

  it('keeps a touch lens through a release and closes a pointer one', () => {
    const r = runtime();
    const viewport = { widthPx: 1280, heightPx: 720 };
    r.setLensIntent({ kind: 'at', source: 'touch', xPx: 100, yPx: 100 }, viewport);
    expect(r.setLensIntent({ kind: 'release', source: 'touch' }, viewport).enabled).toBe(true);
    r.setLensIntent({ kind: 'at', source: 'pointer', xPx: 100, yPx: 100 }, viewport);
    expect(r.setLensIntent({ kind: 'release', source: 'pointer' }, viewport).enabled).toBe(false);
  });
});

describe('dispose', () => {
  it('returns to the renderer as it shipped', () => {
    const r = runtime();
    settle(r);
    r.dispose();
    const plan = r.prepareFrame(frame());
    expect(r.disposed).toBe(true);
    expect(plan.tier).toBe('source');
    expect(plan.active).toBe(false);
    // And it cannot climb again, so a frame arriving after teardown draws as
    // it did before the field existed.
    expect(settle(r)).toBe('source');
  });
});

describe('memory pressure', () => {
  it('takes the rung that keeps a history and leaves the rest', () => {
    const r = runtime();
    expect(settle(r)).toBe('full');
    // Sizing and gap closure hold nothing between frames, so giving them up
    // would cost quality and free nothing.
    expect(r.ceilingFor('full', true)).toBe('closure');
    const under = r.prepareFrame(frame({ memoryPressure: true }));
    expect(under.tier).toBe('closure');
    expect(under.capabilities.temporalAccumulation).toBe(false);
    expect(under.capabilities.microGapFill).toBe(true);
    expect(under.capabilities.coverageSizing).toBe(true);
  });

  it('lets the rung come back once there is room again', () => {
    const r = runtime();
    settle(r);
    r.prepareFrame(frame({ memoryPressure: true }));
    // Unlike a failure, being short of room is a passing condition rather
    // than evidence about the device.
    expect(settle(r)).toBe('full');
  });

  it('cannot raise a rung anything else lowered', () => {
    const phone = runtime({ touchFirst: true });
    expect(phone.ceilingFor('full', true)).toBe('sizing');
  });
});

describe('the repair the plan asks for', () => {
  it('is none while nothing moves', () => {
    const r = runtime();
    r.prepareFrame(frame());
    expect(r.prepareFrame(frame()).repair).toBe('none');
  });

  it('is none on the first frame, which has no history to repair', () => {
    expect(runtime().prepareFrame(frame()).repair).toBe('none');
  });

  it('clears for a camera move and reallocates for a resize', () => {
    const r = runtime();
    r.prepareFrame(frame());
    expect(r.prepareFrame(frame({ display: display({ camera: 'c1' }) })).repair).toBe('clear');
    expect(r.prepareFrame(frame({ display: display({ camera: 'c1', widthPx: 640 }) })).repair)
      .toBe('reallocate');
  });

  it('reallocates when the device is remade at the same size', () => {
    const r = runtime();
    r.prepareFrame(frame());
    const remade = display({ deviceGeneration: 2 });
    expect(r.prepareFrame(frame({ display: remade })).repair).toBe('reallocate');
  });
});

/** A surface factory that records what it made and can be told to refuse. */
function factory() {
  const state = { made: [] as string[], disposed: 0, refuseFrom: Number.POSITIVE_INFINITY };
  const make = (label: string, widthPx: number, heightPx: number) => {
    if (state.made.length >= state.refuseFrom) throw new Error('device refused');
    state.made.push(label);
    return { label, widthPx, heightPx, dispose: () => { state.disposed += 1; } };
  };
  return { state, make };
}

/** A runtime at the top rung with a history behind it. */
function withHistory(over: Partial<ContinuityRuntimeOptions> = {}) {
  const f = factory();
  const r = runtime({ surfaceFactory: f.make, ...over });
  settle(r);
  return { r, f };
}

describe('the history lifecycle', () => {
  it('allocates once the rung that uses it is in force', () => {
    const { r, f } = withHistory();
    expect(f.state.made.length).toBe(3);
    expect(r.prepareFrame(frame()).historyRefusal).toBe(null);
  });

  it('allocates nothing without a factory, and refuses nothing either', () => {
    const r = runtime();
    settle(r);
    // A rung that cannot accumulate is not being refused anything.
    expect(r.prepareFrame(frame()).historyRefusal).toBe(null);
  });

  it('clears for a camera move and rebuilds for a resize', () => {
    const { r, f } = withHistory();
    const madeAfterSettle = f.state.made.length;
    r.prepareFrame(frame({ display: display({ camera: 'c1' }) }));
    expect(f.state.made.length).toBe(madeAfterSettle);
    r.prepareFrame(frame({ display: display({ camera: 'c1', widthPx: 640 }) }));
    expect(f.state.made.length).toBe(madeAfterSettle + 3);
  });

  it('rebuilds when the device is remade at the same size', () => {
    const { r, f } = withHistory();
    const before = f.state.made.length;
    r.prepareFrame(frame({ display: display({ deviceGeneration: 7 }) }));
    expect(f.state.made.length).toBe(before + 3);
  });

  it('gives up a rung when the device refuses to allocate', () => {
    const f = factory();
    f.state.refuseFrom = 0;
    const r = runtime({ surfaceFactory: f.make });
    // The refusal is reported on the frame it happens, which is the first one
    // that reaches the rung that asks for a history. By the next frame the
    // runtime is already a rung lower and is asking for nothing.
    const plans = [];
    for (let i = 0; i < 6; i++) {
      plans.push(r.prepareFrame(frame({ pressure: { aboveHighMs: 0, belowLowMs: 10_000 } })));
    }
    const refused = plans.filter((p) => p.historyRefusal === 'allocation-failed');
    expect(refused.length).toBe(1);
    // The rung is given up inside the same call, so the plan a caller acts on
    // already says closure and already reports accumulation off.
    expect(refused[0].tier).toBe('closure');
    expect(refused[0].capabilities.temporalAccumulation).toBe(false);
    expect(plans[plans.length - 1].capabilities.temporalAccumulation).toBe(false);
    expect(r.lastFailure).toBe('history-allocation-failed');
  });

  it('holds the ceiling there rather than asking again every frame', () => {
    const f = factory();
    f.state.refuseFrom = 0;
    const r = runtime({ surfaceFactory: f.make });
    settle(r);
    r.prepareFrame(frame());
    const asked = f.state.made.length;
    // A device that cannot keep a history now will not be able to in a
    // hundred frames.
    settle(r);
    for (let i = 0; i < 20; i++) r.prepareFrame(frame());
    expect(f.state.made.length).toBe(asked);
    expect(r.ceilingFor('full')).toBe('closure');
  });

  it('releases a partial set rather than keeping half a history', () => {
    // A colour history with no depth beside it is the photographic
    // accumulation this renderer must not do.
    const f = factory();
    f.state.refuseFrom = 2;
    const r = runtime({ surfaceFactory: f.make });
    settle(r);
    r.prepareFrame(frame());
    expect(f.state.disposed).toBe(2);
  });

  it('stops accumulating while there is no history to accumulate into', () => {
    const f = factory();
    f.state.refuseFrom = 0;
    const r = runtime({ surfaceFactory: f.make, phaseCount: 2 });
    settle(r);
    expect(r.prepareFrame(frame()).convergence.kind).toBe('idle');
  });

  it('releases the surfaces on dispose', () => {
    const { r, f } = withHistory();
    r.dispose();
    expect(f.state.disposed).toBe(3);
  });
});

describe('what a refusal may spend', () => {
  it('has no way to reach the scan', () => {
    // Display quality is the only thing a refusal costs: the runtime holds no
    // cloud, no store and no eviction path.
    const source = readFileSync(
      new URL('../src/render/continuity/ContinuityRuntime.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/evict|cloud|store|octree|resident/i);
    expect(code).toMatch(/private _maintainHistory/);
  });
});
