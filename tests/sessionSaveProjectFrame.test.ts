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
import { projectFrameInputFrom, type ProjectFrameSources } from '../src/app/projectFrame';

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
