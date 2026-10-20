/**
 * gltfTerrainUpAxis.test.ts
 *
 * glTF 2.0 fixes +Y as up (section 3.4), with or without a map CRS. The terrain
 * gather used to read a local glTF's up axis from its point layout, so a wall
 * stored Y-up (60 m wide, 60 m tall, 0.1 m thick) read as Z-up, and its 0.1 m
 * thickness became the terrain's elevation range.
 *
 * Pinned here, through the real glTF loader and the shipped gather: a glTF or
 * GLB with no CRS is gathered Y-up by specification and rotated into Z-up; a
 * wall stays a wall, a floor a floor and a compact object keeps its shape class;
 * a node transform is honoured; the loaded cloud is not modified and a second
 * gather does not rotate twice; and a glTF beside a layer of a different up
 * axis is declined until one side is hidden or removed.
 */

import { describe, it, expect } from 'vitest';
import { loadGltf } from '../src/io/loadGltf';
import { Viewer } from '../src/render/Viewer';
import { PointCloud } from '../src/model/PointCloud';
import type { SourceFormat } from '../src/io/sniffFormat';
import type { CrsInfo } from '../src/io/crs';
import { resolveLayerUpFrame } from '../src/geo/frame/layerUpFrame';
import { classifyScanShape } from '../src/terrain/scanShape';
import { MIXED_FRAME_REASON, MIXED_GLTF_FRAME_REASON } from '../src/terrain/gatherUpAxis';

/** A deterministic pseudo-random sequence, so the fixtures never change. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Shape = 'floor' | 'wall' | 'box';

/**
 * Points of one shape as stored in the glTF mesh, in glTF's Y-up frame:
 * - floor: 60 m by 60 m in X-Z, 0.1 m thick in Y;
 * - wall: 60 m wide in X, 60 m tall in Y, 0.1 m thick in Z;
 * - box: the six faces of a 10 m cube.
 */
function meshPoints(shape: Shape): Float32Array {
  const r = rng(37);
  const out: number[] = [];
  for (let i = 0; i < 6000; i++) {
    if (shape === 'floor') out.push(r() * 60, r() * 0.1, r() * 60);
    else if (shape === 'wall') out.push(r() * 60, r() * 60, r() * 0.1);
    else {
      const face = i % 6;
      const a = r() * 10;
      const b = r() * 10;
      const c = face % 2 === 0 ? 0 : 10;
      const axis = Math.floor(face / 2);
      out.push(...(axis === 0 ? [c, a, b] : axis === 1 ? [a, c, b] : [a, b, c]));
    }
  }
  return Float32Array.from(out);
}

