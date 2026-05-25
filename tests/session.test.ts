import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession, SESSION_VERSION } from '../src/io/session';
import type { InspectionSession, SavedView } from '../src/io/session';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { Annotation } from '../src/render/annotate/types';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

function sampleSession(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  const measurements: Measurement[] = [
    { id: 'a', kind: 'distance', name: 'D1', points: [p(0, 0, 0), p(1, 0, 0)] },
    {
      id: 'b',
      kind: 'area',
      name: 'A1',
      points: [p(0, 0, 0), p(2, 0, 0), p(2, 2, 0)],
      closed: true,
    },
  ];
  const views: SavedView[] = [
    { name: 'Overview', camera: { position: p(1, 2, 3), target: p(4, 5, 6), mode: 'orbit' } },
  ];
  const annotations: Annotation[] = [
    {
      id: 'an1',
      title: 'Cracked panel',
      note: 'Check the weld',
      type: 'issue',
      createdAt: 1000,
      updatedAt: 2000,
      localPosition: { x: 1, y: 2, z: 3 },
    },
  ];
  return {
    upAxis: 'z',
    origin: p(100, 200, 300),
    unitSystem: 'imperial',
    views,
    measurements,
    annotations,
  };
}

describe('serializeSession / parseSession', () => {
  it('round-trips a full session', () => {
    const back = parseSession(serializeSession(sampleSession()));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.upAxis).toBe('z');
    expect(back.origin).toEqual([100, 200, 300]);
    expect(back.unitSystem).toBe('imperial');
    expect(back.views).toHaveLength(1);
    expect(back.views[0].name).toBe('Overview');
    expect(back.views[0].camera.target).toEqual([4, 5, 6]);
    expect(back.views[0].camera.mode).toBe('orbit');
    expect(back.measurements).toHaveLength(2);
    expect(back.measurements[1].closed).toBe(true);
    expect(back.annotations).toHaveLength(1);
    expect(back.annotations[0].title).toBe('Cracked panel');
    expect(back.annotations[0].type).toBe('issue');
    expect(back.annotations[0].localPosition).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('writes a tagged JSON envelope at the current version', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    expect(doc.app).toBe('OpenLiDARViewer');
    expect(doc.kind).toBe('measurement-session');
    expect(doc.version).toBe(SESSION_VERSION);
  });
});

describe('parseSession — backward compatibility (schema v1)', () => {
  it('loads a v0.2.0 measurement-only session with measurements and views intact', () => {
    const v1 = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 1,
      upAxis: 'y',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [{ position: [1, 2, 3], target: [4, 5, 6] }], // bare v1 CameraPose
      measurements: [
        { id: 'm', kind: 'distance', name: 'D', points: [[0, 0, 0], [1, 1, 1]] },
      ],
    };
    const back = parseSession(JSON.stringify(v1));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.measurements).toHaveLength(1);
    // A bare v1 pose becomes a named SavedView.
    expect(back.views).toHaveLength(1);
    expect(back.views[0].camera.target).toEqual([4, 5, 6]);
    expect(back.views[0].name).toBe('View 1');
    // A v1 file has no annotations key — the result is an empty list.
    expect(back.annotations).toEqual([]);
  });
});

describe('parseSession — rejection', () => {
  it('rejects non-JSON', () => {
    expect(() => parseSession('not json {')).toThrow();
  });

  it('rejects a foreign file', () => {
    expect(() => parseSession(JSON.stringify({ app: 'Other' }))).toThrow(
      /not an OpenLiDARViewer/,
    );
  });

  it('rejects an unsupported version', () => {
    const doc = { app: 'OpenLiDARViewer', kind: 'measurement-session', version: 999 };
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/version/);
  });
});

describe('parseSession — tolerance', () => {
  it('drops malformed measurements but keeps valid ones', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'y',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      annotations: [],
      measurements: [
        { id: 'ok', kind: 'distance', name: 'D', points: [[0, 0, 0], [1, 1, 1]] },
        { id: 'bad-kind', kind: 'banana', name: 'X', points: [[0, 0, 0], [1, 1, 1]] },
        { id: 'too-few', kind: 'area', name: 'Y', points: [[0, 0, 0]] },
        'garbage',
      ],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.measurements).toHaveLength(1);
    expect(back.measurements[0].id).toBe('ok');
  });

  it('drops malformed annotations but keeps valid ones', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'y',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [
        {
          id: 'ok',
          title: 'Good',
          type: 'warning',
          createdAt: 1,
          updatedAt: 1,
          localPosition: { x: 1, y: 2, z: 3 },
        },
        { id: 'no-pos', title: 'Bad', type: 'note', createdAt: 1, updatedAt: 1 },
        'garbage',
      ],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.annotations).toHaveLength(1);
    expect(back.annotations[0].id).toBe('ok');
    expect(back.annotations[0].type).toBe('warning');
  });

  it('fills annotation defaults for missing optional fields', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'y',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [{ localPosition: { x: 0, y: 0, z: 0 } }],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.annotations).toHaveLength(1);
    const a = back.annotations[0];
    expect(typeof a.id).toBe('string');
    expect(a.title).toBe('Annotation');
    expect(a.type).toBe('note');
    expect(a.note).toBeUndefined();
    expect(a.cameraState).toBeUndefined();
  });

  it('falls back to safe defaults for bad top-level fields', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'sideways',
      origin: 'nope',
      unitSystem: 'cubits',
      views: 'no',
      measurements: 'no',
      annotations: 'no',
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.upAxis).toBe('y');
    expect(back.origin).toEqual([0, 0, 0]);
    expect(back.unitSystem).toBe('metric');
    expect(back.views).toEqual([]);
    expect(back.measurements).toEqual([]);
    expect(back.annotations).toEqual([]);
  });

  it('round-trips a 250-annotation session with no loss (performance safety)', () => {
    const annotations: Annotation[] = [];
    for (let i = 0; i < 250; i++) {
      annotations.push({
        id: `a${i}`,
        title: `Finding ${i}`,
        type: (['note', 'info', 'warning', 'issue'] as const)[i % 4],
        createdAt: 1000 + i,
        updatedAt: 1000 + i,
        localPosition: { x: i, y: i * 2, z: i * 0.5 },
        cameraState: { position: [i, 0, 0], target: [0, 0, 0], mode: 'orbit' },
      });
    }
    const back = parseSession(serializeSession({ ...sampleSession(), annotations }));
    expect(back.annotations).toHaveLength(250);
    expect(back.annotations[0].title).toBe('Finding 0');
    expect(back.annotations[249].cameraState?.position).toEqual([249, 0, 0]);
  });
});
