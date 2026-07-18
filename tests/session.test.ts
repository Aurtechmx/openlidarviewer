import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession, SESSION_VERSION, isSessionFile, SESSION_EXTENSION } from '../src/io/session';
import type { InspectionSession, SavedView } from '../src/io/session';
import {
  buildProcessingManifest,
  verifyProcessingManifest,
  type ProcessingManifest,
} from '../src/science/processingManifest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { Annotation } from '../src/render/annotate/types';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

describe('isSessionFile — the single session-vs-scan router predicate', () => {
  it('recognises the canonical .olvsession extension, case-insensitively', () => {
    expect(isSessionFile('survey.olvsession')).toBe(true);
    expect(isSessionFile('SURVEY.OLVSESSION')).toBe(true);
    expect(isSessionFile(`a.b.c${SESSION_EXTENSION}`)).toBe(true);
  });

  it('rejects point-cloud scans and other files', () => {
    for (const n of ['scan.las', 'scan.laz', 'cloud.copc.laz', 'model.glb', 'a.json', 'olvsession', 'notes.txt']) {
      expect(isSessionFile(n)).toBe(false);
    }
  });
});

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

  it('round-trips the point-filter windows (v6), order-normalised', () => {
    const back = parseSession(
      serializeSession({
        ...sampleSession(),
        pointFilters: { elevation: [10, 50], intensity: [4000, 100] },
      }),
    );
    expect(back.pointFilters?.elevation).toEqual([10, 50]);
    // Intensity given hi<lo is normalised to [min, max].
    expect(back.pointFilters?.intensity).toEqual([100, 4000]);
  });

  it('omits pointFilters entirely when no window is set (pre-v6 byte-shape)', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    expect('pointFilters' in doc).toBe(false);
  });

  it('drops a malformed point-filter window rather than throwing', () => {
    const back = parseSession(
      serializeSession({
        ...sampleSession(),
        pointFilters: { elevation: [Number.NaN, 5] as unknown as [number, number] },
      }),
    );
    expect(back.pointFilters).toBeUndefined();
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
        fileName: 'sample_uav_survey.copc.laz',
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
    expect(back.scanSummary?.fileName).toBe('sample_uav_survey.copc.laz');
    expect(back.scanSummary?.sourcePoints).toBe(9_600_000);
    expect(back.scanSummary?.crs).toMatch(/UTM zone 12N/);
    expect(back.scanSummary?.crsUnit).toBe('metre');
  });

  it('clamps a pathological pointSize on parse (defense in depth)', () => {
    const huge = parseSession(serializeSession({
      ...sampleSession(),
      render: { pointSize: 1e9, edlEnabled: false, edlStrength: 0.4, pointSizeMode: 'adaptive', antialiasing: true },
    }));
    expect(huge.render?.pointSize).toBe(8);
    const tiny = parseSession(serializeSession({
      ...sampleSession(),
      render: { pointSize: 0.01, edlEnabled: false, edlStrength: 0.4, pointSizeMode: 'adaptive', antialiasing: true },
    }));
    expect(tiny.render?.pointSize).toBe(1);
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
    // The v7 bump is the R3 coordinated one: per-view state bundles plus the
    // reserved processingManifest slot land together, so later workstreams
    // (the manifest writer) do NOT need another version change.
    expect(SESSION_VERSION).toBe(7);
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

describe('Evidence Capsule — per-measurement trust round-trips (v6)', () => {
  it('preserves a measurement trust grade across serialize → parse', () => {
    const withTrust: Omit<InspectionSession, 'app' | 'kind' | 'version'> = {
      ...sampleSession(),
      measurements: [
        {
          id: 'd1', kind: 'distance', name: 'D1', points: [p(0, 0, 0), p(1, 0, 0)],
          trust: { grade: 'yellow', caption: 'Caution', reasons: ['sparse area'], presentable: true },
        },
      ],
    };
    const back = parseSession(serializeSession(withTrust));
    expect(back.measurements[0].trust).toEqual({
      grade: 'yellow', caption: 'Caution', reasons: ['sparse area'], presentable: true,
    });
  });

  it('drops a malformed trust block rather than restoring garbage', () => {
    const doc = {
      app: 'OpenLiDARViewer', kind: 'measurement-session', version: 6,
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], annotations: [],
      measurements: [
        { id: 'd', kind: 'distance', name: 'D', points: [[0, 0, 0], [1, 0, 0]], trust: { grade: 'purple' } },
      ],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.measurements).toHaveLength(1);
    expect(back.measurements[0].trust).toBeUndefined();
  });
});

describe('v6 software stamp', () => {
  test('round-trips the producing app version', () => {
    const back = parseSession(serializeSession({ ...sampleSession(), software: '0.5.2' }));
    expect(back.software).toBe('0.5.2');
  });
  test('omitted when not supplied (pre-v6 byte shape preserved)', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    expect('software' in doc).toBe(false);
  });
  test('a non-string software field is ignored on parse', () => {
    const raw = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    raw.software = 42;
    expect(parseSession(JSON.stringify(raw)).software).toBeUndefined();
  });
});

