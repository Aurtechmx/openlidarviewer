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

  // v0.3.3 schema additions (the .olvsession package) ────────

  it('v3 — round-trips the live camera, render settings, color mode, and scan summary', () => {
    const back = parseSession(serializeSession({
      ...sampleSession(),
      camera: { position: [10, 20, 30], target: [0, 0, 0], mode: 'orbit', fov: 60 },
      render: {
        pointSize: 2.5,
        edlEnabled: true,
        edlStrength: 0.75,
        pointSizeMode: 'adaptive',
        antialiasing: false,
      },
      colorMode: 'classification',
      scanSummary: {
        fileName: '20210916_FLEXIGROB.copc.laz',
        sourcePoints: 9_600_000,
        width: 78.8,
        depth: 124.4,
        height: 18.9,
        crs: 'WGS 84 / UTM zone 12N (EPSG:32612)',
        crsUnit: 'metre',
      },
    }));
    // Session always normalises the version to the current SESSION_VERSION
    // on re-serialize (the schema is additive). Older fields are preserved.
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.camera).toEqual({
      position: [10, 20, 30], target: [0, 0, 0], mode: 'orbit', fov: 60,
    });
    expect(back.render?.pointSize).toBe(2.5);
    expect(back.render?.edlEnabled).toBe(true);
    expect(back.render?.edlStrength).toBe(0.75);
    expect(back.render?.pointSizeMode).toBe('adaptive');
    expect(back.render?.antialiasing).toBe(false);
    expect(back.colorMode).toBe('classification');
    expect(back.scanSummary?.fileName).toBe('20210916_FLEXIGROB.copc.laz');
    expect(back.scanSummary?.sourcePoints).toBe(9_600_000);
    expect(back.scanSummary?.crs).toMatch(/UTM zone 12N/);
    expect(back.scanSummary?.crsUnit).toBe('metre');
  });

  it('v3+ — a session without optional fields parses cleanly with them undefined', () => {
    const back = parseSession(serializeSession(sampleSession()));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.camera).toBeUndefined();
    expect(back.render).toBeUndefined();
    expect(back.colorMode).toBeUndefined();
    expect(back.scanSummary).toBeUndefined();
  });

  it('v3 — serialised output omits absent v3 fields (no JSON pollution)', () => {
    const json = serializeSession(sampleSession());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('camera' in parsed).toBe(false);
    expect('render' in parsed).toBe(false);
    expect('colorMode' in parsed).toBe(false);
    expect('scanSummary' in parsed).toBe(false);
  });

  it('back-compat — a v1 file still imports (zero annotations, no v3 fields)', () => {
    const v1 = JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 1,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
    });
    const back = parseSession(v1);
    expect(back.annotations).toEqual([]);
    expect(back.render).toBeUndefined();
    expect(back.camera).toBeUndefined();
  });

  it('back-compat — a v2 file still imports', () => {
    const v2 = JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 2,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [{ name: 'Top', camera: { position: [0, 0, 100], target: [0, 0, 0] } }],
      measurements: [],
      annotations: [],
    });
    const back = parseSession(v2);
    expect(back.views).toHaveLength(1);
    expect(back.views[0].name).toBe('Top');
  });

  it('v3 — partial: drops malformed render block but keeps the rest', () => {
    const session = {
      ...sampleSession(),
      camera: { position: [1, 2, 3] as Vec3, target: [0, 0, 0] as Vec3 },
      colorMode: 'intensity' as const,
    };
    const json = serializeSession(session);
    // Corrupt the render block in the serialised form — none of the
    // expected fields, just a junk object.
    const doc = JSON.parse(json) as Record<string, unknown>;
    doc.render = { foo: 'bar' };
    const back = parseSession(JSON.stringify(doc));
    // Malformed render → dropped silently; camera + colorMode survive.
    expect(back.render).toBeUndefined();
    expect(back.camera).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(back.colorMode).toBe('intensity');
  });

  it('v3 — an invalid colorMode value is dropped rather than passed through', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 3,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      colorMode: 'octarine',  // not a valid ColorMode
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.colorMode).toBeUndefined();
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

