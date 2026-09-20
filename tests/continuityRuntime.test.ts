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