describe('v0.5.6 — profile / box / volume measurement kinds round-trip', () => {
  function withKinds(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
    const base = sampleSession();
    const extra: Measurement[] = [
      {
        id: 'prof1',
        kind: 'profile',
        name: 'Transect',
        points: [p(0, 0, 0), p(10, 0, 2)],
        profileChart: [
          { distance: 0, height: 1, count: 5 },
          { distance: 5, height: NaN },
          { distance: 10, height: 2, count: 3 },
        ],
        profileChartResidentOnly: true,
        profileCorridorWidth: 1.5,
        profileGroundPercentile: 15,
      },
      { id: 'box1', kind: 'box', name: 'BBox', points: [p(0, 0, 0), p(2, 3, 4)] },
      {
        id: 'vol1',
        kind: 'volume',
        name: 'Stockpile',
        points: [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0)],
        volume: {
          fill: 10, cut: 2, net: 8, referenceZ: 0.5,
          footprintArea: 1, pointsInPolygon: 1200, densityNative: 3.2, confidence: 'high',
        },
        volumeResidentOnly: true,
      },
    ];
    return { ...base, measurements: [...base.measurements, ...extra] };
  }

  test('all three kinds survive a serialize → parse round-trip', () => {
    const back = parseSession(serializeSession(withKinds())).measurements;
    const kinds = back.map((m) => m.kind);
    expect(kinds).toContain('profile');
    expect(kinds).toContain('box');
    expect(kinds).toContain('volume');
  });

  test('profile keeps its chart (with NaN gap), corridor width, ground percentile, resident flag', () => {
    const back = parseSession(serializeSession(withKinds())).measurements;
    const prof = back.find((m) => m.id === 'prof1');
    expect(prof).toBeDefined();
    expect(prof?.profileChart).toHaveLength(3);
    // JSON has no NaN literal — a corridor gap serialises as null and must restore to NaN.
    expect(Number.isNaN(prof?.profileChart?.[1].height ?? 0)).toBe(true);
    expect(prof?.profileChart?.[0].count).toBe(5);
    expect(prof?.profileCorridorWidth).toBe(1.5);
    expect(prof?.profileGroundPercentile).toBe(15);
    expect(prof?.profileChartResidentOnly).toBe(true);
  });

  test('volume keeps its cut/fill record and resident flag', () => {
    const back = parseSession(serializeSession(withKinds())).measurements;
    const vol = back.find((m) => m.id === 'vol1');
    expect(vol?.volume?.net).toBe(8);
    expect(vol?.volume?.confidence).toBe('high');
    expect(vol?.volumeResidentOnly).toBe(true);
  });

  test('a legacy volume record migrates its old `density` field to `densityNative`', () => {
    // Files written before the rename carry `density` (the same native value).
    const raw = JSON.parse(serializeSession(withKinds())) as { measurements: Record<string, unknown>[] };
    const vol = raw.measurements.find((m) => m.id === 'vol1')!;
    const record = vol.volume as Record<string, unknown>;
    record.density = record.densityNative; // as an old file would have it
    delete record.densityNative;
    const back = parseSession(JSON.stringify(raw)).measurements;
    const parsed = back.find((m) => m.id === 'vol1');
    expect(parsed?.volume?.densityNative).toBe(3.2);
  });

  test('a malformed volume record is dropped, but the measurement still imports', () => {
    const raw = JSON.parse(serializeSession(withKinds())) as { measurements: Record<string, unknown>[] };
    const vol = raw.measurements.find((m) => m.id === 'vol1');
    (vol!.volume as Record<string, unknown>).confidence = 'bogus';
    const back = parseSession(JSON.stringify(raw)).measurements;
    const parsed = back.find((m) => m.id === 'vol1');
    expect(parsed).toBeDefined();
    expect(parsed?.volume).toBeUndefined();
  });
});

