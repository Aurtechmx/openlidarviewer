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
