/**
 * tests/sessionSaveProjectFrame.test.ts
 *
 * A session saved with two scans open records the project frame, and work
 * placed in that frame reopens at the same survey coordinate whichever scan
 * anchors the reopened scene. A single-scan session and a v7 file read and
 * write exactly as before.
 */

import { describe, it, expect, vi } from 'vitest';
import * as sessionIo from '../src/io/session';
import { parseSession, rebaseSessionGeometry } from '../src/io/session';
import { serializeActiveSession, type SessionSnapshotDeps } from '../src/app/sessionSnapshot';
import { projectFrameInputFrom, sceneOriginFor, type ProjectFrameSources } from '../src/app/projectFrame';

type V3 = [number, number, number];

const A_ORIGIN: V3 = [500_000, 4_600_000, 50];
const B_ORIGIN: V3 = [500_100, 4_600_000, 50];

const RECORDS: Record<string, { layerId: string; fingerprint: string; displayName: string }> = {
  a: { layerId: 'layer_a', fingerprint: 'f a.laz 1', displayName: 'a.laz' },
  b: { layerId: 'layer_b', fingerprint: 'f b.laz 2', displayName: 'b.laz' },
};
const ORIGINS: Record<string, V3> = { a: A_ORIGIN, b: B_ORIGIN };

function sources(ids: string[]): ProjectFrameSources {
  return {
    frame: { projectOrigin: A_ORIGIN },
    layerIds: ids,
    cloud: (id) => ({ sourceOrigin: ORIGINS[id]!, sourceFormat: 'las' }),
    record: (id) => RECORDS[id] ?? null,
    placement: () => ({ vertical: true }),
  };
}

function deps(activeOrigin: V3, ids: string[], withFrame = true): SessionSnapshotDeps {
  // B is the active scan. A measurement placed on B with both scans open is
  // stored project-local: x = 102 is the survey easting 500102.
  const measurement = {
    id: 'm1', kind: 'distance', name: 'D1',
    points: [[102, 0, 0], [103, 0, 0]],
    owner: { layerId: 'layer_b', frame: 'project' },
  };
  const viewer = {
    streamingCloud: null,
    measure: { unitSystem: 'metric', getMeasurements: () => [measurement] },
    annotate: { getAnnotations: () => [] },
  };
  const cloud = {
    name: 'b.laz', pointCount: 10, sourceFormat: 'las', sourceOrigin: B_ORIGIN,
    bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
  };
  return {
    getViewer: () => viewer as never,
    activeCloud: () => cloud as never,
    analysedResult: () => null,
    verticalUnitToMetres: () => null,
    captureViewState: () => ({}) as never,
    savedViews: () => [],
    origin: () => activeOrigin,
    crs: () => null,
    layerGroups: () => [],
    appVersion: 'test',
    ...(withFrame ? { projectFrame: () => projectFrameInputFrom(sources(ids)) } : {}),
  };
}

describe('session save with two scans open', () => {
  it('reopens project-frame work at the same survey coordinate with B as the anchor', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const text = serializeActiveSession(sessionIo, deps(B_ORIGIN, ['a', 'b']));
    vi.useRealTimers();
    const session = parseSession(text);
    expect(session.origin).toEqual(A_ORIGIN);
    expect(session.projectFrame?.projectOrigin).toEqual(A_ORIGIN);

    // Reopened with only B, so B's origin anchors the scene.
    const rebased = rebaseSessionGeometry(session, B_ORIGIN);
    expect(rebased.refused).toEqual([]);
    const x = rebased.measurements[0]!.points[0]![0] + B_ORIGIN[0];
    expect(x).toBe(500_102);
  });
});

describe('single-scan and older sessions', () => {
  it('a single-scan save writes exactly what it wrote without a frame', () => {
    expect(projectFrameInputFrom(sources(['b']))).toBeNull();
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const withDep = serializeActiveSession(sessionIo, deps(B_ORIGIN, ['b']));
    const without = serializeActiveSession(sessionIo, deps(B_ORIGIN, ['b'], false));
    vi.useRealTimers();
    expect(withDep).toBe(without);
    const session = parseSession(withDep);
    expect(session.origin).toEqual(B_ORIGIN);
    expect(session.projectFrame).toBeUndefined();
  });

  it('a v7 file rebases by the origin delta as before and refuses nothing', () => {
    const v7 = JSON.stringify({
      app: 'OpenLiDARViewer', kind: 'measurement-session', version: 7,
      upAxis: 'z', origin: A_ORIGIN, unitSystem: 'metric', views: [],
      measurements: [{ id: 'm1', kind: 'distance', name: 'D1', points: [[102, 0, 0], [103, 0, 0]] }],
      annotations: [],
    });
    const rebased = rebaseSessionGeometry(parseSession(v7), B_ORIGIN);
    expect(rebased.refused).toEqual([]);
    expect(rebased.unrebased).toEqual([]);
    expect(rebased.measurements[0]!.points[0]).toEqual([2, 0, 0]);
  });
});