describe('v7 — named restorable view states', () => {
  /** A view carrying the full v7 display-state bundle. */
  function fullBundleView(): SavedView {
    return {
      name: 'north-scarp',
      camera: { position: p(1, 2, 3), target: p(4, 5, 6), mode: 'orbit', fov: 42 },
      clip: {
        box: { min: [0, 0, 0] as Vec3, max: [10, 10, 5] as Vec3 },
        mode: 'keep-inside',
        enabled: true,
      },
      colorMode: 'elevation',
      classFilter: [3, 4, 5],
      pointFilters: { elevation: [10, 50], intensity: [100, 4000] },
      render: {
        pointSize: 2.5,
        edlEnabled: true,
        edlStrength: 0.6,
        pointSizeMode: 'fixed',
        antialiasing: false,
      },
    };
  }

  it('round-trips a named full-bundle view state', () => {
    const back = parseSession(
      serializeSession({ ...sampleSession(), views: [fullBundleView()] }),
    );
    expect(back.views).toHaveLength(1);
    const v = back.views[0];
    expect(v.name).toBe('north-scarp');
    expect(v.camera).toEqual({ position: [1, 2, 3], target: [4, 5, 6], mode: 'orbit', fov: 42 });
    expect(v.clip).toEqual({
      box: { min: [0, 0, 0], max: [10, 10, 5] }, mode: 'keep-inside', enabled: true,
    });
    expect(v.colorMode).toBe('elevation');
    expect(v.classFilter).toEqual([3, 4, 5]);
    expect(v.pointFilters).toEqual({ elevation: [10, 50], intensity: [100, 4000] });
    expect(v.render).toEqual({
      pointSize: 2.5, edlEnabled: true, edlStrength: 0.6,
      pointSizeMode: 'fixed', antialiasing: false,
    });
  });

  it('a v6 file imports under v7 with camera-only views intact (new fields undefined)', () => {
    const v6doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 6,
      upAxis: 'y',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [{ name: 'Figure 3', camera: { position: [1, 2, 3], target: [0, 0, 0] } }],
      measurements: [],
      annotations: [],
    };
    const back = parseSession(JSON.stringify(v6doc));
    expect(back.views).toHaveLength(1);
    expect(back.views[0].name).toBe('Figure 3');
    expect(back.views[0].camera.position).toEqual([1, 2, 3]);
    expect(back.views[0].clip).toBeUndefined();
    expect(back.views[0].colorMode).toBeUndefined();
    expect(back.views[0].classFilter).toBeUndefined();
    expect(back.views[0].pointFilters).toBeUndefined();
    expect(back.views[0].render).toBeUndefined();
    expect(back.version).toBe(SESSION_VERSION);
  });

  it('camera-only views keep the exact v6 byte-shape (name + camera, nothing else)', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as {
      views: Record<string, unknown>[];
    };
    // Key SET and key ORDER both pinned — this is what makes a v7 export of a
    // bundle-free view byte-identical to the v6 writer's output.
    expect(Object.keys(doc.views[0])).toEqual(['name', 'camera']);
    expect(doc.views[0]).toEqual({
      name: 'Overview',
      camera: { position: [1, 2, 3], target: [4, 5, 6], mode: 'orbit' },
    });
  });

  it('malformed per-view sub-fields are dropped, not thrown (name + camera kept)', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 7,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [{
        name: 'broken-extras',
        camera: { position: [1, 2, 3], target: [0, 0, 0] },
        clip: { box: { min: [0, 0], max: 'wide' }, mode: 'keep-inside', enabled: true },
        colorMode: 'sepia',
        classFilter: 'ground-only',
        pointFilters: { elevation: [Number.NaN, 5] },
        render: { edl: 'yes' },
      }],
      measurements: [],
      annotations: [],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.views).toHaveLength(1);
    const v = back.views[0];
    expect(v.name).toBe('broken-extras');
    expect(v.camera.position).toEqual([1, 2, 3]);
    expect(v.clip).toBeUndefined();
    expect(v.colorMode).toBeUndefined();
    expect(v.classFilter).toBeUndefined();
    expect(v.pointFilters).toBeUndefined();
    expect(v.render).toBeUndefined();
  });

  it('per-view classFilter and pointFilters are sanitised like the session globals', () => {
    const back = parseSession(serializeSession({
      ...sampleSession(),
      views: [{
        name: 'messy',
        camera: { position: p(0, 0, 0), target: p(1, 1, 1) },
        classFilter: [5, 3, 5, 999, -1],
        pointFilters: { elevation: [50, 10] },
      }],
    }));
    expect(back.views[0].classFilter).toEqual([3, 5]);
    expect(back.views[0].pointFilters?.elevation).toEqual([10, 50]);
  });

  it('a view whose classFilter sanitises to empty omits the field (emit-only-when-set)', () => {
    const doc = JSON.parse(serializeSession({
      ...sampleSession(),
      views: [{
        name: 'empties',
        camera: { position: p(0, 0, 0), target: p(1, 1, 1) },
        classFilter: [],
        pointFilters: {},
      }],
    })) as { views: Record<string, unknown>[] };
    expect(Object.keys(doc.views[0])).toEqual(['name', 'camera']);
  });

  it('still rejects an unsupported (future) version', () => {
    const doc = {
      app: 'OpenLiDARViewer', kind: 'measurement-session', version: 8,
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric',
      views: [], measurements: [], annotations: [],
    };
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/Unsupported session version/);
  });
});

