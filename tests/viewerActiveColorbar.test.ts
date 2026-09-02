/**
 * viewerActiveColorbar.test.ts
 *
 * Pins the colour-legend glue that assembles the colorbar spec — the seam
 * between the pure spec-builder (covered in activeColorbar.test.ts) and the
 * live scene state. The pure builder can't see the two things only the scene
 * knows:
 *
 *   - the STATIC path adds the cloud's up-axis origin back so the legend reads
 *     true world/source heights, not the render-local values the loader shifted
 *     to (`range + cloud.sourceOrigin[upAxis]`);
 *   - the STREAMING path reads the renderer's seeded cloud-global windows
 *     VERBATIM (adding the render origin's Z), gates the non-elevation scalar
 *     fields on `colorRangesSeeded` (pre-seed placeholders → null), and pins
 *     the trim disclosure to the fixed p5–p95 the reseed core uses.
 *
 * That glue moved off the Viewer into `buildColorLegend` (v0.6 decomposition),
 * so the test drives the collaborator against a hand-built host — no WebGL, no
 * class instantiation. `elevationExtent` / `intensityExtent` live on the same
 * collaborator and are pinned at the bottom.
 */

import { describe, it, expect } from 'vitest';
import {
  buildColorLegend,
  type ColorLegendHost,
  type ColorLegendStreaming,
} from '../src/render/colorLegend';
import { DEFAULT_ELEVATION_PALETTE, type ColorMode } from '../src/render/colorModes';
import type { ActiveColorbar } from '../src/render/activeColorbar';
import { PointCloud } from '../src/model/PointCloud';
import type { StreamingColorRanges } from '../src/render/streaming/streamingColors';

// ── Build a minimal host over hand-built scene state. ────────────────────────

interface HostState {
  streaming: ColorLegendStreaming | null;
  cloud: PointCloud | null;
  mode: ColorMode;
  heightPercentileTrim: number;
  elevationUnitLabel: string | null;
  worldUpIsZ?: boolean;
  residentIntensityBuffers?: readonly ArrayLike<number>[];
  projectSharedElevationRange?: { min: number; max: number } | null;
}

function host(state: HostState): ColorLegendHost {
  return {
    activeColorMode: () => state.mode,
    firstStaticCloud: () => state.cloud,
    streaming: () => state.streaming,
    heightPercentileTrim: () => state.heightPercentileTrim,
    projectSharedElevationRange: () => state.projectSharedElevationRange ?? null,
    elevationUnitLabel: () => state.elevationUnitLabel,
    worldUpIsZ: () => state.worldUpIsZ ?? true,
    residentIntensityBuffers: () => state.residentIntensityBuffers ?? [],
  };
}

function activeColorbar(state: HostState): ActiveColorbar | null {
  return buildColorLegend(host(state)).activeColorbar();
}

/** A tiny Z-up (LAS) cloud with Z spanning 0..30 and a non-zero world origin. */
function staticCloud(mode: ColorMode): HostState {
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
    streaming: null,
    cloud,
    mode,
    heightPercentileTrim: 0, // deterministic true-extent window for origin math
    elevationUnitLabel: 'm',
  };
}