describe('the origin a session import rebases onto', () => {
  it('is the file origin for a lone scan whose vertical datum is not verified', () => {
    const file: V3 = [500_100, 4_600_000, 50];
    // Never placed: the scan's own frame.
    expect(sceneOriginFor(null, file, null)).toEqual(file);
    expect(sceneOriginFor(file, file, null)).toEqual(file);
    // Placed in X/Y only: Z stays on the file origin.
    expect(sceneOriginFor([500_000, 4_600_000, 120], file, { vertical: false })).toEqual([500_000, 4_600_000, 50]);
    // Placed with a verified datum: the project origin in all three axes.
    expect(sceneOriginFor([500_000, 4_600_000, 120], file, { vertical: true })).toEqual([500_000, 4_600_000, 120]);
  });
});

describe('project-frame work on a layer placed in X/Y only', () => {
  // A and B share a horizontal CRS but no vertical datum, so each keeps its
  // own Z: a point picked on A is project-local in X/Y and A-local in Z.
  const A_SO: V3 = [500_000, 4_000_000, 99];
  const B_SO: V3 = [500_100, 4_000_000, 50];
  const P: V3 = [500_000, 4_000_000, 99];
  const session = () => parseSession(JSON.stringify({
    app: 'OpenLiDARViewer', kind: 'measurement-session', version: 8,
    upAxis: 'z', origin: P, unitSystem: 'metric', views: [], annotations: [],
    projectFrame: {
      projectOrigin: P,
      layers: [
        { layerId: 'layer_a', sourceFingerprint: 'fa', sourceName: 'a.las', sourceOrigin: A_SO, sourceToProject: [0, 0, 0], upAxis: 'z' },
        { layerId: 'layer_b', sourceFingerprint: 'fb', sourceName: 'b.las', sourceOrigin: B_SO, sourceToProject: [100, 0, 0], upAxis: 'z' },
      ],
    },
    measurements: [{
      id: 'm1', kind: 'distance', name: 'D1',
      points: [[4, 2, 1], [7, 2, 1]],
      owner: { layerId: 'layer_a', frame: 'project' },
    }],
  }));

  it('keeps the Z of a point picked on A when B anchors the reopened scene', () => {
    // Reopened with both scans, B active. B's scene origin keeps B's own Z;
    // A's scene frame is the project X/Y with A's own Z.
    const target = (id: string): V3 | null =>
      id === 'layer_a' ? [500_000, 4_000_000, 99] : id === 'layer_b' ? [500_000, 4_000_000, 50] : null;
    const rebased = rebaseSessionGeometry(session(), [500_000, 4_000_000, 50], { layerOrigin: target });
    const p = rebased.measurements[0]!.points[0]!;
    expect([p[0] + 500_000, p[1] + 4_000_000, p[2] + 99]).toEqual([500_004, 4_000_002, 100]);
  });
});

describe('scene state and unplaceable work in a project-frame session', () => {
  const P: V3 = [500_000, 4_600_000, 100];
  const file = (layers: unknown[], measurements: unknown[] = []) => parseSession(JSON.stringify({
    app: 'OpenLiDARViewer', kind: 'measurement-session', version: 8,
    upAxis: 'z', origin: P, unitSystem: 'metric', annotations: [],
    camera: { position: [1, 2, 10], target: [1, 2, 0] },
    clip: { box: { min: [0, 0, 5], max: [1, 1, 10] }, mode: 'keep-inside', enabled: true },
    views: [{ name: 'V1', camera: { position: [3, 4, 10], target: [3, 4, 0] } }],
    projectFrame: { projectOrigin: P, layers },
    measurements,
  }));
  const rec = (id: string, so: V3, sTP: V3) => ({
    layerId: id, sourceFingerprint: `f${id}`, sourceName: `${id}.las`, sourceOrigin: so, sourceToProject: sTP, upAxis: 'z',
  });
  const A = rec('layer_a', [500_000, 4_600_000, 100], [0, 0, 0]);
  const B_XY = rec('layer_b', [500_100, 4_600_000, 149], [100, 0, 0]);

  it('moves the camera, saved views and clip box by the project origin change, not an X/Y-only active layer', () => {
    // The active layer is placed in X/Y only, so its scene origin keeps its own
    // Z (149) while the project origin is unchanged.
    const g = rebaseSessionGeometry(file([A, B_XY]), [500_000, 4_600_000, 149], { projectOrigin: P });
    expect(g.camera!.position).toEqual([1, 2, 10]);
    expect(g.views[0]!.camera.position).toEqual([3, 4, 10]);
    expect(g.clip!.box.min).toEqual([0, 0, 5]);
  });

  it('refuses project-frame work whose layer is not open unless it was placed on all three axes', () => {
    const m = (id: string, layerId: string) => ({
      id, kind: 'distance', name: id, points: [[1, 0, 0], [2, 0, 0]], owner: { layerId, frame: 'project' },
    });
    const s = file([A, B_XY, rec('layer_c', [500_200, 4_600_000, 120], [200, 0, 20])], [
      m('onB', 'layer_b'), m('onC', 'layer_c'), m('onGone', 'layer_x'),
    ]);
    // Nothing open but the project origin: B (X/Y only) and an unknown layer
    // cannot be placed; C was placed on all three axes.
    const g = rebaseSessionGeometry(s, P, { projectOrigin: P, layerOrigin: () => null });
    expect([...g.refused].sort()).toEqual(['onB', 'onGone']);
    expect(g.measurements.map((x) => x.id)).toEqual(['onC']);
    expect(g.measurements[0]!.points[0]).toEqual([1, 0, 0]);
  });
});