describe('parseSession / serializeSession — v4 CRS persistence', () => {
  it('round-trips a resolved CRS through serialize → parse', () => {
    const session = sampleSession();
    const back = parseSession(
      serializeSession({
        ...session,
        crs: {
          kind: 'projected',
          name: 'WGS 84 / UTM zone 12N',
          epsg: 32612,
          linearUnit: 'metre',
          linearUnitToMetres: 1,
          source: 'las-vlr',
          confidence: 'high',
          userConfirmed: false,
          wkt: 'PROJCS["WGS 84 / UTM zone 12N",...]',
        },
      }),
    );
    expect(back.crs).toBeDefined();
    expect(back.crs?.epsg).toBe(32612);
    expect(back.crs?.confidence).toBe('high');
    expect(back.crs?.source).toBe('las-vlr');
    expect(back.crs?.wkt).toContain('UTM');
  });

  it('round-trips a user-confirmed override flag', () => {
    const session = sampleSession();
    const back = parseSession(
      serializeSession({
        ...session,
        crs: {
          kind: 'geographic',
          name: 'WGS 84',
          epsg: 4326,
          linearUnit: 'metre',
          linearUnitToMetres: 1,
          source: 'user-override',
          confidence: 'high',
          userConfirmed: true,
        },
      }),
    );
    expect(back.crs?.userConfirmed).toBe(true);
    expect(back.crs?.source).toBe('user-override');
  });

  it('round-trips a local-coordinates resolved (no EPSG)', () => {
    const session = sampleSession();
    const back = parseSession(
      serializeSession({
        ...session,
        crs: {
          kind: 'local',
          name: 'Local coordinates (no CRS)',
          linearUnit: 'metre',
          linearUnitToMetres: 1,
          source: 'user-override',
          confidence: 'high',
          userConfirmed: true,
        },
      }),
    );
    expect(back.crs?.kind).toBe('local');
    expect(back.crs?.epsg).toBeUndefined();
  });

  it('a v3 file (no crs field) still imports cleanly', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 3,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.crs).toBeUndefined();
  });

  it('a v4 file with a malformed crs is parsed tolerantly (crs dropped, rest kept)', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      crs: {
        kind: 'projected',
        name: '', // empty name → reject
        linearUnit: 'metre',
        linearUnitToMetres: 1,
        source: 'las-vlr',
        confidence: 'high',
        userConfirmed: false,
      },
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.crs).toBeUndefined();
    expect(back.upAxis).toBe('z');
  });

  it('rejects a crs with an out-of-vocabulary `kind`', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      crs: {
        kind: 'lunar',
        name: 'X',
        linearUnit: 'metre',
        linearUnitToMetres: 1,
        source: 'las-vlr',
        confidence: 'high',
        userConfirmed: false,
      },
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.crs).toBeUndefined();
  });

  it('rejects a crs with an out-of-vocabulary `source`', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      crs: {
        kind: 'projected',
        name: 'X',
        linearUnit: 'metre',
        linearUnitToMetres: 1,
        source: 'magic-eight-ball',
        confidence: 'high',
        userConfirmed: false,
      },
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.crs).toBeUndefined();
  });

  it('serializes to the current version by default', () => {
    const json = serializeSession(sampleSession());
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(SESSION_VERSION);
    expect(SESSION_VERSION).toBe(5);
  });

  it('a v4 file with a non-finite linearUnitToMetres rejects the crs', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      crs: {
        kind: 'projected',
        name: 'X',
        linearUnit: 'metre',
        linearUnitToMetres: 'one',
        source: 'las-vlr',
        confidence: 'high',
        userConfirmed: false,
      },
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.crs).toBeUndefined();
  });
});

describe('parseSession / serializeSession — v5 class-filter persistence', () => {
  it('round-trips the hidden-class list', () => {
    const json = serializeSession({ ...sampleSession(), classFilter: [3, 4, 5] });
    expect(parseSession(json).classFilter).toEqual([3, 4, 5]);
  });

  it('omits the field entirely when nothing is hidden', () => {
    const json = serializeSession({ ...sampleSession(), classFilter: [] });
    expect(JSON.parse(json).classFilter).toBeUndefined();
    expect(parseSession(json).classFilter).toBeUndefined();
  });

  it('sorts and de-duplicates on the way out', () => {
    const json = serializeSession({ ...sampleSession(), classFilter: [5, 2, 5, 2, 1] });
    expect(parseSession(json).classFilter).toEqual([1, 2, 5]);
  });

  it('drops out-of-range and non-integer codes tolerantly', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      classFilter: [2, -1, 300, 4.5, 'six', 7],
    };
    expect(parseSession(JSON.stringify(doc)).classFilter).toEqual([2, 7]);
  });

  it('a malformed (non-array) classFilter is ignored, not thrown', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      classFilter: { hidden: [3] },
    };
    expect(parseSession(JSON.stringify(doc)).classFilter).toBeUndefined();
  });

  it('a pre-v5 file simply has no classFilter (additive)', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 4,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.classFilter).toBeUndefined();
    expect(back.version).toBe(SESSION_VERSION);
  });
});

describe('parseSession / serializeSession — v5 clip-box persistence', () => {
  const clip = {
    box: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 5] as [number, number, number] },
    mode: 'keep-inside' as const,
    enabled: true,
  };

  it('round-trips a clip box (region + mode + enabled)', () => {
    const json = serializeSession({ ...sampleSession(), clip });
    expect(parseSession(json).clip).toEqual(clip);
  });

  it('omits the clip when none is set', () => {
    const json = serializeSession(sampleSession());
    expect(JSON.parse(json).clip).toBeUndefined();
    expect(parseSession(json).clip).toBeUndefined();
  });

  it('a disabled-but-positioned clip keeps its geometry', () => {
    const json = serializeSession({ ...sampleSession(), clip: { ...clip, enabled: false } });
    expect(parseSession(json).clip).toMatchObject({ enabled: false, box: clip.box });
  });

  it('an unknown mode falls back to keep-inside, enabled defaults false', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      clip: { box: clip.box, mode: 'sideways', enabled: 'yes' },
    };
    expect(parseSession(JSON.stringify(doc)).clip).toEqual({
      box: clip.box, mode: 'keep-inside', enabled: false,
    });
  });

  it('a clip with a malformed box is dropped, not thrown', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      clip: { box: { min: [0, 0], max: [10, 10, 5] }, mode: 'keep-inside', enabled: true },
    };
    expect(parseSession(JSON.stringify(doc)).clip).toBeUndefined();
  });
});