function streamingState(
  mode: ColorMode,
  seeded: boolean,
  ranges: Partial<StreamingColorRanges> = {},
  zOff = 0,
  unit: string | null = 'm',
): HostState {
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
    streaming: {
      renderer: { colorRanges: full, colorRangesSeeded: seeded },
      cloud: {
        renderOrigin: [0, 0, zOff],
        dataBounds: () => [0, 0, full.minZ, 0, 0, full.maxZ],
      },
    },
    cloud: null,
    mode,
    heightPercentileTrim: 0,
    elevationUnitLabel: unit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Static path
// ─────────────────────────────────────────────────────────────────────────────

describe('colorLegend.activeColorbar — static path', () => {
  it('elevation adds the up-axis origin back so labels read world heights', () => {
    const bar = activeColorbar(staticCloud('elevation'));
    expect(bar).not.toBeNull();
    expect(bar!.mode).toBe('elevation');
    // render-local Z is 0..30; origin[2] = 1000 → world 1000..1030.
    expect(bar!.spec.min).toBe(1000);
    expect(bar!.spec.max).toBe(1030);
    expect(bar!.spec.unit).toBe('m');
    // The legend must sample whatever ramp the elevation colouring uses, so
    // this asserts the constant rather than a palette name.
    expect(bar!.spec.palette).toBe(DEFAULT_ELEVATION_PALETTE);
    // trim 0 ⇒ true extremes, no window note.
    expect(bar!.note).toBeUndefined();
  });

  it('elevation reports the project-shared world window when it is set', () => {
    const state = staticCloud('elevation');
    // Shared world range differs from this one cloud's 1000..1030 extent, so
    // the legend must describe the project window, not the per-cloud one.
    state.projectSharedElevationRange = { min: 990, max: 1050 };
    const bar = activeColorbar(state);
    expect(bar!.spec.min).toBe(990);
    expect(bar!.spec.max).toBe(1050);
  });

  it('elevation ignores a null shared window (falls back to per-cloud world range)', () => {
    const state = staticCloud('elevation');
    state.projectSharedElevationRange = null;
    const bar = activeColorbar(state);
    expect(bar!.spec.min).toBe(1000);
    expect(bar!.spec.max).toBe(1030);
  });

  it('elevation discloses the p5–p95 window when the trim slider is active', () => {
    const state = staticCloud('elevation');
    state.heightPercentileTrim = 5;
    const bar = activeColorbar(state);
    expect(bar!.note).toContain('p5–p95');
  });

  it('elevation shows bare numbers when the CRS unit is unknown', () => {
    const state = staticCloud('elevation');
    state.elevationUnitLabel = null;
    const bar = activeColorbar(state);
    expect(bar!.spec.unit).toBeUndefined();
  });

  it('intensity is grayscale, raw window, NO origin add-back and NO unit', () => {
    const bar = activeColorbar(staticCloud('intensity'));
    expect(bar!.spec.palette).toBe('grayscale');
    // finiteMinMax over [7,100,200,900] — NOT shifted by the origin.
    expect(bar!.spec.min).toBe(7);
    expect(bar!.spec.max).toBe(900);
    expect(bar!.spec.unit).toBeUndefined();
  });

  it('gpsTime normalises to seconds-from-window-start and discloses it', () => {
    const bar = activeColorbar(staticCloud('gpsTime'));
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBeGreaterThan(0);
    expect(bar!.spec.unit).toBe('s');
    expect(bar!.note).toContain('window start');
    expect(bar!.note).toContain('p5–p95');
  });

  it('returnNumber shows the raw ordinal window, no unit, no note', () => {
    const bar = activeColorbar(staticCloud('returnNumber'));
    expect(bar!.spec.min).toBe(1);
    expect(bar!.spec.max).toBe(5);
    expect(bar!.spec.unit).toBeUndefined();
    expect(bar!.note).toBeUndefined();
  });

  it('categorical modes and the empty scene yield no colorbar', () => {
    expect(activeColorbar(staticCloud('rgb'))).toBeNull();
    expect(activeColorbar(staticCloud('classification'))).toBeNull();
    // No clouds at all → null.
    const empty: HostState = {
      streaming: null,
      cloud: null,
      mode: 'rgb',
      heightPercentileTrim: 0,
      elevationUnitLabel: 'm',
    };
    expect(activeColorbar(empty)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming path
// ─────────────────────────────────────────────────────────────────────────────

describe('colorLegend.activeColorbar — streaming path (seeded)', () => {
  it('elevation reads the seeded window + render-origin Z, p5–p95 note', () => {
    const bar = activeColorbar(
      streamingState('elevation', true, { minZ: 2, maxZ: 40 }, 1000),
    );
    expect(bar).not.toBeNull();
    expect(bar!.spec.min).toBe(1002);
    expect(bar!.spec.max).toBe(1040);
    expect(bar!.note).toContain('p5–p95');
  });

  it('intensity reads the seeded grayscale window verbatim (no origin shift)', () => {
    const bar = activeColorbar(
      streamingState('intensity', true, { minIntensity: 3, maxIntensity: 4095 }, 1000),
    );
    expect(bar!.spec.palette).toBe('grayscale');
    expect(bar!.spec.min).toBe(3);
    expect(bar!.spec.max).toBe(4095);
  });

  it('gpsTime normalises the seeded window to seconds-from-start', () => {
    const bar = activeColorbar(
      streamingState('gpsTime', true, { minGpsTime: 300_000_000, maxGpsTime: 300_000_480 }),
    );
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBe(480);
    expect(bar!.spec.unit).toBe('s');
    expect(bar!.note).toContain('p5–p95');
  });

  it('returnNumber reads the seeded ordinal window', () => {
    const bar = activeColorbar(
      streamingState('returnNumber', true, { minReturnNumber: 1, maxReturnNumber: 4 }),
    );
    expect(bar!.spec.min).toBe(1);
    expect(bar!.spec.max).toBe(4);
    expect(bar!.note).toBeUndefined();
  });
});

describe('colorLegend.activeColorbar — streaming path (pre-seed)', () => {
  it('elevation is labelable pre-seed from the header cube, with NO trim note', () => {
    // Before the first node seeds, minZ/maxZ hold the header cube extent —
    // an honest window, and there is no percentile trim to disclose.
    const bar = activeColorbar(
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
    expect(activeColorbar(streamingState('intensity', false))).toBeNull();
    expect(activeColorbar(streamingState('gpsTime', false))).toBeNull();
    expect(activeColorbar(streamingState('returnNumber', false))).toBeNull();
  });

  it('categorical streaming modes yield no colorbar', () => {
    expect(activeColorbar(streamingState('rgb', true))).toBeNull();
    expect(activeColorbar(streamingState('classification', true))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extent seeds (elevation / intensity filter controls)
// ─────────────────────────────────────────────────────────────────────────────

describe('colorLegend.elevationExtent', () => {
  it('static: adds the up-axis origin back to the local bounds', () => {
    // Z-up cloud, Z spans 0..30 render-local, origin[2] = 1000 → world 1000..1030.
    const state = staticCloud('elevation');
    expect(buildColorLegend(host(state)).elevationExtent()).toEqual({ min: 1000, max: 1030 });
  });

  it('streaming: reads the header data bounds plus the render origin', () => {
    const state = streamingState('elevation', true, { minZ: 2, maxZ: 40 }, 1000);
    expect(buildColorLegend(host(state)).elevationExtent()).toEqual({ min: 1002, max: 1040 });
  });

  it('empty scene yields null', () => {
    const state: HostState = {
      streaming: null,
      cloud: null,
      mode: 'elevation',
      heightPercentileTrim: 0,
      elevationUnitLabel: 'm',
    };
    expect(buildColorLegend(host(state)).elevationExtent()).toBeNull();
  });
});

describe('colorLegend.intensityExtent', () => {
  it('static: min/max over the cloud intensity buffer', () => {
    const state = staticCloud('intensity'); // intensity [7,100,200,900]
    expect(buildColorLegend(host(state)).intensityExtent()).toEqual({ min: 7, max: 900 });
  });

  it('streaming: min/max over the resident intensity buffers', () => {
    const state = streamingState('intensity', true);
    state.residentIntensityBuffers = [new Uint16Array([12, 40]), new Uint16Array([5, 900])];
    expect(buildColorLegend(host(state)).intensityExtent()).toEqual({ min: 5, max: 900 });
  });

  it('streaming with no resident intensity yields null', () => {
    const state = streamingState('intensity', true);
    state.residentIntensityBuffers = [];
    expect(buildColorLegend(host(state)).intensityExtent()).toBeNull();
  });
});
