/**
 * colorLayerUpFrame.test.ts
 *
 * Height colouring, the elevation scale and the colour legend read a cloud's
 * up component from its resolved layer frame, the rule measurement, terrain,
 * conversion and navigation share. They used to read the source format, so a
 * PLY under a projected CRS was coloured and labelled by northing.
 *
 * Pinned: a georeferenced PLY's Height ramp and legend range follow Z; a local
 * PLY keeps Y; a CRS change is detected as a moved axis so colours and the
 * legend are rebuilt.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadPly } from '../src/io/loadPly';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import { layerUpFrameOf } from '../src/app/layerUpFrames';
import { upVectorOf } from '../src/geo/frame/layerUpFrame';
import { cloudUpAxisIndex, cloudUpAxisMoved, setCloudUpResolver } from '../src/render/layerUpRegistry';
import { upAxisOf, elevationOptsFor } from '../src/render/projectElevationScale';
import { colorForMode } from '../src/render/colorModes';
import { buildColorLegend } from '../src/render/colorLegend';
import type { PointCloud } from '../src/model/PointCloud';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Viewer } from '../src/render/Viewer';
import { ELEVATION_FILTER_AXIS_CLEARED, reexpressElevationFilter } from '../src/app/elevationFilterAxis';

function port(): CrsOverridePort {
  const store = new Map<string, unknown>();
  return { get: (k) => store.get(k) as never, set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }), clear: (k) => void store.delete(k) } as CrsOverridePort;
}

/**
 * A sloping survey strip at UTM 13N: northing runs 0..200 m while the height
 * falls from 110 to 100 m, so a ramp along Y spans 200 m and runs the other way.
 */
