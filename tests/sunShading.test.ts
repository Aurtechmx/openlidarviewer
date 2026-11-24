/**
 * The sun shading controller: off changes nothing, what is drawn and what the
 * legend says agree, and its codes and its pass end with the layer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { colorForMode } from '../src/render/colorModes';
import { elevationShadeNote, setElevationShade } from '../src/render/sunShading/elevationShade';
import { packNormal, type SurfaceFrame } from '../src/render/sunShading/surfaceNormals';
import { NoSurfaceError } from '../src/render/sunShading/sunNormalsWorkerClient';
import { SUN_STREAMING_REASON } from '../src/render/sunShading/streamingReason';
import { createSunShading, SHADED_NOTE, sunFrameOf, type SunShadingHost } from '../src/app/sunShading';
import { buildColorLegend } from '../src/render/colorLegend';
import { colorbarBurnInNotes } from '../src/render/snapshot';
import { unknownCrs } from '../src/geo/CoordinateTypes';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const N = 20;
function cloud(name = 'a'): PointCloud {
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) positions.set([i, i % 3, i * 0.5], i * 3);
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name } as ConstructorParameters<typeof PointCloud>[0]);
}

const projected = (patch: Partial<ResolvedCrs> = {}): ResolvedCrs =>
  ({ ...unknownCrs(), kind: 'projected', linearUnit: 'metre', linearUnitToMetres: 1, ...patch }) as ResolvedCrs;

interface Pending { frame: SurfaceFrame; signal: AbortSignal; resolve(c?: Uint16Array): void; reject(e: Error): void }

function setup(opts: { crs?: ResolvedCrs; streaming?: boolean } = {}) {
  const layers = new Map([['1', { cloud: cloud(), mode: 'elevation' as string }]]);
  const state = { crs: opts.crs ?? projected(), streaming: opts.streaming ?? false };
  let crsListener: () => void = () => {};
  const repaint = vi.fn(() => viewer.onColorContextChanged?.());
  const legend = vi.fn();
  const viewer = {
    clouds: () => [...layers.keys()],
    getCloud: (id: string) => layers.get(id)?.cloud,
    colorModeOf: (id: string) => layers.get(id)?.mode,
    isStreamingActive: () => state.streaming,
    refreshProjectSharedElevation: repaint,
    requestFrame: () => {},
    onColorContextChanged: legend as (() => void) | undefined,
  };
  const jobs: Pending[] = [];
  const compute = (_p: Float32Array, frame: SurfaceFrame, signal: AbortSignal): Promise<Uint16Array> =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
      jobs.push({ frame, signal, resolve: (c = new Uint16Array(N).fill(packNormal(0.2, -0.2))) => resolve(c), reject });
    });
  const host = {
    viewer,
    crs: {
      current: () => state.crs,
      resolveFor: () => state.crs,
      context: () => { throw new Error('unused'); },
      subscribe: (l: () => void) => { crsListener = l; return () => { crsListener = () => {}; }; },
    },
    activeId: () => '1',
  } as unknown as SunShadingHost;
  const said: { status: string; busy: boolean; enabled: boolean }[] = [];
  const sun = createSunShading(host, (s) => said.push(s), compute);
  return {
    sun, layers, state, jobs, repaint, legend, viewer, host,
    crsMoved: () => crsListener(),
    last: () => said.at(-1)!,
    tick: async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); },
    bytes: () => colorForMode('elevation', layers.get('1')!.cloud),
  };
}

afterEach(() => { setElevationShade(null); vi.useRealTimers(); });

describe('off', () => {
  it('is the default: no pass, no repaint, no note, the same bytes', () => {
    const plain = colorForMode('elevation', cloud());
    const t = setup();
    t.viewer.onColorContextChanged?.();
    t.crsMoved();
    expect(t.jobs).toHaveLength(0);
    expect(t.repaint).not.toHaveBeenCalled();
    expect(elevationShadeNote()).toBeNull();
    expect(Array.from(t.bytes())).toEqual(Array.from(plain));
  });

  it('returns to the same bytes after being on', async () => {
    const t = setup();
    const plain = Array.from(t.bytes());
    t.sun.set({ strength: 1 });
    t.jobs[0].resolve();
    await t.tick();
    expect(Array.from(t.bytes())).not.toEqual(plain);
    const before = t.repaint.mock.calls.length;
    t.sun.set({ strength: 0 });
    expect(t.repaint.mock.calls.length).toBe(before + 1);
    expect(Array.from(t.bytes())).toEqual(plain);
    expect(elevationShadeNote()).toBeNull();
  });
});

describe('on', () => {
  it('shades only once the directions are in, and only then says so', async () => {
    const t = setup();
    const plain = Array.from(t.bytes());
    t.sun.set({ strength: 0.8 });
    expect(t.last()).toMatchObject({ busy: true, enabled: true });
    expect(Array.from(t.bytes())).toEqual(plain);
    expect(elevationShadeNote()).toBeNull();
    t.jobs[0].resolve();
    await t.tick();
    expect(t.last()).toMatchObject({ busy: false, status: '' });
    expect(elevationShadeNote()).toBe(SHADED_NOTE);
    expect(Array.from(t.bytes())).not.toEqual(plain);
    expect(t.sun.heldBytes()).toBe(N * 2);
    expect(t.legend).toHaveBeenCalled(); // the shell's own legend hook still runs
  });

  it('changes the light without a new pass, one repaint for a burst', async () => {
    const t = setup();
    t.sun.set({ strength: 0.8 });
    t.jobs[0].resolve();
    await t.tick();
    const a = Array.from(t.bytes());
    vi.useFakeTimers();
    const before = t.repaint.mock.calls.length;
    for (let az = 0; az < 180; az += 10) t.sun.set({ azimuthDeg: az });
    vi.runAllTimers();
    expect(t.repaint.mock.calls.length).toBe(before + 1);
    expect(t.jobs).toHaveLength(1);
    expect(Array.from(t.bytes())).not.toEqual(a);
  });

  it('puts the note on the legend and under an exported colourbar', async () => {
    const t = setup();
    const legend = buildColorLegend({
      activeColorMode: () => 'elevation', firstStaticCloud: () => t.layers.get('1')!.cloud, streaming: () => null,
      heightPercentileTrim: () => 5, projectSharedElevationRange: () => null, elevationUnitLabel: () => 'm',
      worldUpIsZ: () => true, residentIntensityBuffers: () => [],
    });
    expect(legend.activeColorbar()!.shading).toBeUndefined();
    const plainNotes = colorbarBurnInNotes(legend.activeColorbar()!);
    t.sun.set({ strength: 1 });
    t.jobs[0].resolve();
    await t.tick();
    const bar = legend.activeColorbar()!;
    expect(bar.shading).toBe(SHADED_NOTE);
    expect(colorbarBurnInNotes(bar)).toEqual([plainNotes[0], SHADED_NOTE, ...plainNotes.slice(1)]);
  });

  it('works through several layers one at a time', async () => {
    const t = setup();
    t.layers.set('2', { cloud: cloud('b'), mode: 'elevation' });
    t.layers.set('3', { cloud: cloud('c'), mode: 'rgb' });
    t.sun.set({ strength: 1 });
    expect(t.jobs).toHaveLength(1);
    t.jobs[0].resolve();
    await t.tick();
    expect(t.jobs).toHaveLength(2);
    t.jobs[1].resolve();
    await t.tick();
    expect(t.jobs).toHaveLength(2); // the RGB layer needs none
  });
});

describe('what ends a pass or drops its result', () => {
  it('closing the layer aborts the pass and frees the codes', async () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.layers.clear();
    t.viewer.onColorContextChanged?.();
    expect(t.jobs[0].signal.aborted).toBe(true);
    t.layers.set('1', { cloud: cloud(), mode: 'elevation' });
    await t.tick();
    t.jobs.at(-1)!.resolve();
    await t.tick();
    expect(t.sun.heldBytes()).toBe(N * 2);
    t.layers.clear();
    t.viewer.onColorContextChanged?.();
    expect(t.sun.heldBytes()).toBe(0);
    expect(elevationShadeNote()).toBeNull();
  });

  it('a new vertical unit drops the codes and lights the layer again', async () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.jobs[0].resolve();
    await t.tick();
    t.state.crs = projected({ verticalUnitToMetres: 0.3048 });
    t.crsMoved();
    expect(elevationShadeNote()).toBeNull();
    expect(t.jobs).toHaveLength(2);
    expect(t.jobs[1].frame).toEqual({ upAxis: 2, verticalScale: 0.3048 });
  });

  it('an unrelated CRS event keeps them', async () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.jobs[0].resolve();
    await t.tick();
    t.crsMoved();
    expect(t.jobs).toHaveLength(1);
    expect(t.sun.heldBytes()).toBe(N * 2);
  });

  it('Cancel stops the pass and switches shading off', async () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.sun.cancel();
    await t.tick();
    expect(t.jobs[0].signal.aborted).toBe(true);
    expect(t.sun.settings.strength).toBe(0);
    expect(t.last()).toMatchObject({ busy: false, status: '' });
  });

  it('a failure is stated once and not retried in a loop', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.sun.set({ strength: 1 });
    t.jobs[0].reject(new Error('no worker'));
    await t.tick();
    expect(t.last().status).toMatch(/could not run/);
    expect(t.jobs).toHaveLength(1);
    expect(elevationShadeNote()).toBeNull();
    warn.mockRestore();
  });

  it('a cloud with no surface says so', async () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.jobs[0].reject(new NoSurfaceError('x'));
    await t.tick();
    expect(t.last().status).toMatch(/too few points/);
  });

  it('dispose restores the legend hook and clears everything', () => {
    const t = setup();
    t.sun.set({ strength: 1 });
    t.sun.dispose();
    expect(t.jobs[0].signal.aborted).toBe(true);
    expect(t.viewer.onColorContextChanged).toBe(t.legend);
    expect(t.sun.heldBytes()).toBe(0);
  });
});

describe('where it is refused', () => {
  it('a streamed scan: no pass, no shading, and the reason', () => {
    const t = setup({ streaming: true });
    t.sun.set({ strength: 1 });
    expect(t.jobs).toHaveLength(0);
    expect(t.last()).toMatchObject({ enabled: false, status: SUN_STREAMING_REASON });
  });

  it('coordinates in degrees', () => {
    const t = setup({ crs: projected({ kind: 'geographic', linearUnit: 'unknown' }) });
    t.sun.set({ strength: 1 });
    expect(t.jobs).toHaveLength(0);
    expect(t.last().status).toMatch(/degrees/);
  });

  it('a declared height unit that cannot be read', () => {
    const t = setup({ crs: projected({ verticalUnitToMetres: Number.NaN }) });
    t.sun.set({ strength: 1 });
    expect(t.jobs).toHaveLength(0);
    expect(t.last().status).toMatch(/height unit/);
  });

  it('a foot grid with foot heights, and no CRS at all, need no scaling', () => {
    const t = setup();
    const c = t.layers.get('1')!.cloud;
    t.state.crs = projected({ linearUnit: 'foot', linearUnitToMetres: 0.3048 });
    expect(sunFrameOf(c, t.host.crs, true)).toEqual({ upAxis: 2, verticalScale: 1 });
    t.state.crs = unknownCrs();
    expect(sunFrameOf(c, t.host.crs, true)).toEqual({ upAxis: 2, verticalScale: 1 });
  });
});
