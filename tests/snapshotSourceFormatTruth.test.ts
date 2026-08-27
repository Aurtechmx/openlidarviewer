/**
 * snapshotSourceFormatTruth.test.ts
 *
 * `Viewer.snapshotResidentCloud()` is the cloud the Export / Convert panel
 * writes for a streaming scan, and its `sourceFormat` is the provenance the
 * deliverable carries. It was the literal `'laz'` for every source, so a
 * snapshot taken over a 3D Tiles stream — point tiles, no LAZ record anywhere
 * in the pipeline — shipped a file stating it came from a format whose bytes
 * had never been read.
 *
 * The real method runs against a fake `this`, the way
 * `snapshotColorbarPlumbing.test.ts` drives `_buildExportAdapter`: the format
 * decision is three lines inside a three.js-bound class, and a fake source is
 * what lets the shipped decision itself be asserted rather than a copy of it.
 */

import { describe, it, expect } from 'vitest';
import { Viewer } from '../src/render/Viewer';
import type { PointCloud } from '../src/model/PointCloud';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

/** One resident node's decoded attributes — three points, all channels present. */
function chunk(): DecodedChunk {
  const n = 3;
  return {
    pointCount: n,
    positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: new Float64Array(n),
  };
}

/**
 * A `Viewer` whose only real state is one resident streaming node on a source
 * of `kind`. The octree store answers `has`/`get` for that node so the real
 * export-frontier walk keeps it.
 */
function viewerOverStream(kind: string): Viewer {
  const decoded = chunk();
  const store = {
    has: (id: string) => id === 'n0',
    get: (id: string) => (id === 'n0' ? { record: { parentId: undefined } } : undefined),
  };
  // Built on the real prototype so the method's own `this._exportFrontierChunks()`
  // walk runs — the frontier decision is part of what produces the snapshot.
  return Object.assign(Object.create(Viewer.prototype) as Viewer, {
    _streaming: {
      renderer: { residentFrontierEntries: () => [{ id: 'n0', fadingOut: false, decoded }] },
      cloud: {
        kind,
        name: `scan.${kind}`,
        renderOrigin: [10, 20, 30] as [number, number, number],
        sourcePointCount: 99,
        octree: { store },
        crs: () => null,
      },
    },
  }) as unknown as Viewer;
}

/** Invoke the shipped method body against the fake `this`. */
function snapshot(kind: string): PointCloud | null {
  const method = (Viewer.prototype as unknown as {
    snapshotResidentCloud: (this: Viewer) => PointCloud | null;
  }).snapshotResidentCloud;
  return method.call(viewerOverStream(kind));
}

describe('streaming export snapshot — declared source format', () => {
  it('does not stamp a 3D Tiles stream as LAZ', () => {
    const cloud = snapshot('3dtiles');
    expect(cloud).not.toBeNull();
    expect(cloud!.sourceFormat).not.toBe('laz');
  });

  it('names a 3D Tiles stream by the tile format it actually decodes', () => {
    expect(snapshot('3dtiles')!.sourceFormat).toBe('pnts');
  });

  it('keeps the LAS-family streams on their own record format', () => {
    expect(snapshot('copc')!.sourceFormat).toBe('laz');
    expect(snapshot('ept')!.sourceFormat).toBe('laz');
  });

  it('refuses a snapshot whose source records no format at all', () => {
    // The OLV tile store's manifest carries no source format, so there is
    // nothing to derive. Refusing beats stamping a plausible default.
    expect(snapshot('tiles')).toBeNull();
  });

  it('still carries the rest of the source provenance', () => {
    const cloud = snapshot('copc')!;
    expect(cloud.name).toBe('scan.copc');
    expect(cloud.pointCount).toBe(3);
    expect(cloud.sourceDeclaredPointCount).toBe(99);
  });
});
