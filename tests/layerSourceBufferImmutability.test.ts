/**
 * tests/layerSourceBufferImmutability.test.ts
 *
 * A mount must never touch the loaded data. Membership of the shared project
 * frame is a Float64 placement held beside the cloud, so mounting and unmounting
 * are reversible by construction: the position array, the origin the file
 * declared, and the cloud's own source frame all come out of the round trip
 * bit-identical.
 *
 * This is the property the ownership model rests on. If a mount rewrote the
 * buffer, saved work expressed in source-local coordinates would silently mean
 * something else after the layer joined a project, and no amount of persisted
 * ownership would recover it.
 */

import { describe, it, expect } from 'vitest';
import { createLayerService } from '../src/app/LayerService';
import { resolvedFromCrsInfo, unknownCrs } from '../src/geo/CoordinateTypes';
import { createAppContext } from '../src/app/appContext';
import { createProjectFrameService } from '../src/app/projectFrame';
import { PointCloud } from '../src/model/PointCloud';
import { placePoint } from '../src/render/layerPlacement';
import type { LayerSpatialTransform } from '../src/geo/ProjectSpatialFrame';
import type { Viewer } from '../src/render/Viewer';
import type { Inspector } from '../src/ui/Inspector';

const CRS = {
  epsg: 25830,
  name: 'ETRS89 / UTM zone 30N',
  linearUnitToMetres: 1,
  verticalUnitToMetres: 1,
  verticalDatum: 'EGM2008',
};

function cloudAt(name: string, origin: [number, number, number]): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1.25, 2.5, 3.75, 10.5, 20.25, 1.5]),
    origin,
    sourceFormat: 'las',
    name,
    metadata: { crs: CRS } as unknown as PointCloud['metadata'],
  });
}

/**
 * Drive the real LayerService over real PointCloud objects. The viewer is a
 * fake because a Viewer needs a GPU context, but the clouds are not: the point
 * of the test is that nothing in the layer pass reaches into their buffers.
 */
function mountHarness(clouds: Record<string, PointCloud>, multiLayerMount: boolean) {
  const context = createAppContext();
  const placements = new Map<string, LayerSpatialTransform | null>();
  const mounted = new Map<string, boolean>();
  const viewer = {
    clouds: () => Object.keys(clouds),
    getCloud: (id: string) => clouds[id] ?? null,
    isCloudLocked: () => false,
    setCloudVisible: () => {},
    setLayerPlacement: (id: string, placement: LayerSpatialTransform | null) => {
      placements.set(id, placement);
    },
    setCloudCompatibility: () => {},
    setCloudMounted: (id: string, m: boolean) => {
      mounted.set(id, m);
    },
  } as unknown as Viewer;
  const inspector = {
    setLayerSolo: () => {},
    setLayerCrsFlags: () => {},
    setLayerHealth: () => {},
    setLayerCompareAvailable: () => {},
  } as unknown as Inspector;
  const service = createLayerService({
    getViewer: () => viewer,
    getInspector: () => inspector,
    context,
    resolveCrs: (_name, detected) =>
      resolvedFromCrsInfo(detected ?? undefined, 'las-vlr') ?? unknownCrs(),
    refreshCompass: () => {},
    projectFrame: createProjectFrameService(context),
    multiLayerMount,
  });
  return { service, placements, mounted, context };
}

describe('source buffers are immutable across mount and unmount', () => {
  it('leaves every position, origin and source origin bit-identical', () => {
    const a = cloudAt('scan.laz', [516_000, 4_644_000, 70]);
    const b = cloudAt('scan.laz', [516_100, 4_644_050, 71]);
    const before = {
      aPositions: Float32Array.from(a.positions),
      bPositions: Float32Array.from(b.positions),
      aBuffer: a.positions,
      bBuffer: b.positions,
      aOrigin: [...a.origin],
      bOrigin: [...b.origin],
      aSource: [...a.sourceOrigin],
      bSource: [...b.sourceOrigin],
    };

    // Mount…
    const { service, placements } = mountHarness({ a, b }, true);
    service.refreshCrsFlags();
    expect(placements.get('b')).not.toBeNull();

    // …then unmount, by taking the second layer out of the set entirely.
    const { service: solo } = mountHarness({ a }, true);
    solo.refreshCrsFlags();

    expect(a.positions).toBe(before.aBuffer);
    expect(b.positions).toBe(before.bBuffer);
    expect([...a.positions]).toEqual([...before.aPositions]);
    expect([...b.positions]).toEqual([...before.bPositions]);
    expect([...a.origin]).toEqual(before.aOrigin);
    expect([...b.origin]).toEqual(before.bOrigin);
    expect([...a.sourceOrigin]).toEqual(before.aSource);
    expect([...b.sourceOrigin]).toEqual(before.bSource);
  });

  it('is the same for a mount that is refused on precision', () => {
    // 400 km apart: a Float32 rebase would spend the mantissa the residual
    // needs, so the mount is refused. The buffers are untouched either way.
    const a = cloudAt('near.laz', [516_000, 4_644_000, 70]);
    const far = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1.25, 2.5, 3.75]),
      origin: [916_000, 4_644_000, 70],
      sourceFormat: 'las',
      name: 'far.laz',
      metadata: { crs: CRS } as unknown as PointCloud['metadata'],
    });
    const snapshot = Float32Array.from(far.positions);
    const { service } = mountHarness({ a, far }, true);
    service.refreshCrsFlags();
    expect([...far.positions]).toEqual([...snapshot]);
    expect([...far.sourceOrigin]).toEqual([916_000, 4_644_000, 70]);
  });

  it('reads a placed point through the transform instead of moving the data', () => {
    const a = cloudAt('scan.laz', [516_000, 4_644_000, 70]);
    const b = cloudAt('scan.laz', [516_100, 4_644_050, 71]);
    const { service, placements } = mountHarness({ a, b }, true);
    service.refreshCrsFlags();
    const placement = placements.get('b') as LayerSpatialTransform;
    // The stored vertex is still source-local…
    expect([b.positions[3], b.positions[4], b.positions[5]]).toEqual([1.25, 2.5, 3.75]);
    // …and the project-local reading is produced by folding the transform.
    expect(placePoint([1.25, 2.5, 3.75], placement)).toEqual([
      1.25 + placement.sourceToProject[0],
      2.5 + placement.sourceToProject[1],
      3.75 + placement.sourceToProject[2],
    ]);
  });

  it('holds with mounting disabled, which is how the app ships', () => {
    const a = cloudAt('scan.laz', [516_000, 4_644_000, 70]);
    const b = cloudAt('scan.laz', [516_100, 4_644_050, 71]);
    const snapshot = Float32Array.from(b.positions);
    const { service, placements } = mountHarness({ a, b }, false);
    service.refreshCrsFlags();
    expect(placements.get('b') ?? null).toBeNull();
    expect([...b.positions]).toEqual([...snapshot]);
    expect([...b.sourceOrigin]).toEqual([516_100, 4_644_050, 71]);
  });
});