async function strip(): Promise<PointCloud> {
  const rows: string[] = [];
  for (let i = 0; i <= 40; i++) rows.push(`${500000 + (i % 5)} ${4000000 + i * 5} ${100 + (40 - i) * 0.25}`);
  const text = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows.join('\n')}\n`;
  return loadPly(new TextEncoder().encode(text).buffer as ArrayBuffer, 'strip.ply');
}

function legendFor(cloud: PointCloud) {
  return buildColorLegend({
    activeColorMode: () => 'elevation',
    firstStaticCloud: () => cloud,
    streaming: () => null,
    heightPercentileTrim: () => 0,
    projectSharedElevationRange: () => null,
    elevationUnitLabel: () => 'm',
    worldUpIsZ: () => cloudUpAxisIndex(cloud) === 2,
    residentIntensityBuffers: () => [],
  }).activeColorbar();
}

/** The registry the running app installs: the cloud's own resolved frame. */
function install(crs: CrsService, cloud: PointCloud): void {
  setCloudUpResolver((c) => upVectorOf(layerUpFrameOf(crs, c, c === cloud)));
}

afterEach(() => setCloudUpResolver(null));

describe('display up axis follows the resolved layer frame', () => {
  it('a georeferenced PLY colours and labels Height along Z', async () => {
    const cloud = await strip();
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
    crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    install(crs, cloud);
    expect(upAxisOf(cloud)).toBe(2);
    expect(elevationOptsFor({ cloud, mode: 'elevation' }, null, 0).upAxis).toBe(2);
    const bar = legendFor(cloud)!;
    expect(bar.cloud?.[1]).toBe(2);
    expect(bar.spec.min).toBeCloseTo(100, 6);
    expect(bar.spec.max).toBeCloseTo(110, 6);
    const rgb = colorForMode('elevation', cloud, { upAxis: upAxisOf(cloud) as 1 | 2, heightPercentileTrim: 0 });
    const zRamp = colorForMode('elevation', cloud, { upAxis: 2, heightPercentileTrim: 0 });
    expect(Array.from(rgb)).toEqual(Array.from(zRamp));
    expect(Array.from(rgb)).not.toEqual(Array.from(colorForMode('elevation', cloud, { upAxis: 1, heightPercentileTrim: 0 })));
  });

  it('a local PLY keeps Y', async () => {
    const cloud = await strip();
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
    install(crs, cloud);
    expect(upAxisOf(cloud)).toBe(1);
    const bar = legendFor(cloud)!;
    expect(bar.spec.min).toBeCloseTo(4000000, 3);
    expect(bar.spec.max).toBeCloseTo(4000200, 3);
    // With no resolver registered the format rule applies, as before.
    setCloudUpResolver(null);
    expect(upAxisOf(cloud)).toBe(1);
  });

  it('a CRS assigned after colouring is a moved axis, so colours and the legend are rebuilt', async () => {
    const cloud = await strip();
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
    install(crs, cloud);
    expect(cloudUpAxisIndex(cloud)).toBe(1);
    expect(cloudUpAxisMoved([cloud])).toBe(false);
    crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    expect(cloudUpAxisMoved([cloud, undefined])).toBe(true);
    expect(cloudUpAxisIndex(cloud)).toBe(2);
    expect(cloudUpAxisMoved([cloud])).toBe(false);
  });
});

describe('the elevation filter after a layer\'s axis moves', () => {
  /** The Inspector's filter control as main.ts drives it: a changed extent resets it and clears the window. */
  function control(window: [number, number] | null, extent: { min: number; max: number }) {
    const state = { window, extent, applied: [] as Array<readonly [number, number] | undefined>, notes: [] as string[] };
    const deps = {
      active: () => state.window,
      extent: () => state.extent,
      seedExtent: (e: { min: number; max: number } | null) => {
        if (e && (e.min !== extent.min || e.max !== extent.max)) state.window = null;
      },
      apply: (r: readonly [number, number] | undefined) => state.applied.push(r),
      notify: (m: string) => state.notes.push(m),
    };
    return { state, deps };
  }

  it('each layer converts the window along its resolved axis', async () => {
    const cloud = await strip();
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
    install(crs, cloud);
    const elevLayerOf = (Viewer.prototype as unknown as { _elevLayerOf(c: PointCloud): { axis: number; originAlongAxis: number } })._elevLayerOf;
    expect(elevLayerOf.call({}, cloud)).toEqual({ axis: 1, originAlongAxis: cloud.origin[1] });
    crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    expect(elevLayerOf.call({}, cloud)).toEqual({ axis: 2, originAlongAxis: cloud.origin[2] });
  });

  it('a window whose extent moved is cleared with the reason, never applied along the old axis', () => {
    const { state, deps } = control([4000050, 4000100], { min: 4000000, max: 4000200 });
    state.extent = { min: 100, max: 110 };
    reexpressElevationFilter(deps);
    expect(state.window).toBeNull();
    expect(state.notes).toEqual([ELEVATION_FILTER_AXIS_CLEARED]);
    expect(state.applied).toEqual([]);
  });

  it('a window that still describes the scene is re-applied at once along the new axes', () => {
    const { state, deps } = control([102, 108], { min: 100, max: 110 });
    reexpressElevationFilter(deps);
    expect(state.notes).toEqual([]);
    expect(state.applied).toEqual([[102, 108]]);
  });

  it('main.ts re-expresses the filter when a CRS change moves an axis', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toMatch(/onUpAxisMoved: \(\) => reexpressElevationFilter\(\{ active: \(\) => activeElevFilter, extent: \(\) => viewer\.elevationExtent\(\), seedExtent: \(e\) => inspector\.setElevationExtent\(e\), apply: \(r\) => viewer\.setElevationFilter\(r\)/);
    const mount = readFileSync(resolve(__dirname, '../src/app/measurePanelMount.ts'), 'utf8');
    expect(mount).toMatch(/if \(cloudUpAxisMoved\(src\.clouds\(\)\.map\(src\.cloud\)\)\) \{\s*v\.refreshProjectSharedElevation\(true\);\s*src\.onUpAxisMoved\?\.\(\);/);
  });
});
