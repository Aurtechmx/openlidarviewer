/**
 * streamingFadeFoldLifetime.test.ts
 *
 * A streamed node folds the dissolve dither into its size graph when it fades
 * in. Once settled it keeps the fold with progress pinned at 1 (step(hash, 1)
 * is 1 for every point, so the drawn size is exact), and its fade-out starts on
 * the already-folded material without rebuilding the pipeline. Drives the real
 * StreamingRenderer against the real Viewer dissolve methods on a fake `this`,
 * recording each size-graph rebuild and the mesh's removal in order. The one
 * call that drops the fold as the mesh leaves the scene runs on a material
 * that is disposed in the same step, so it never compiles.
 */

import { describe, expect, test } from 'vitest';
import { StreamingRenderer } from '../src/render/streaming/StreamingRenderer';
import { Viewer, type PointMeshHandle } from '../src/render/Viewer';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

interface FakeMaterial { id: number; needsUpdate?: boolean }

function harness() {
  const inScene = new Set<FakeMaterial>();
  const events: string[] = [];
  const progress = new Map<FakeMaterial, number>();
  const dissolve = Object.assign(Object.create(Viewer.prototype) as object, {
    _fadeUniforms: new WeakMap(),
    _materialsWithFade: new WeakSet(),
    _applySizeMode: (m: FakeMaterial) => { if (inScene.has(m)) events.push('rebuild'); },
  }) as unknown as Viewer;
  let seq = 0;
  const viewer = {
    buildPointMesh(_p: Float32Array, colorsU8: Uint8Array): PointMeshHandle {
      const material: FakeMaterial = { id: ++seq };
      return {
        mesh: { id: seq, material } as unknown as PointMeshHandle['mesh'],
        material: material as unknown as PointMeshHandle['material'],
        colorAttr: { array: new Float32Array(colorsU8.length), needsUpdate: false } as unknown as PointMeshHandle['colorAttr'],
        classAttr: null,
      };
    },
    addStreamingMesh(mesh: { material: FakeMaterial }): void { inScene.add(mesh.material); },
    removeStreamingMesh(mesh: { material: FakeMaterial }): void { inScene.delete(mesh.material); events.push('remove'); },
    beginNodeDissolve: (m: FakeMaterial, start: number) => dissolve.beginNodeDissolve(m as never, start),
    setNodeDissolveProgress: (m: FakeMaterial, p: number) => { progress.set(m, p); dissolve.setNodeDissolveProgress(m as never, p); },
    endNodeDissolve: (m: FakeMaterial) => dissolve.endNodeDissolve(m as never),
    requestFrame(): void {},
  };
  return { viewer: viewer as unknown as Viewer, inScene, events, progress };
}

const source = {
  localBounds: () => [0, 0, 0, 10, 10, 10] as const,
  dataBounds: () => [0, 0, 0, 10, 10, 10] as const,
} as unknown as StreamingSource;

const node = (id: string): StreamingNode => ({ record: { id, key: { depth: 0, x: 0, y: 0, z: 0 } } }) as unknown as StreamingNode;

const chunk = (): DecodedChunk => ({
  pointCount: 4,
  positions: new Float32Array(12),
  intensity: new Uint16Array(4),
  classification: new Uint8Array(4),
  returnNumber: new Uint8Array(4),
  returnCount: new Uint8Array(4),
  gpsTime: new Float64Array(4),
}) as DecodedChunk;

describe('streamed node dissolve fold', () => {
  test('folds once: settles at progress 1 and fades out without a rebuild', () => {
    let clock = 0;
    const h = harness();
    const renderer = new StreamingRenderer(h.viewer, source, 'rgb', { fadeIn: true, now: () => clock });
    const n = node('A');
    renderer.onNodeReady(n, chunk());
    const [material] = [...h.inScene];
    expect(material).toBeDefined();
    // Fade in, then settle.
    clock = 100;
    renderer.stepFades();
    clock = 1_000;
    renderer.stepFades();
    expect(renderer.hasActiveFades()).toBe(false);
    expect(h.progress.get(material!)).toBe(1);
    // Evict: the fade-out starts from the pinned 1 on the folded material.
    clock = 2_000;
    renderer.onNodeEvicted(n);
    clock = 2_100;
    renderer.stepFades();
    expect(h.progress.get(material!)).toBeLessThan(1);
    clock = 5_000;
    renderer.stepFades();
    expect(h.inScene.size).toBe(0);
    // One size-graph change while the mesh was drawn, the fold added at
    // fade-in, then the fold dropped in the step that removes the mesh.
    // (Before: added at fade-in, dropped at settle, added again at fade-out.)
    expect(h.events).toEqual(['rebuild', 'rebuild', 'remove']);
  });

  test('a node evicted mid-fade-in dissolves out from where it got to', () => {
    let clock = 0;
    const h = harness();
    const renderer = new StreamingRenderer(h.viewer, source, 'rgb', { fadeIn: true, now: () => clock });
    const n = node('B');
    renderer.onNodeReady(n, chunk());
    const [material] = [...h.inScene];
    clock = 60;
    renderer.stepFades();
    const midway = h.progress.get(material!)!;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);
    renderer.onNodeEvicted(n);
    clock = 61;
    renderer.stepFades();
    expect(h.progress.get(material!)!).toBeLessThanOrEqual(midway);
    expect(h.events).toEqual(['rebuild']);
  });
});
