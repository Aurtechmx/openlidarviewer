/**
 * layerUpFrame.test.ts
 *
 * One per-layer rule decides which stored axis is up, and every consumer reads
 * it: terrain, conversion, measurement owner frames, navigation and the
 * lon/lat gates. A PLY under a projected CRS used to be analysed Z-up by the
 * terrain gather and the converter but measured and navigated Y-up.
 *
 * Pinned here: the rule's answer and basis for every case it names; a local
 * Y-up and a local Z-up PLY each resolve explicitly; a georeferenced PLY and
 * OBJ agree across terrain, measurement, conversion and navigation; a glTF or
 * GLB under a CRS stays refused everywhere; the navigation decision reads the
 * resolver; a CRS change re-aligns navigation and re-reads the owner frames.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  describeLayerUpFrame,
  resolveLayerUpFrame,
  spatialUpAxisOf,
  upFrameRefusal,
  upVectorOf,
} from '../src/geo/frame/layerUpFrame';
import { settleTerrainGatherFrame } from '../src/terrain/gatherUpAxis';
import { planAxisHandling } from '../src/convert/axisHandling';
import { classifyScanShape } from '../src/terrain/scanShape';
import { sceneUpOf, type SourceFormat } from '../src/io/sniffFormat';
import { loadPly } from '../src/io/loadPly';
import { PointCloud } from '../src/model/PointCloud';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { bindMeasureUnitFrames } from '../src/app/measureLayerUnits';
import { layerUpFrameOf, layerUpVectorResolver } from '../src/app/layerUpFrames';
import { buildLayerHealth, type LayerHealthInput } from '../src/app/layerHealth';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const Z: Vec3 = [0, 0, 1];
const Y: Vec3 = [0, 1, 0];
const UTM13N = { kind: 'projected', epsg: 32613, name: 'WGS 84 / UTM zone 13N', linearUnit: 'metre', linearUnitToMetres: 1, source: 'user-override', confidence: 'high', userConfirmed: true } as unknown as ResolvedCrs;
const LOCAL = { kind: 'local', name: 'Local', linearUnit: 'unknown', linearUnitToMetres: 1, source: 'user-override', confidence: 'low', userConfirmed: true } as unknown as ResolvedCrs;

function port(): CrsOverridePort {
  const store = new Map<string, unknown>();
  return {
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => void store.delete(k),
  } as CrsOverridePort;
}

/** A georeferenced survey line: two points 100 m apart in Z (height) at UTM coordinates. */
async function plyOf(rows: string[], name = 'axis.ply'): Promise<PointCloud> {
  const text = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows.join('\n')}\n`;
  return loadPly(new TextEncoder().encode(text).buffer as ArrayBuffer, name);
}

function as(cloud: PointCloud, format: SourceFormat, name: string): PointCloud {
  return new PointCloud({ positions: cloud.positions.slice(), origin: [...cloud.sourceOrigin] as [number, number, number], sourceFormat: format, name });
}

/** A Y-up mesh: a 60 x 60 floor in X/Z with 2 m of relief in Y. */
function yUpFloor(): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) out.push(i * 1.5, Math.sin(i * 0.3) + Math.cos(j * 0.2), j * 1.5);
  return Float32Array.from(out);
}

/** The same floor stored Z-up. */
function zUpFloor(): Float32Array {
  const y = yUpFloor();
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i += 3) {
    out[i] = y[i]!;
    out[i + 1] = y[i + 2]!;
    out[i + 2] = y[i + 1]!;
  }
  return out;
}

describe('the per-layer up rule', () => {
  it('survey formats are Z-up by specification, whatever the CRS', () => {
    for (const f of ['las', 'laz', 'xyz', 'e57', 'pcd', 'ptx', 'pts', 'pnts'] as const) {
      expect(resolveLayerUpFrame({ format: f, crs: null })).toEqual({ ok: true, axis: 'z', basis: 'specification' });
      expect(resolveLayerUpFrame({ format: f, crs: UTM13N })).toEqual({ ok: true, axis: 'z', basis: 'specification' });
    }
  });

  it('a PLY or OBJ under an established horizontal CRS stores easting, northing, height in X, Y, Z', () => {
    for (const f of ['ply', 'obj'] as const) {
      expect(resolveLayerUpFrame({ format: f, crs: UTM13N })).toEqual({ ok: true, axis: 'z', basis: 'crs' });
      // A Local CRS is the opt-out: the format rule applies.
      expect(resolveLayerUpFrame({ format: f, crs: LOCAL })).toEqual({ ok: true, axis: 'y', basis: 'explicit' });
    }
  });

  it('a glTF or GLB under a CRS is unresolved, with the reason and the fix', () => {
    for (const f of ['glb', 'gltf'] as const) {
      const r = resolveLayerUpFrame({ format: f, crs: UTM13N });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.basis).toBe('unresolved');
      expect(r.reason).toMatch(/glTF stores Y as the up axis by specification/);
      expect(r.reason).toMatch(/EPSG:32613/);
      expect(r.reason).toMatch(/set the scan's coordinate system to Local/);
      expect(upFrameRefusal(r)).toMatch(/^not available: no up axis; glTF/);
      expect(spatialUpAxisOf(r)).toBe('unknown');
      // Drawn and navigated Y-up meanwhile; never a metric claim.
      expect(upVectorOf(r)).toEqual(Y);
      // With no CRS it is Y-up by its specification.
      expect(resolveLayerUpFrame({ format: f, crs: null })).toEqual({ ok: true, axis: 'y', basis: 'specification' });
    }
  });

  it('a local Y-up PLY and a local Z-up PLY each resolve explicitly, and detection decides only where it runs', async () => {
    const yUp = await plyOf(['0 0 0', '0 5 0', '10 0 10']);
    const zUp = await plyOf(['0 0 0', '0 0 5', '10 10 0']);
    const crs = new CrsService(port());
    for (const c of [yUp, zUp]) {
      const f = layerUpFrameOf(crs, c, false);
      expect(f).toEqual({ ok: true, axis: 'y', basis: 'explicit' });
      expect(describeLayerUpFrame(f, 'ply')).toMatch(/^Y up \(PLY with no coordinate system is read Y-up; assign a CRS/);
      expect(spatialUpAxisOf(f)).toBe('unknown');
    }
    // The terrain gather reads the point layout for a mesh with no CRS.
    expect(classifyScanShape(yUpFloor()).up).toBe('y');
    expect(resolveLayerUpFrame({ format: 'ply', crs: null, detected: 'y' })).toEqual({ ok: true, axis: 'y', basis: 'detected' });
    expect(resolveLayerUpFrame({ format: 'ply', crs: null, detected: 'z' })).toEqual({ ok: true, axis: 'z', basis: 'detected' });
    expect(settleTerrainGatherFrame([{ format: 'ply', crs: null }], false, yUpFloor())).toEqual({ ok: true, up: 'y', basis: 'detected' });
    expect(settleTerrainGatherFrame([{ format: 'ply', crs: null }], false, zUpFloor())).toEqual({ ok: true, up: 'z', basis: 'detected' });
  });
});

describe('a georeferenced PLY and OBJ agree across terrain, measurement, conversion and navigation', () => {
  for (const format of ['ply', 'obj'] as const) {
    it(`${format.toUpperCase()} under EPSG:32613`, async () => {
      const loaded = await plyOf(['500000 4000000 100', '500000 4000000 200', '500100 4000100 150']);
      const cloud = format === 'ply' ? loaded : as(loaded, 'obj', 'axis.obj');
      const crs = new CrsService(port());
      crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'default-assumption', identity: datasetIdentity(cloud) });
      crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'default-assumption' });
      const stored = cloud.positions.slice();

      // Terrain: Z-up from the CRS, unrotated.
      const buffer = cloud.positions.slice();
      expect(settleTerrainGatherFrame([{ format, crs: crs.current() }], false, buffer)).toEqual({ ok: true, up: 'z', basis: 'crs' });
      expect(buffer).toEqual(stored);
      // Conversion: written as stored, X/Y/Z = easting/northing/height; the
      // Y-up rotation is refused because a CRS is in play.
      expect(planAxisHandling({ format, handling: 'preserve', mode: 'keep', sourceCrs: crs.current(), sourceEpsg: 32613, targetEpsg: null })).toEqual({ ok: true, rotate: false });
      expect(planAxisHandling({ format, handling: 'y-up-to-z-up', mode: 'keep', sourceCrs: crs.current(), sourceEpsg: 32613, targetEpsg: null }).ok).toBe(false);
      // Measurement owner frame: active and inactive both read Z.
      expect(layerUpFrameOf(crs, cloud, true)).toEqual({ ok: true, axis: 'z', basis: 'crs' });
      expect(layerUpFrameOf(crs, cloud, false)).toEqual({ ok: true, axis: 'z', basis: 'crs' });
      // Navigation: the scene up decision reads the same resolver.
      const upOf = layerUpVectorResolver(() => cloud, () => 'a', crs);
      expect(upOf('a')).toEqual(Z);
      expect(sceneUpOf(new Map([['a', { cloud }]]), 'a', upOf)).toEqual(Z);
      // The format-only decision is what it replaced.
      expect(sceneUpOf(new Map([['a', { cloud }]]), 'a')).toEqual(Y);
      // Nothing above moved a stored coordinate.
      expect(cloud.positions).toEqual(stored);
    });
  }

  it('a glTF under the same CRS is refused by terrain and conversion, and navigates by its drawn axis', async () => {
    const cloud = as(await plyOf(['500000 4000000 100', '500000 4000000 200']), 'glb', 'axis.glb');
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'default-assumption', identity: datasetIdentity(cloud) });
    crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'default-assumption' });
    const t = settleTerrainGatherFrame([{ format: 'glb', crs: crs.current() }], false, cloud.positions.slice());
    expect(t && !t.ok && t.reason).toMatch(/^Terrain analysis did not run\. glTF stores Y/);
    const c = planAxisHandling({ format: 'glb', handling: 'preserve', mode: 'keep', sourceCrs: crs.current(), sourceEpsg: 32613, targetEpsg: null });
    expect(!c.ok && c.message).toMatch(/^Nothing was written\. glTF stores Y/);
    expect(layerUpFrameOf(crs, cloud, true).ok).toBe(false);
    expect(layerUpVectorResolver(() => cloud, () => 'a', crs)('a')).toEqual(Y);
  });
});

describe('navigation up follows the resolved frame', () => {
  const las = new PointCloud({ positions: new Float32Array(3), origin: [0, 0, 0], sourceFormat: 'las', name: 'a.las' });
  const ply = new PointCloud({ positions: new Float32Array(3), origin: [0, 0, 0], sourceFormat: 'ply', name: 'b.ply' });
  const layers = new Map([['las', { cloud: las }], ['ply', { cloud: ply }]]);

  it('takes the named layer, else the last added, through the resolver; the format rule when it has no answer', () => {
    const resolver = (id: string): Vec3 | null => (id === 'ply' ? Z : null);
    expect(sceneUpOf(layers, 'ply', resolver)).toEqual(Z);
    expect(sceneUpOf(layers, null, resolver)).toEqual(Z);
    expect(sceneUpOf(layers, 'gone', resolver)).toEqual(Z);
    expect(sceneUpOf(layers, 'las', resolver)).toEqual(Z);
    expect(sceneUpOf(layers, 'ply', () => null)).toEqual(Y);
    expect(sceneUpOf(new Map(), null, resolver)).toBeNull();
  });

  it('a CRS change re-aligns navigation before the owner frames are re-read', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    const cloud = await plyOf(['500000 4000000 100', '500000 4000000 200']);
    const crs = new CrsService(port());
    crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'default-assumption', identity: datasetIdentity(cloud) });
    const order: string[] = [];
    const scene: Vec3[] = [];
    const upOf = layerUpVectorResolver(() => cloud, () => 'a', crs);
    const units = bindMeasureUnitFrames(measure, {
      activeId: () => 'a', clouds: () => ['a'], cloud: () => cloud, stableIdFor: () => 'layer-a', crs,
      realignUp: () => { order.push('realign'); scene.push(upOf('a')!); measure.setContext({ worldUp: upOf('a')!, origin: null }); },
    });
    const pts: [Vec3, Vec3] = [[0, 0, 0], [0, 0, 100]];
    measure.loadMeasurements([{ id: 'h', kind: 'height', name: 'h', closed: false, points: pts, pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' } } as Measurement]);
    units.onCrsChange();
    expect(scene.pop()).toEqual(Y);
    expect(measure.upFor(measure.getMeasurements()[0])).toEqual(Y);
    crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'default-assumption' });
    units.onCrsChange();
    expect(order).toEqual(['realign', 'realign']);
    expect(scene.pop()).toEqual(Z);
    expect(measure.upFor(measure.getMeasurements()[0])).toEqual(Z);
  });
});

describe('the layer details state the up axis and its basis', () => {
  const base: LayerHealthInput = {
    name: 'a.ply', crsName: 'WGS 84 / UTM zone 13N', crsSource: 'user-override', horizontalUnit: 'metre', verticalUnit: null,
    verticalDatum: null, compatibility: 'verified', mounted: true, sourceOrigin: null, frameOffset: null, precisionMm: null,
    precisionBasis: null, streaming: false, soleLayer: true,
  };
  const row = (upAxis: LayerHealthInput['upAxis']) => buildLayerHealth({ ...base, upAxis }).find((r) => r.label === 'Up axis');

  it('beside the CRS and units, on the primary rows of a sole layer', () => {
    const f = resolveLayerUpFrame({ format: 'ply', crs: UTM13N });
    const r = row({ basis: f.basis, text: describeLayerUpFrame(f, 'ply') });
    expect(r).toEqual({ label: 'Up axis', value: 'Z up (coordinate system: X, Y, Z read as easting, northing, height)', status: 'ok' });
    const labels = buildLayerHealth({ ...base, upAxis: { basis: f.basis, text: 'x' } }).map((x) => x.label);
    expect(labels.indexOf('Up axis')).toBe(labels.indexOf('Vertical datum') + 1);
  });

  it('a rule stated as a rule, and a refusal when unresolved', () => {
    const local = resolveLayerUpFrame({ format: 'ply', crs: null });
    expect(row({ basis: local.basis, text: describeLayerUpFrame(local, 'ply') })?.status).toBe('info');
    const las = resolveLayerUpFrame({ format: 'las', crs: null });
    expect(row({ basis: las.basis, text: describeLayerUpFrame(las, 'las') })?.value).toBe('Z up (LAS specification)');
    const glb = resolveLayerUpFrame({ format: 'glb', crs: UTM13N });
    const r = row({ basis: glb.basis, text: describeLayerUpFrame(glb, 'glb') });
    expect(r?.status).toBe('warn');
    expect(r?.value).toMatch(/^not resolved\. glTF stores Y as the up axis/);
    expect(row(null)).toBeUndefined();
  });
});
