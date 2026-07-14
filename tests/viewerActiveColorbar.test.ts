/**
 * viewerActiveColorbar.test.ts
 *
 * Pins the Viewer glue that assembles the colorbar spec — the seam between the
 * pure spec-builder (covered in activeColorbar.test.ts) and the live scene
 * state. The pure builder can't see the two things that only the Viewer knows:
 *
 *   - the STATIC path adds the cloud's up-axis origin back so the legend reads
 *     true world/source heights, not the render-local values the loader shifted
 *     to (`range + entry.cloud.origin[upAxis]`);
 *   - the STREAMING path reads the renderer's seeded cloud-global windows
 *     VERBATIM (adding the render origin's Z), gates the non-elevation scalar
 *     fields on `colorRangesSeeded` (pre-seed placeholders → null), and pins
 *     the trim disclosure to the fixed p5–p95 the reseed core uses.
 *
 * The Viewer is far too heavy to instantiate in the node test env (WebGPU +
 * canvas), and `activeColorbar()` only touches a handful of instance members,
 * so — following the repo's Viewer-glue convention (see streamingReseed.test.ts,
 * which drives a real class method against a hand-built `this`) — we invoke the
 * REAL method bodies via `Viewer.prototype.*.call(fakeThis)`. This exercises the
 * actual shipped glue (origin math, seeded gating, mode dispatch), not a copy.
 */

import { describe, it, expect } from 'vitest';
import { Viewer } from '../src/render/Viewer';
import type { ColorMode } from '../src/render/colorModes';
import type { ActiveColorbar } from '../src/render/activeColorbar';
import { PointCloud } from '../src/model/PointCloud';
import type { StreamingColorRanges } from '../src/render/streaming/streamingColors';

// ── Invoke the real Viewer glue against a minimal hand-built `this`. ─────────

interface FakeStaticCloudEntry {
  cloud: PointCloud;
  mode: ColorMode;
}

interface FakeViewerState {
  _streaming: null | {
    renderer: {
      colorMode: ColorMode;
      colorRanges: StreamingColorRanges;
      colorRangesSeeded: boolean;
    };
    cloud: { renderOrigin: readonly [number, number, number] };
  };
  _clouds: Map<string, FakeStaticCloudEntry>;
  _heightPercentileTrim: number;
  _elevationUnitLabel: string | null;
}

/** Run the shipped `activeColorbar()` against a fake `this` (with the real
 *  `activeColorMode()` attached, since the method calls it). */
function callActiveColorbar(state: FakeViewerState): ActiveColorbar | null {
  const self = {
    ...state,
    activeColorMode: Viewer.prototype.activeColorMode,
  } as unknown as Viewer;
  return Viewer.prototype.activeColorbar.call(self);
}

/** A tiny Z-up (LAS) cloud with Z spanning 0..30 and a non-zero world origin. */
function staticCloud(mode: ColorMode): FakeViewerState {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 10,
    2, 0, 20,
    3, 0, 30,
  ]);
  const cloud = new PointCloud({
    positions,
    intensity: new Uint16Array([7, 100, 200, 900]),
    returnNumber: new Uint8Array([1, 2, 2, 5]),
    gpsTime: new Float64Array([300_000_000, 300_000_100, 300_000_200, 300_000_400]),
    // Non-zero up-axis origin (Z=1000) — proves the render-local → world
    // reconstruction actually fires for elevation and ONLY elevation.
    origin: [500, 600, 1000],
    sourceFormat: 'las',
    name: 'origin.las',
  });
  return {
    _streaming: null,
    _clouds: new Map([['c0', { cloud, mode }]]),
    _heightPercentileTrim: 0, // deterministic true-extent window for origin math
    _elevationUnitLabel: 'm',
  };
}

