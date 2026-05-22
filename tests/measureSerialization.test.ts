import { describe, it, expect } from 'vitest';
import {
  serializeSession,
  parseSession,
  SESSION_VERSION,
} from '../src/render/measure/serialization';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { CameraPose } from '../src/render/NavController';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

function sampleSession() {
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
  const views: CameraPose[] = [{ position: p(1, 2, 3), target: p(4, 5, 6) }];
  return {
    upAxis: 'z' as const,
    origin: p(100, 200, 300),
    unitSystem: 'imperial' as const,
    views,
    measurements,
  };
}

describe('serializeSession / parseSession', () => {
  it('round-trips a session', () => {
    const back = parseSession(serializeSession(sampleSession()));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.upAxis).toBe('z');
    expect(back.origin).toEqual([100, 200, 300]);
    expect(back.unitSystem).toBe('imperial');
    expect(back.views).toHaveLength(1);
    expect(back.views[0].target).toEqual([4, 5, 6]);
    expect(back.measurements).toHaveLength(2);
    expect(back.measurements[1].closed).toBe(true);
  });

  it('writes a tagged JSON envelope', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    expect(doc.app).toBe('OpenLiDARViewer');
    expect(doc.kind).toBe('measurement-session');
    expect(doc.version).toBe(SESSION_VERSION);
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

  it('falls back to safe defaults for bad fields', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'sideways',
      origin: 'nope',
      unitSystem: 'cubits',
      views: 'no',
      measurements: 'no',
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.upAxis).toBe('y');
    expect(back.origin).toEqual([0, 0, 0]);
    expect(back.unitSystem).toBe('metric');
    expect(back.views).toEqual([]);
    expect(back.measurements).toEqual([]);
  });
});
