import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { PreviewCloudLayer, PREVIEW_MAX_POINTS, type PointMeshBuilder } from '../src/render/previewCloudLayer';

/**
 * The stand-in mesh is built once at a capacity and filled in as chunks
 * arrive: thinned by one stride so the whole file fits, coloured by one
 * fixed elevation range, uploaded by update range, never past capacity.
 */

class FakeAttr {
  array: Float32Array;
  needsUpdate = false;
  usage: number | null = null;
  readonly ranges: Array<[number, number]> = [];
  constructor(n: number) { this.array = new Float32Array(n); }
  addUpdateRange(start: number, count: number): void { this.ranges.push([start, count]); }
  setUsage(u: number): this { this.usage = u; return this; }
}

function fakeBuilder() {
  const made: { aPos: FakeAttr; color: FakeAttr; geometry: { instanceCount: number; dispose: () => void }; material: { dispose: () => void } }[] = [];
  const build: PointMeshBuilder = (positions, colorsU8) => {
    const aPos = new FakeAttr(positions.length);
    const color = new FakeAttr(colorsU8.length);
    const geometry = { instanceCount: positions.length / 3, dispose: vi.fn(), getAttribute: (name: string) => (name === 'aPos' ? aPos : null) };
    const material = { dispose: vi.fn() };
    made.push({ aPos, color, geometry, material });
    return { mesh: { geometry } as unknown as THREE.Mesh, material: material as unknown as THREE.Material, colorAttr: color as unknown as THREE.InstancedBufferAttribute };
  };
  return { build, made };
}

const host = () => ({ add: vi.fn(), remove: vi.fn(), requestFrame: vi.fn() });

describe('PreviewCloudLayer', () => {
  it('thins every chunk by the stride that fits the file into the capacity, and stops at capacity', () => {
    const h = host();
    const { build, made } = fakeBuilder();
    const layer = new PreviewCloudLayer(h, build, { capacity: 10, expectedPoints: 40, frame: { min: [0, 0, 0], max: [1, 1, 10] } });
    expect(layer.stride).toBe(4);
    expect(made[0].geometry.instanceCount).toBe(0);
    expect(made[0].aPos.usage).toBe(THREE.DynamicDrawUsage);
    expect(h.add).toHaveBeenCalledTimes(1);

    const chunk = new Float32Array(20 * 3);
    for (let i = 0; i < 20; i++) { chunk[i * 3] = i; chunk[i * 3 + 1] = 0; chunk[i * 3 + 2] = i / 2; }
    layer.append({ positions: chunk });
    // 20 points at stride 4 keep indices 0, 4, 8, 12, 16.
    expect(layer.pointCount).toBe(5);
    expect(Array.from(made[0].aPos.array.subarray(0, 15)).filter((_, k) => k % 3 === 0)).toEqual([0, 4, 8, 12, 16]);
    expect(made[0].geometry.instanceCount).toBe(5);
    expect(made[0].aPos.ranges).toEqual([[0, 15]]);
    expect(made[0].color.ranges).toEqual([[0, 15]]);
    expect(made[0].aPos.needsUpdate).toBe(true);
    expect(h.requestFrame).toHaveBeenCalledTimes(1);

    layer.append({ positions: chunk });
    expect(layer.pointCount).toBe(10);
    layer.append({ positions: chunk });
    expect(layer.pointCount).toBe(10);
    expect(made[0].aPos.ranges).toHaveLength(2);
  });

  it('colours by one fixed range across chunks and reports the extent it has shown', () => {
    const h = host();
    const { build, made } = fakeBuilder();
    const layer = new PreviewCloudLayer(h, build, { capacity: 100, expectedPoints: 4, frame: { min: [0, 0, 0], max: [1, 1, 100] } });
    layer.append({ positions: new Float32Array([0, 0, 0, 1, 1, 100]) });
    const low = Array.from(made[0].color.array.subarray(0, 3));
    const high = Array.from(made[0].color.array.subarray(3, 6));
    layer.append({ positions: new Float32Array([2, 2, 100, 3, 3, 0]) });
    expect(Array.from(made[0].color.array.subarray(6, 9))).toEqual(high);
    expect(Array.from(made[0].color.array.subarray(9, 12))).toEqual(low);
    expect(layer.bounds()).toEqual({ min: [0, 0, 0], max: [3, 3, 100] });
  });

  it('fixes the range from its first chunk when the source declared no extent', () => {
    const h = host();
    const { build, made } = fakeBuilder();
    const layer = new PreviewCloudLayer(h, build, { capacity: 10, expectedPoints: 4 });
    expect(layer.bounds()).toBeNull();
    layer.append({ positions: new Float32Array([0, 0, 5, 0, 0, 15]) });
    const top = Array.from(made[0].color.array.subarray(3, 6));
    layer.append({ positions: new Float32Array([0, 0, 15]) });
    expect(Array.from(made[0].color.array.subarray(6, 9))).toEqual(top);
  });

  it('caps the capacity it is asked for and disposes what it built', () => {
    const h = host();
    const { build, made } = fakeBuilder();
    const layer = new PreviewCloudLayer(h, build, { capacity: PREVIEW_MAX_POINTS + 5, expectedPoints: 1 });
    expect(layer.stride).toBe(1);
    layer.dispose();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(made[0].geometry.dispose).toHaveBeenCalledTimes(1);
    expect(made[0].material.dispose).toHaveBeenCalledTimes(1);
  });
});
