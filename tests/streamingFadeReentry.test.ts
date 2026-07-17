/**
 * streamingFadeReentry.test.ts
 *
 * The fade-out / re-residency race: an evicted node begins a 220 ms fade-OUT
 * but stays in the mesh map until the fade completes. If the scheduler
 * re-decodes that node inside the fade window, `onNodeReady` must NOT treat the
 * still-fading mesh as "already resident" and bail — otherwise the fade
 * completion strips the now-current mesh (node vanishes) or the node stays
 * resident in the store with no mesh at all (a blank hole that never redecodes).
 *
 * Node-level: a fake Viewer records the dissolve / mesh calls and an injected
 * clock drives the fade tick deterministically.
 */

import { describe, expect, test } from 'vitest';
import { StreamingRenderer } from '../src/render/streaming/StreamingRenderer';
import type { Viewer, PointMeshHandle } from '../src/render/Viewer';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

/** A mesh + material stand-in — only identity and `.material` matter here. */
interface FakeMesh {
  id: number;
  material: { id: number };
}

/** Records every dissolve / mesh call the renderer makes. */
interface Recorder {
  build: number;
  add: FakeMesh[];
  remove: FakeMesh[];
  begin: { mat: { id: number }; start: number }[];
  end: { id: number }[];
}

function makeFakeViewer(rec: Recorder): { viewer: Viewer; meshes: () => FakeMesh[] } {
  let seq = 0;
  const built: FakeMesh[] = [];
  const viewer = {
    buildPointMesh(_positions: Float32Array, colorsU8: Uint8Array): PointMeshHandle {
      rec.build++;
      seq++;
      const material = { id: seq };
      const mesh: FakeMesh = { id: seq, material };
      built.push(mesh);
      return {
        mesh: mesh as unknown as PointMeshHandle['mesh'],
        material: material as unknown as PointMeshHandle['material'],
        colorAttr: {
          array: new Float32Array(colorsU8.length),
          needsUpdate: false,
        } as unknown as PointMeshHandle['colorAttr'],
        classAttr: null,
      };
    },
    addStreamingMesh(mesh: unknown): void {
      rec.add.push(mesh as FakeMesh);
    },
    removeStreamingMesh(mesh: unknown): void {
      rec.remove.push(mesh as FakeMesh);
    },
    beginNodeDissolve(mat: unknown, start: number): number {
      rec.begin.push({ mat: mat as { id: number }, start });
      return start;
    },
    setNodeDissolveProgress(): void {},
    endNodeDissolve(mat: unknown): void {
      rec.end.push(mat as { id: number });
    },
  };
  return { viewer: viewer as unknown as Viewer, meshes: () => built };
}

const fakeSource = {
  localBounds: () => [0, 0, 0, 10, 10, 10] as const,
  dataBounds: () => [0, 0, 0, 10, 10, 10] as const,
} as unknown as StreamingSource;

function makeNode(id: string, depth: number): StreamingNode {
  return {
    record: { id, key: { depth, x: 0, y: 0, z: 0 } },
  } as unknown as StreamingNode;
}

function makeChunk(): DecodedChunk {
  const n = 4;
  return {
    pointCount: n,
    positions: new Float32Array(n * 3),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: new Float64Array(n),
  } as DecodedChunk;
}

describe('fade-out / re-residency race', () => {
  test('re-decoding a node mid-fade-out leaves exactly one live mesh, store-consistent', async () => {
    let clock = 0;
    const rec: Recorder = { build: 0, add: [], remove: [], begin: [], end: [] };
    const { viewer, meshes } = makeFakeViewer(rec);
    const renderer = new StreamingRenderer(viewer, fakeSource, 'rgb', {
      fadeIn: true,
      now: () => clock,
    });

    const node = makeNode('N', 0);
    // Mirror the scheduler store: it marks a node resident BEFORE calling
    // onNodeReady, and unloaded AFTER onNodeEvicted returns.
    let storeState: 'resident' | 'unloaded' = 'unloaded';

    // 1. First decode — node materialises and starts fading IN.
    storeState = 'resident';
    const chunkA = makeChunk();
    renderer.onNodeReady(node, chunkA);
    expect(renderer.residentMeshCount).toBe(1);
    const mesh1 = meshes()[0];

    // 2. Evicted mid-fade — begins the 220 ms fade-OUT; mesh1 stays resident.
    clock = 50;
    renderer.onNodeEvicted(node);
    storeState = 'unloaded';
    expect(renderer.residentMeshCount).toBe(1);

    // 3. Re-decoded before the fade-out completes. The renderer must not treat
    //    the still-fading mesh as "already resident" and bail.
    clock = 100;
    storeState = 'resident';
    const chunkB = makeChunk();
    renderer.onNodeReady(node, chunkB);

    // The stale mesh is gone, a fresh one is live — one mesh, not zero, not two.
    expect(renderer.residentMeshCount).toBe(1);
    expect(renderer.residentChunks()).toHaveLength(1);
    expect(renderer.residentChunks()[0]).toBe(chunkB);

    // 4. Advance past FADE_MS and let the pending fade tick fire. The stale
    //    fade-out must not remove the fresh mesh.
    clock = 5_000;
    await new Promise((r) => setTimeout(r, 40));

    // Store says resident; the renderer must still hold exactly one mesh for it.
    expect(storeState).toBe('resident');
    expect(renderer.residentMeshCount).toBe(1);
    expect(renderer.residentChunks()).toHaveLength(1);
    expect(renderer.residentChunks()[0]).toBe(chunkB);

    // The fresh mesh (mesh2) was never removed; the stale mesh (mesh1) was
    // removed exactly once — no double-remove.
    const mesh2 = meshes()[1];
    expect(mesh2).toBeDefined();
    expect(rec.remove).not.toContain(mesh2);
    expect(rec.remove.filter((m) => m === mesh1)).toHaveLength(1);
  });
});