/** An embedded glTF or GLB holding `points` as one point primitive under one node. */
function gltfBytes(points: Float32Array, format: 'gltf' | 'glb', node: Record<string, unknown> = {}): ArrayBuffer {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    min[i % 3] = Math.min(min[i % 3], points[i]);
    max[i % 3] = Math.max(max[i % 3], points[i]);
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, ...node }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: points.length / 3, type: 'VEC3', min, max }],
      bufferViews: [{ buffer: 0, byteLength: points.byteLength }],
      buffers: [
        {
          byteLength: points.byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(points.buffer, points.byteOffset, points.byteLength).toString('base64')}`,
        },
      ],
    }),
  );
  if (format === 'gltf') return json.buffer.slice(json.byteOffset, json.byteOffset + json.byteLength) as ArrayBuffer;
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const glb = new Uint8Array(20 + jsonLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.fill(0x20, 20);
  glb.set(json, 20);
  return glb.buffer;
}

interface Layer {
  cloud: PointCloud;
  visible?: boolean;
}

/** The shipped gather over a fake `this` holding real clouds, none with an app-resolved CRS. */
function viewerOver(layers: Layer[]): { v: Viewer; clouds: Map<string, unknown> } {
  const clouds = new Map<string, unknown>(
    layers.map((l, i) => [String(i), { cloud: l.cloud, mesh: { visible: l.visible ?? true }, locked: false }]),
  );
  const v = Object.assign(Object.create(Viewer.prototype) as object, {
    _clouds: clouds,
    _streamingMayCombine: () => false,
    _streamingPickData: new Map(),
    profileSeam: { fullyResident: () => true },
    _exportCrsResolver: null,
  }) as unknown as Viewer;
  return { v, clouds };
}

/** Max minus min of one axis of an interleaved XYZ buffer. */
function span(p: Float32Array, axis: 0 | 1 | 2): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) {
    lo = Math.min(lo, p[i]);
    hi = Math.max(hi, p[i]);
  }
  return hi - lo;
}

/** A cloud of another format, built directly. */
function cloudOf(format: SourceFormat, positions: Float32Array, crs?: CrsInfo): PointCloud {
  return new PointCloud({
    positions,
    origin: [0, 0, 0],
    sourceFormat: format,
    name: `layer.${format}`,
    ...(crs ? { metadata: { crs } } : {}),
  });
}

/** A gently sloping, Z-up terrain patch: 60 m by 60 m with 3 m of relief. */
function zUpTerrain(): Float32Array {
  const r = rng(11);
  const out: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const x = r() * 60;
    const y = r() * 60;
    out.push(x, y, 0.05 * x + 0.5 * Math.sin(y / 9) + r() * 0.05);
  }
  return Float32Array.from(out);
}

const UTM13N = {
  source: 'wkt',
  wkt: 'PROJCS["WGS 84 / UTM zone 13N",AUTHORITY["EPSG","32613"]]',
  name: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
} as CrsInfo;

describe('the shared up-frame rule', () => {
  it('resolves a glTF or GLB with no CRS as Y-up by specification, whatever the point layout reads as', () => {
    for (const format of ['gltf', 'glb'] as SourceFormat[]) {
      for (const detected of [undefined, 'z', 'y'] as const) {
        expect(resolveLayerUpFrame({ format, crs: null, ...(detected ? { detected } : {}) })).toEqual({
          ok: true,
          axis: 'y',
          basis: 'specification',
        });
      }
    }
  });
});

describe('a glTF or GLB with no CRS, through the real loader and the shipped gather', () => {
  for (const format of ['gltf', 'glb'] as const) {
    for (const shape of ['floor', 'wall', 'box'] as const) {
      it(`${format} ${shape}: gathered Y-up by specification, keeping its shape class`, async () => {
        const cloud = await loadGltf(gltfBytes(meshPoints(shape), format), format);
        const stored = Float32Array.from(cloud.positions!);
        const { v } = viewerOver([{ cloud }]);
        const g = v.gatherTerrainPositions();
        expect(g?.sourceUpAxis).toBe('y');
        expect(g?.upAxisBasis).toBe('specification');
        // The shape class in the specified frame is the one routing sees.
        const specified = classifyScanShape(stored, { verticalAxis: 'y' });
        const gathered = classifyScanShape(g!.positions, { verticalAxis: g!.verticalAxisHint });
        expect(gathered.nonTerrain).toBe(specified.nonTerrain);
        // Elevation in the gathered buffer is the stored Y.
        expect(span(g!.positions, 2)).toBeCloseTo(span(stored, 1), 3);
        if (shape === 'floor') expect(gathered.nonTerrain).toBe(false);
        if (shape === 'wall') {
          expect(gathered.nonTerrain).toBe(true);
          expect(span(g!.positions, 2)).toBeGreaterThan(59);
        }
        // The loaded cloud is untouched.
        expect(cloud.positions).toEqual(stored);
      });
    }
  }

  it('honours a node transform: an X-Y plane rotated -90 degrees about X and translated is a floor', async () => {
    const plane = meshPoints('wall'); // X-Y plane in the mesh's own frame
    const node = { rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], translation: [100, 5, -50] };
    for (const format of ['gltf', 'glb'] as const) {
      const cloud = await loadGltf(gltfBytes(plane, format, node), format);
      // Loaded in the scene frame: spread across X-Z, thin in Y, at y = 5.
      expect(span(cloud.positions!, 1)).toBeLessThan(0.2);
      const g = viewerOver([{ cloud }]).v.gatherTerrainPositions();
      expect(g?.sourceUpAxis).toBe('y');
      expect(span(g!.positions, 2)).toBeLessThan(0.2);
      expect(classifyScanShape(g!.positions, { verticalAxis: 'z' }).nonTerrain).toBe(false);
    }
  });

  it('does not rotate twice: two gathers of the same layer give the same buffer', async () => {
    const cloud = await loadGltf(gltfBytes(meshPoints('wall'), 'glb'), 'glb');
    const { v } = viewerOver([{ cloud }]);
    const first = Float32Array.from(v.gatherTerrainPositions()!.positions);
    const second = v.gatherTerrainPositions()!.positions;
    expect(second).toEqual(first);
  });
});

describe('a glTF beside layers of another up axis', () => {
  it('is declined beside a LAS terrain, and runs once the LAS layer is hidden or removed', async () => {
    const gltf = await loadGltf(gltfBytes(meshPoints('floor'), 'gltf'), 'gltf');
    const las = cloudOf('las', zUpTerrain(), UTM13N);
    const both = viewerOver([{ cloud: gltf }, { cloud: las }]);
    expect(both.v.gatherTerrainPositions()).toBeNull();
    expect(both.v.terrainGatherDecline).toBe(MIXED_GLTF_FRAME_REASON);

    const hidden = viewerOver([{ cloud: gltf }, { cloud: las, visible: false }]);
    expect(hidden.v.gatherTerrainPositions()?.sourceUpAxis).toBe('y');
    expect(hidden.v.terrainGatherDecline).toBeNull();

    both.clouds.delete('1');
    expect(both.v.gatherTerrainPositions()?.sourceUpAxis).toBe('y');
    expect(both.v.terrainGatherDecline).toBeNull();
  });

  it('is declined beside a georeferenced PLY, which is Z-up by its CRS', async () => {
    const gltf = await loadGltf(gltfBytes(meshPoints('floor'), 'glb'), 'glb');
    const { v } = viewerOver([{ cloud: gltf }, { cloud: cloudOf('ply', zUpTerrain(), UTM13N) }]);
    expect(v.gatherTerrainPositions()).toBeNull();
    expect(v.terrainGatherDecline).toBe(MIXED_GLTF_FRAME_REASON);
  });

  it('reads a local PLY on its own points: Z-up beside the glTF is declined, Y-up joins it', async () => {
    const gltf = await loadGltf(gltfBytes(meshPoints('floor'), 'gltf'), 'gltf');
    const zUp = viewerOver([{ cloud: gltf }, { cloud: cloudOf('ply', zUpTerrain()) }]);
    expect(zUp.v.gatherTerrainPositions()).toBeNull();
    expect(zUp.v.terrainGatherDecline).toBe(MIXED_GLTF_FRAME_REASON);

    // A floor stored Y-up, which the detector reads as Y-up on its own.
    const yUp = meshPoints('floor');
    expect(classifyScanShape(yUp).up).toBe('y');
    const g = viewerOver([{ cloud: gltf }, { cloud: cloudOf('ply', yUp) }]).v.gatherTerrainPositions();
    expect(g?.sourceUpAxis).toBe('y');
    expect(g?.upAxisBasis).toBe('detected');
  });

  it('declines two local PLY layers whose own layouts disagree, rather than reading their union', () => {
    const yUp = meshPoints('floor');
    expect(classifyScanShape(zUpTerrain()).up).toBe('z');
    expect(classifyScanShape(yUp).up).toBe('y');
    const { v } = viewerOver([{ cloud: cloudOf('ply', zUpTerrain()) }, { cloud: cloudOf('ply', yUp) }]);
    expect(v.gatherTerrainPositions()).toBeNull();
    expect(v.terrainGatherDecline).toBe(MIXED_FRAME_REASON);
  });
});
