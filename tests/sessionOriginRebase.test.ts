/**
 * sessionOriginRebase.test.ts
 *
 * A session stores measurement/annotation vertices in the LOCAL frame of the
 * scan it was captured against (`session.origin`). Imported onto a DIFFERENT
 * cloud (a different floored origin), the vertices must be rebased so they land
 * at the SAME world position — not verbatim, which displaces them by the two
 * origins' difference. Pure, Node-tested.
 */

import { describe, it, expect } from 'vitest';
import { parseSession, rebaseSessionGeometry } from '../src/io/session';

function sessionFixture(origin: [number, number, number]): string {
  return JSON.stringify({
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: 7,
    upAxis: 'z',
    origin,
    unitSystem: 'metric',
    views: [],
    measurements: [
      { id: 'm1', kind: 'distance', name: 'D1', points: [[1, 2, 3], [4, 5, 6]] },
    ],
    annotations: [
      {
        id: 'a1',
        title: 'A1',
        type: 'note',
        createdAt: 1,
        updatedAt: 1,
        localPosition: { x: 1, y: 2, z: 3 },
      },
    ],
  });
}

/**
 * A session carrying every spatial surface a reorigin must move: saved-view
 * cameras (+ their clip), the live camera, the global clip box, profile-chart
 * elevations, a volume reference plane, and an annotation's jump-to-view camera.
 */
function richFixture(
  origin: [number, number, number],
  upAxis: 'y' | 'z' = 'z',
): string {
  return JSON.stringify({
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: 7,
    upAxis,
    origin,
    unitSystem: 'metric',
    views: [
      {
        name: 'V1',
        camera: { position: [1, 2, 3], target: [4, 5, 6] },
        clip: { box: { min: [0, 0, 0], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true },
      },
    ],
    camera: { position: [7, 8, 9], target: [10, 11, 12] },
    clip: { box: { min: [0, 0, 0], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true },
    measurements: [
      {
        id: 'p1',
        kind: 'profile',
        name: 'P1',
        points: [[1, 1, 1], [2, 2, 2]],
        profileChart: [{ distance: 0, height: 5 }, { distance: 1, height: 7 }],
      },
      {
        id: 'v1',
        kind: 'volume',
        name: 'Vol1',
        points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        volume: {
          fill: 10, cut: 2, net: 8, referenceZ: 50,
          footprintArea: 100, pointsInPolygon: 500, density: 5, confidence: 'high',
        },
      },
    ],
    annotations: [
      {
        id: 'a1',
        title: 'A1',
        type: 'note',
        createdAt: 1,
        updatedAt: 1,
        localPosition: { x: 1, y: 2, z: 3 },
        cameraState: { position: [20, 21, 22], target: [23, 24, 25] },
      },
    ],
  });
}

describe('rebaseSessionGeometry — full session-frame transform', () => {
  const O1: [number, number, number] = [100, 200, 300];
  const O2: [number, number, number] = [10, 20, 30];
  // delta = O1 − O2 = [90, 180, 270]; z-up elevation delta = 270.

  it('shifts saved-view cameras and their clip into the new frame', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1)), O2);
    const cam = r.views[0].camera;
    expect(cam.position).toEqual([91, 182, 273]);
    expect(cam.target).toEqual([94, 185, 276]);
    // World coordinate preserved: rebased local + new origin == original + old.
    expect([cam.position[0] + O2[0], cam.position[1] + O2[1], cam.position[2] + O2[2]])
      .toEqual([1 + O1[0], 2 + O1[1], 3 + O1[2]]);
    expect(r.views[0].clip?.box.min).toEqual([90, 180, 270]);
    expect(r.views[0].clip?.box.max).toEqual([92, 182, 272]);
  });

  it('shifts the live camera and global clip box', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1)), O2);
    expect(r.camera?.position).toEqual([97, 188, 279]);
    expect(r.camera?.target).toEqual([100, 191, 282]);
    expect(r.clip?.box.min).toEqual([90, 180, 270]);
    expect(r.clip?.box.max).toEqual([92, 182, 272]);
  });

  it('shifts profile-chart elevations and the volume reference plane by the up-axis delta', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1)), O2);
    const profile = r.measurements.find((m) => m.kind === 'profile');
    expect(profile?.profileChart?.map((s) => s.height)).toEqual([5 + 270, 7 + 270]);
    const volume = r.measurements.find((m) => m.kind === 'volume');
    expect(volume?.volume?.referenceZ).toBe(50 + 270);
  });

  it('shifts an annotation jump-to-view camera', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1)), O2);
    const cs = r.annotations[0].cameraState;
    expect(cs?.position).toEqual([110, 201, 292]);
    expect(cs?.target).toEqual([113, 204, 295]);
  });

  it('uses the Y-up axis delta for elevation scalars on a Y-up session', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1, 'y')), O2);
    // delta.y = 180 is the elevation shift when up is Y.
    const profile = r.measurements.find((m) => m.kind === 'profile');
    expect(profile?.profileChart?.map((s) => s.height)).toEqual([5 + 180, 7 + 180]);
    const volume = r.measurements.find((m) => m.kind === 'volume');
    expect(volume?.volume?.referenceZ).toBe(50 + 180);
  });

  it('is a values-preserving no-op when the origins match', () => {
    const r = rebaseSessionGeometry(parseSession(richFixture(O1)), O1);
    expect(r.delta).toEqual([0, 0, 0]);
    expect(r.camera?.position).toEqual([7, 8, 9]);
    expect(r.clip?.box.min).toEqual([0, 0, 0]);
    const profile = r.measurements.find((m) => m.kind === 'profile');
    expect(profile?.profileChart?.map((s) => s.height)).toEqual([5, 7]);
    expect(r.views[0].camera.position).toEqual([1, 2, 3]);
  });
});

describe('rebaseSessionGeometry', () => {
  it('lands vertices at the same WORLD position on a different cloud origin', () => {
    const O1: [number, number, number] = [100, 200, 300];
    const O2: [number, number, number] = [10, 20, 30];
    const session = parseSession(sessionFixture(O1));

    const rebased = rebaseSessionGeometry(session, O2);

    // Non-zero origin difference is reported so the importer can disclose it.
    expect(rebased.delta).toEqual([90, 180, 270]);

    // A vertex's WORLD coordinate (local + cloud origin) is preserved: the
    // rebased local plus the NEW origin equals the original local plus the OLD.
    const p = rebased.measurements[0].points[0];
    expect([p[0] + O2[0], p[1] + O2[1], p[2] + O2[2]]).toEqual([
      1 + O1[0],
      2 + O1[1],
      3 + O1[2],
    ]);

    const a = rebased.annotations[0].localPosition;
    expect([a.x + O2[0], a.y + O2[1], a.z + O2[2]]).toEqual([
      1 + O1[0],
      2 + O1[1],
      3 + O1[2],
    ]);
  });

  it('is a no-op (zero delta) when the origins already match', () => {
    const O: [number, number, number] = [100, 200, 300];
    const session = parseSession(sessionFixture(O));

    const rebased = rebaseSessionGeometry(session, O);

    expect(rebased.delta).toEqual([0, 0, 0]);
    expect(rebased.measurements[0].points[0]).toEqual([1, 2, 3]);
    expect(rebased.annotations[0].localPosition).toEqual({ x: 1, y: 2, z: 3 });
  });
});
