/**
 * coarseLodNodeWiring.test.ts
 *
 * The renderer half of coarse-LOD display compensation: every node mesh the
 * streaming renderer builds carries its own resolution and its SOURCE's root
 * reference, so the Viewer's size graph can fold a same-source ratio. The root
 * reference is resolved once and never re-scanned.
 */

import { describe, expect, test } from 'vitest';
import { StreamingRenderer } from '../src/render/streaming/StreamingRenderer';
import {
  NODE_RESOLUTION_KEY,
  ROOT_RESOLUTION_KEY,
  coarseLodScale,
  relativeNodeResolution,
} from '../src/render/streamingLodSize';
import type { Viewer, PointMeshHandle } from '../src/render/Viewer';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

interface FakeMaterial {
  id: number;
  userData?: Record<string, unknown>;
}

function makeHost(): { viewer: Viewer; materials: FakeMaterial[] } {
  const materials: FakeMaterial[] = [];
  let seq = 0;
  const viewer = {
    buildPointMesh(_p: Float32Array, colorsU8: Uint8Array): PointMeshHandle {
      seq++;
      const material: FakeMaterial = { id: seq };
      materials.push(material);
      return {
        mesh: { id: seq, material } as unknown as PointMeshHandle['mesh'],
        material: material as unknown as PointMeshHandle['material'],
        colorAttr: {
          array: new Float32Array(colorsU8.length),
          needsUpdate: false,
        } as unknown as PointMeshHandle['colorAttr'],
        classAttr: null,
      };
    },
    addStreamingMesh(): void {},
    removeStreamingMesh(): void {},
    beginNodeDissolve(_m: unknown, start: number): number {
      return start;
    },
    setNodeDissolveProgress(): void {},
    endNodeDissolve(): void {},
  };
  return { viewer: viewer as unknown as Viewer, materials };
}

function makeNode(id: string, depth: number, spacing: number): StreamingNode {
  return {
    record: { id, depth, spacing, key: { depth, x: 0, y: 0, z: 0 } },
  } as unknown as StreamingNode;
}

function makeSource(nodes: StreamingNode[]): {
  source: StreamingSource;
  scans: () => number;
} {
  let scans = 0;
  const source = {
    dataBounds: () => [0, 0, 0, 10, 10, 10] as const,
    octree: {
      nodes: () => {
        scans++;
        return nodes;
      },
    },
  } as unknown as StreamingSource;
  return { source, scans: () => scans };
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

describe('streamed node resolution wiring', () => {
  test('each node records its own resolution against the source root', () => {
    const root = makeNode('R', 0, 4);
    const child = makeNode('C', 2, 1);
    const { source } = makeSource([root, child]);
    const { viewer, materials } = makeHost();
    const renderer = new StreamingRenderer(viewer, source, 'rgb');

    renderer.onNodeReady(root, makeChunk());
    renderer.onNodeReady(child, makeChunk());

    expect(materials[0].userData?.[NODE_RESOLUTION_KEY]).toBe(4);
    expect(materials[0].userData?.[ROOT_RESOLUTION_KEY]).toBe(4);
    expect(materials[1].userData?.[NODE_RESOLUTION_KEY]).toBe(1);
    expect(materials[1].userData?.[ROOT_RESOLUTION_KEY]).toBe(4);

    const relRoot = relativeNodeResolution(4, 4);
    const relChild = relativeNodeResolution(1, 4);
    expect(coarseLodScale(relChild, 'moving', 'adaptive')).toBeLessThan(
      coarseLodScale(relRoot, 'moving', 'adaptive'),
    );
  });

  test('the root reference is resolved once, never re-scanned per node', () => {
    const nodes = [makeNode('R', 0, 8), makeNode('C', 1, 4), makeNode('D', 2, 2)];
    const { source, scans } = makeSource(nodes);
    const { viewer } = makeHost();
    const renderer = new StreamingRenderer(viewer, source, 'rgb');
    for (const n of nodes) renderer.onNodeReady(n, makeChunk());
    expect(scans()).toBe(1);
  });

  test('a hierarchy that states no usable resolution disables compensation', () => {
    const bad = makeNode('R', 0, Number.NaN);
    const { source } = makeSource([bad]);
    const { viewer, materials } = makeHost();
    const renderer = new StreamingRenderer(viewer, source, 'rgb');
    renderer.onNodeReady(bad, makeChunk());
    const rel = relativeNodeResolution(
      Number(materials[0].userData?.[NODE_RESOLUTION_KEY]),
      Number(materials[0].userData?.[ROOT_RESOLUTION_KEY]),
    );
    expect(rel).toBe(0);
    expect(coarseLodScale(rel, 'moving', 'adaptive')).toBe(1);
  });

  test('a node arriving while fully refined takes the identity gain', () => {
    const root = makeNode('R', 0, 4);
    const { source } = makeSource([root]);
    const { viewer, materials } = makeHost();
    const renderer = new StreamingRenderer(viewer, source, 'rgb');
    renderer.onNodeReady(root, makeChunk());
    const rel = relativeNodeResolution(
      Number(materials[0].userData?.[NODE_RESOLUTION_KEY]),
      Number(materials[0].userData?.[ROOT_RESOLUTION_KEY]),
    );
    expect(rel).toBe(1);
    expect(coarseLodScale(rel, 'full-refine', 'adaptive')).toBe(1);
  });
});
