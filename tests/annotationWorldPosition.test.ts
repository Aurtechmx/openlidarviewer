/**
 * annotationWorldPosition.test.ts
 *
 * An annotation is created with only its render-local anchor (`localPosition`),
 * a small coordinate in the scan's recentered frame. A deliverable report needs
 * the SURVEY coordinate — the same point folded with the cloud's source origin —
 * or it prints a meaningless small number where an analyst expects an easting /
 * northing. These tests pin the fix end to end:
 *
 *   - creation stores `worldPosition === localPosition + sourceOrigin` (real
 *     survey coords, not the render-local anchor) plus the owning `layerId`;
 *   - the report row carries the world coordinate and LABELS its frame, and a
 *     world-less annotation is labelled render-local rather than presented as a
 *     survey location;
 *   - the load path (re)derives the frame-invariant world position and
 *     round-trips the layer/CRS provenance.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { createAnnotation, type Annotation } from '../src/render/annotate/types';
import { georefFromPick } from '../src/render/annotate/pickGeoref';
import { buildAnnotationRows } from '../src/report';
import { parseSession, rebaseSessionGeometry, serializeSession } from '../src/io/session';

/**
 * A one-point cloud whose source origin is a real survey shift. The single
 * position is exactly representable in Float32 so `worldXYZ` is exact.
 */
function cloudAt(
  local: [number, number, number],
  origin: [number, number, number],
  name = 'scan-A',
): PointCloud {
  return new PointCloud({
    positions: Float32Array.of(local[0], local[1], local[2]),
    origin,
    sourceFormat: 'laz',
    name,
  });
}

describe('annotation world position — created from the picked cloud', () => {
  const local: [number, number, number] = [12.5, -7.25, 3.75];
  const origin: [number, number, number] = [517000, 4645000, 58];

  it('stores worldPosition === localPosition + sourceOrigin (survey coords, not render-local)', () => {
    const cloud = cloudAt(local, origin);
    const georef = georefFromPick(cloud, 0, 'EPSG:25830');

    const a = createAnnotation(
      { title: 'Weld crack', type: 'issue', localPosition: { x: local[0], y: local[1], z: local[2] }, ...georef },
      5000,
    );

    // The whole point of the fix: the world position is the surveyed location,
    // which is localPosition folded with the cloud's source origin — NOT the
    // small render-local anchor the marker draws at.
    expect(a.worldPosition).toEqual({
      x: local[0] + origin[0],
      y: local[1] + origin[1],
      z: local[2] + origin[2],
    });
    expect(a.worldPosition).not.toEqual(a.localPosition);
    // And it matches the cloud's own world read for that index.
    const [wx, wy, wz] = cloud.worldXYZ(0);
    expect(a.worldPosition).toEqual({ x: wx, y: wy, z: wz });
  });

  it('records the owning layer and CRS so the frame is attributable', () => {
    const cloud = cloudAt(local, origin, 'tower-east.laz');
    const a = createAnnotation(
      { title: 'P', type: 'note', localPosition: { x: local[0], y: local[1], z: local[2] }, ...georefFromPick(cloud, 0, 'EPSG:25830') },
      1,
    );
    expect(a.layerId).toBe('tower-east.laz');
    expect(a.crs).toBe('EPSG:25830');
  });

  it('omits the CRS when the cloud declares none, keeping the world position', () => {
    const cloud = cloudAt(local, origin);
    const g = georefFromPick(cloud, 0); // no CRS resolved
    expect(g.crs).toBeUndefined();
    const a = createAnnotation(
      { title: 'P', type: 'note', localPosition: { x: local[0], y: local[1], z: local[2] }, ...g },
      1,
    );
    expect(a.crs).toBeUndefined();
    expect(a.layerId).toBe('scan-A');
    expect(a.worldPosition).toEqual({ x: local[0] + origin[0], y: local[1] + origin[1], z: local[2] + origin[2] });
  });
});