function streamingState(
  mode: ColorMode,
  seeded: boolean,
  ranges: Partial<StreamingColorRanges> = {},
  zOff = 0,
  unit: string | null = 'm',
): FakeViewerState {
  const full: StreamingColorRanges = {
    minZ: 0,
    maxZ: 30,
    minIntensity: 5,
    maxIntensity: 4095,
    minGpsTime: 300_000_000,
    maxGpsTime: 300_000_480,
    minReturnNumber: 1,
    maxReturnNumber: 5,
    ...ranges,
  };
  return {
    _streaming: {
      renderer: { colorMode: mode, colorRanges: full, colorRangesSeeded: seeded },
      cloud: { renderOrigin: [0, 0, zOff] },
    },
    _clouds: new Map(),
    _heightPercentileTrim: 0,
    _elevationUnitLabel: unit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Static path
// ─────────────────────────────────────────────────────────────────────────────

describe('Viewer.activeColorbar — static path', () => {
  it('elevation adds the up-axis origin back so labels read world heights', () => {
    const bar = callActiveColorbar(staticCloud('elevation'));
    expect(bar).not.toBeNull();
    expect(bar!.mode).toBe('elevation');
    // render-local Z is 0..30; origin[2] = 1000 → world 1000..1030.
    expect(bar!.spec.min).toBe(1000);
    expect(bar!.spec.max).toBe(1030);
    expect(bar!.spec.unit).toBe('m');
    expect(bar!.spec.palette).toBe('turbo');
    // trim 0 ⇒ true extremes, no window note.
    expect(bar!.note).toBeUndefined();
  });

  it('elevation discloses the p5–p95 window when the trim slider is active', () => {
    const state = staticCloud('elevation');
    state._heightPercentileTrim = 5;
    const bar = callActiveColorbar(state);
    expect(bar!.note).toContain('p5–p95');
  });

  it('elevation shows bare numbers when the CRS unit is unknown', () => {
    const state = staticCloud('elevation');
    state._elevationUnitLabel = null;
    const bar = callActiveColorbar(state);
    expect(bar!.spec.unit).toBeUndefined();
  });

  it('intensity is grayscale, raw window, NO origin add-back and NO unit', () => {
    const bar = callActiveColorbar(staticCloud('intensity'));
    expect(bar!.spec.palette).toBe('grayscale');
    // finiteMinMax over [7,100,200,900] — NOT shifted by the origin.
    expect(bar!.spec.min).toBe(7);
    expect(bar!.spec.max).toBe(900);
    expect(bar!.spec.unit).toBeUndefined();
  });

  it('gpsTime normalises to seconds-from-window-start and discloses it', () => {
    const bar = callActiveColorbar(staticCloud('gpsTime'));
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBeGreaterThan(0);
    expect(bar!.spec.unit).toBe('s');
    expect(bar!.note).toContain('window start');
    expect(bar!.note).toContain('p5–p95');
  });

  it('returnNumber shows the raw ordinal window, no unit, no note', () => {
    const bar = callActiveColorbar(staticCloud('returnNumber'));
    expect(bar!.spec.min).toBe(1);
    expect(bar!.spec.max).toBe(5);
    expect(bar!.spec.unit).toBeUndefined();
    expect(bar!.note).toBeUndefined();
  });

  it('categorical modes and the empty scene yield no colorbar', () => {
    expect(callActiveColorbar(staticCloud('rgb'))).toBeNull();
    expect(callActiveColorbar(staticCloud('classification'))).toBeNull();
    // No clouds at all → activeColorMode() falls back to 'rgb' → null.
    const empty: FakeViewerState = {
      _streaming: null,
      _clouds: new Map(),
      _heightPercentileTrim: 0,
      _elevationUnitLabel: 'm',
    };
    expect(callActiveColorbar(empty)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming path
// ─────────────────────────────────────────────────────────────────────────────

describe('Viewer.activeColorbar — streaming path (seeded)', () => {
  it('elevation reads the seeded window + render-origin Z, p5–p95 note', () => {
    const bar = callActiveColorbar(
      streamingState('elevation', true, { minZ: 2, maxZ: 40 }, 1000),
    );
    expect(bar).not.toBeNull();
    expect(bar!.spec.min).toBe(1002);
    expect(bar!.spec.max).toBe(1040);
    expect(bar!.note).toContain('p5–p95');
  });

  it('intensity reads the seeded grayscale window verbatim (no origin shift)', () => {
    const bar = callActiveColorbar(
      streamingState('intensity', true, { minIntensity: 3, maxIntensity: 4095 }, 1000),
    );
    expect(bar!.spec.palette).toBe('grayscale');
    expect(bar!.spec.min).toBe(3);
    expect(bar!.spec.max).toBe(4095);
  });

  it('gpsTime normalises the seeded window to seconds-from-start', () => {
    const bar = callActiveColorbar(
      streamingState('gpsTime', true, { minGpsTime: 300_000_000, maxGpsTime: 300_000_480 }),
    );
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBe(480);
    expect(bar!.spec.unit).toBe('s');
    expect(bar!.note).toContain('p5–p95');
  });

  it('returnNumber reads the seeded ordinal window', () => {
    const bar = callActiveColorbar(
      streamingState('returnNumber', true, { minReturnNumber: 1, maxReturnNumber: 4 }),
    );
    expect(bar!.spec.min).toBe(1);
    expect(bar!.spec.max).toBe(4);
    expect(bar!.note).toBeUndefined();
  });
});

describe('Viewer.activeColorbar — streaming path (pre-seed)', () => {
  it('elevation is labelable pre-seed from the header cube, with NO trim note', () => {
    // Before the first node seeds, minZ/maxZ hold the header cube extent —
    // an honest window, and there is no percentile trim to disclose.
    const bar = callActiveColorbar(
      streamingState('elevation', false, { minZ: 0, maxZ: 30 }, 0),
    );
    expect(bar).not.toBeNull();
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBe(30);
    expect(bar!.note).toBeUndefined();
  });

  it('intensity / gpsTime / returnNumber yield NO colorbar pre-seed (placeholders)', () => {
    // The scalar fields are 0..1 placeholders before a node seeds them —
    // labelling them would assert a window that describes nothing.
    expect(callActiveColorbar(streamingState('intensity', false))).toBeNull();
    expect(callActiveColorbar(streamingState('gpsTime', false))).toBeNull();
    expect(callActiveColorbar(streamingState('returnNumber', false))).toBeNull();
  });

  it('categorical streaming modes yield no colorbar', () => {
    expect(callActiveColorbar(streamingState('rgb', true))).toBeNull();
    expect(callActiveColorbar(streamingState('classification', true))).toBeNull();
  });
});