describe('v7 — reserved processingManifest passthrough', () => {
  it('round-trips an arbitrary manifest opaquely (no validation, no loss)', () => {
    const manifest = {
      schema: 'olv-processing-manifest@1',
      steps: [
        { op: 'crop', params: { bounds: [0, 0, 0, 10, 10, 5] } },
        { op: 'classify', params: { method: 'smrf', version: 2 }, notes: ['deterministic'] },
      ],
      digest: 'sha256:abc123',
    };
    const back = parseSession(
      serializeSession({ ...sampleSession(), processingManifest: manifest }),
    );
    expect(back.processingManifest).toEqual(manifest);
  });

  it('is omitted from the JSON when absent (byte-shape preserved)', () => {
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    expect('processingManifest' in doc).toBe(false);
  });

  it('a manifest in a hand-edited older-versioned file still passes through', () => {
    // The field is opaque and version-independent on read: a reader never
    // validates it, so the NEXT workstream can populate it without another
    // version bump and older-tagged files carrying one keep it.
    const doc = {
      app: 'OpenLiDARViewer', kind: 'measurement-session', version: 6,
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric',
      views: [], measurements: [], annotations: [],
      processingManifest: ['anything', { nested: true }],
    };
    expect(parseSession(JSON.stringify(doc)).processingManifest)
      .toEqual(['anything', { nested: true }]);
  });

  it('a hostile literal-null manifest is treated as absent and never re-emitted', () => {
    // A hand-edited file can carry `"processingManifest": null`. The parser must
    // read that as "no manifest" (not a truthy opaque value), and re-serialising
    // must omit the key entirely so the null can't propagate as byte-noise.
    const doc = JSON.parse(serializeSession(sampleSession())) as Record<string, unknown>;
    doc.processingManifest = null;
    const back = parseSession(JSON.stringify(doc));
    expect(back.processingManifest).toBeUndefined();
    expect('processingManifest' in (JSON.parse(serializeSession(back)) as object)).toBe(false);
  });

  it('a REAL processing manifest round-trips opaquely and still verifies', () => {
    // The actual manifest the exporter embeds (not a synthetic stand-in): the
    // session layer must pass it through byte-faithfully enough that the hash
    // chain still verifies after serialize → parse — the whole point of
    // carrying it.
    const manifest = buildProcessingManifest({
      build: '0.5.9 (abc1234)',
      source: 'site.laz',
      ops: [
        { method: 'olv.ground.smrf@1', params: {}, note: 'params not captured in this slice' },
        { method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' } },
      ],
    });
    const back = parseSession(
      serializeSession({ ...sampleSession(), processingManifest: manifest }),
    );
    expect(back.processingManifest).toEqual(manifest);
    expect(verifyProcessingManifest(back.processingManifest as ProcessingManifest))
      .toEqual({ ok: true });
  });
});
