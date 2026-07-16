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
