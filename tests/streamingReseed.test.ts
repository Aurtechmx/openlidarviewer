/**
 * streamingReseed.test.ts — pins the race-correct colour-range seeding decision.
 *
 * Under concurrent COPC decode the first node to *arrive* may be a deep node
 * covering a sliver of the cloud; seeding the elevation/intensity ramp off it
 * tints the whole stream wrong. shouldReseedColorRange only (re)seeds from a
 * non-empty node strictly shallower than the last seed, converging to the
 * depth-0 root that spans the full extent.
 *
 * The second half pins WHAT gets seeded: the cloud-global gpsTime window must
 * survive a malformed chunk. GPS time is the only NaN-capable (Float64)
 * channel a node seeds from, and a NaN in the seeding node's first slot would
 * — through a raw first-element min/max scan — make both ends of the window
 * NaN and render every streaming node solid black in gpsTime mode.
 */

import { describe, it, expect } from 'vitest';
import {
  StreamingRenderer,
  shouldReseedColorRange,
} from '../src/render/streaming/StreamingRenderer';
import type { Viewer, PointMeshHandle } from '../src/render/Viewer';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

describe('shouldReseedColorRange', () => {
  it('seeds on the first non-empty node (depth < Infinity)', () => {
    expect(shouldReseedColorRange(Number.POSITIVE_INFINITY, 3, 100)).toBe(true);
  });

  it('reseeds when a shallower (closer-to-root) node arrives later', () => {
    expect(shouldReseedColorRange(3, 1, 100)).toBe(true); // a deep node seeded first
    expect(shouldReseedColorRange(1, 0, 100)).toBe(true); // then the root lands
  });

  it('does NOT reseed from an equal or deeper node', () => {
    expect(shouldReseedColorRange(1, 1, 100)).toBe(false);
    expect(shouldReseedColorRange(1, 4, 100)).toBe(false);
  });

  it('never seeds from an empty node', () => {
    expect(shouldReseedColorRange(Number.POSITIVE_INFINITY, 0, 0)).toBe(false);
  });

  it('once the root (depth 0) has seeded, nothing can reseed', () => {
    expect(shouldReseedColorRange(0, 0, 100)).toBe(false);
    expect(shouldReseedColorRange(0, 1, 100)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// onNodeReady scalar-range seeding — the gpsTime window vs. malformed data
// ────────────────────────────────────────────────────────────────────────────

/**
 * A Viewer stub exposing only the two members `onNodeReady` touches. The
 * colours handed to `buildPointMesh` are captured so the test can assert on
 * the exact bytes a real mesh would upload.
 */
function viewerCapture(): { viewer: Viewer; captured: Uint8Array[] } {
  const captured: Uint8Array[] = [];
  const viewer = {
    buildPointMesh: (_positions: Float32Array, colors: Uint8Array): PointMeshHandle => {
      captured.push(colors.slice());
      return {
        mesh: {},
        material: {},
        colorAttr: {},
        classAttr: null,
      } as unknown as PointMeshHandle;
    },
    addStreamingMesh: () => undefined,
  } as unknown as Viewer;
  return { viewer, captured };
}

function sourceStub(): StreamingSource {
  return { localBounds: () => [0, 0, 0, 1, 1, 1] } as unknown as StreamingSource;
}

function nodeAt(depth: number, id: string): StreamingNode {
  return { record: { id, key: { depth } } } as unknown as StreamingNode;
}

function gpsChunk(times: number[]): DecodedChunk {
  const n = times.length;
  return {
    pointCount: n,
    positions: new Float32Array(n * 3),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: Float64Array.from(times),
  };
}

describe('onNodeReady gpsTime window seeding', () => {
  it('a NaN timestamp in the seeding node cannot poison the cloud-global window', () => {
    const { viewer, captured } = viewerCapture();
    const renderer = new StreamingRenderer(viewer, sourceStub(), 'gpsTime');
    const base = 3.2e8;
    // NaN in slot 0 — the worst case for a raw first-element min/max seed.
    renderer.onNodeReady(nodeAt(0, 'root'), gpsChunk([NaN, base, base + 10]));
    const colors = captured[0];
    // The NaN point keeps honest "no data" black; the finite points ramp to
    // the Cividis endpoints — proof the seeded window is finite, not NaN.
    expect([colors[0], colors[1], colors[2]]).toEqual([0, 0, 0]);
    expect([colors[3], colors[4], colors[5]]).toEqual([0, 32, 76]);
    expect([colors[6], colors[7], colors[8]]).toEqual([253, 231, 37]);
  });
});