describe('annotation report — states the coordinate frame honestly', () => {
  const local: [number, number, number] = [12.5, -7.25, 3.75];
  const origin: [number, number, number] = [517000, 4645000, 58];

  it('prints the WORLD coordinate and labels the frame when a world position exists', () => {
    const cloud = cloudAt(local, origin);
    const a = createAnnotation(
      { title: 'Spall', type: 'issue', localPosition: { x: local[0], y: local[1], z: local[2] }, ...georefFromPick(cloud, 0, 'EPSG:25830') },
      1,
    );
    const [row] = buildAnnotationRows([a]);
    expect(row!.frame).toBe('world');
    expect(row!.crs).toBe('EPSG:25830');
    // The report position is the survey coordinate, not the render-local anchor.
    expect(row!.position).toEqual({ x: local[0] + origin[0], y: local[1] + origin[1], z: local[2] + origin[2] });
  });

  it('labels a world-less annotation as render-local instead of presenting it as survey', () => {
    const a: Annotation = {
      id: 'x', title: 'Loose bolt', type: 'warning', createdAt: 1, updatedAt: 1,
      localPosition: { x: 1, y: 2, z: 3 },
    };
    const [row] = buildAnnotationRows([a]);
    expect(row!.frame).toBe('local');
    expect(row!.crs).toBeUndefined();
    expect(row!.position).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('annotation world position — load path', () => {
  const O1: [number, number, number] = [517000, 4645000, 58]; // capture origin
  const O2: [number, number, number] = [10, 20, 30]; // origin of the cloud imported onto

  function fixture(annotation: Record<string, unknown>): string {
    return JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 7,
      upAxis: 'z',
      origin: O1,
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [annotation],
    });
  }

  it('derives worldPosition on load for an annotation that stored only a local anchor', () => {
    const session = parseSession(
      fixture({ id: 'a1', title: 'A', type: 'note', createdAt: 1, updatedAt: 1, localPosition: { x: 12.5, y: -7.25, z: 3.75 } }),
    );
    const rebased = rebaseSessionGeometry(session, O2);
    const a = rebased.annotations[0]!;

    // The type comment promises worldPosition is "recomputed on load" — it now is.
    expect(a.worldPosition).toBeDefined();
    // World = old local + capture origin, and it is FRAME-INVARIANT: the rebased
    // local plus the NEW cloud origin lands on the same survey coordinate.
    expect(a.worldPosition).toEqual({ x: 12.5 + O1[0], y: -7.25 + O1[1], z: 3.75 + O1[2] });
    expect({
      x: a.localPosition.x + O2[0],
      y: a.localPosition.y + O2[1],
      z: a.localPosition.z + O2[2],
    }).toEqual(a.worldPosition);
  });

  it('preserves an already-stored world position through the rebase (survey coords do not move)', () => {
    const stored = { x: 999_001, y: 888_002, z: 77 };
    const session = parseSession(
      fixture({ id: 'a1', title: 'A', type: 'note', createdAt: 1, updatedAt: 1, localPosition: { x: 1, y: 2, z: 3 }, worldPosition: stored }),
    );
    const rebased = rebaseSessionGeometry(session, O2);
    expect(rebased.annotations[0]!.worldPosition).toEqual(stored);
  });

  it('round-trips the owning layer and CRS through serialize + parse', () => {
    const cloud = cloudAt([12.5, -7.25, 3.75], O1, 'pier-3.laz');
    const a = createAnnotation(
      { title: 'A', type: 'note', localPosition: { x: 12.5, y: -7.25, z: 3.75 }, ...georefFromPick(cloud, 0, 'EPSG:25830') },
      1,
    );
    const json = serializeSession({
      upAxis: 'z',
      origin: O1,
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [a],
    });
    const back = parseSession(json).annotations[0]!;
    expect(back.layerId).toBe('pier-3.laz');
    expect(back.crs).toBe('EPSG:25830');
    expect(back.worldPosition).toEqual(a.worldPosition);
  });
});
