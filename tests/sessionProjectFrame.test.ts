/**
 * tests/sessionProjectFrame.test.ts
 *
 * The session v8 project-frame schema: one project origin plus one record per
 * layer (stable id, source fingerprint, source name, source origin, the Float64
 * transform into the project frame, the resolved CRS, the up axis).
 *
 * Two properties carry the whole schema. A frame round-trips EXACTLY, including
 * values Float32 cannot hold, because the transform is frame data rather than
 * render data. And a frame whose declared numbers contradict each other is
 * refused rather than coerced, because a guessed frame silently moves every
 * measurement that resolves through it.
 */

import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession, SESSION_VERSION } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';
import {
  buildSessionProjectFrame,
  parseSessionProjectFrame,
  serializeSessionProjectFrame,
  validateSessionProjectFrame,
  frameLayer,
  frameAnchorLayerId,
  withoutFrameLayer,
  withFrameLayerOrder,
  MAX_FRAME_LAYERS,
} from '../src/io/sessionFrame';
import type { SessionLayerRecord, SessionProjectFrame } from '../src/io/sessionFrame';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Vec3 } from '../src/render/measure/types';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

const CRS: ResolvedCrs = {
  kind: 'projected',
  name: 'ETRS89 / UTM zone 30N',
  epsg: 25830,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

/**
 * A project origin and two layers placed into it. The eastings carry more
 * significant digits than Float32 holds, so any pass through a 32-bit slot
 * shows up as an inequality rather than a rounding a reader has to notice.
 */
const PROJECT_ORIGIN: Vec3 = [516_000.123_456_789_1, 4_644_000.987_654_321, 70.5];

function anchorLayer(): SessionLayerRecord {
  return {
    layerId: 'layer_anchor',
    sourceFingerprint: 'f scan.laz 1000000 120.000000 80.000000 12.000000 25830 ETRS89 / UTM zone 30N',
    sourceName: 'scan.laz',
    sourceOrigin: [516_000.123_456_789_1, 4_644_000.987_654_321, 70.5],
    sourceToProject: [0, 0, 0],
    crs: CRS,
    upAxis: 'z',
  };
}

function secondLayer(): SessionLayerRecord {
  return {
    layerId: 'layer_second',
    // Same FILE NAME as the anchor, different content: the collision case the
    // fingerprint has to survive.
    sourceFingerprint: 'f scan.laz 250000 60.000000 40.000000 9.000000 25830 ETRS89 / UTM zone 30N',
    sourceName: 'scan.laz',
    sourceOrigin: [516_100.123_456_789_1, 4_644_050.987_654_321, 71.5],
    sourceToProject: [100, 50, 1],
    crs: CRS,
    upAxis: 'z',
  };
}

function twoLayerFrame(): SessionProjectFrame {
  return { projectOrigin: PROJECT_ORIGIN, layers: [anchorLayer(), secondLayer()] };
}

function baseSession(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return {
    upAxis: 'z',
    origin: p(516_000, 4_644_000, 70),
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations: [],
  };
}

describe('session v8: the schema version', () => {
  it('writes version 8', () => {
    const doc = JSON.parse(serializeSession(baseSession()));
    expect(doc.version).toBe(8);
    expect(SESSION_VERSION).toBe(8);
  });

  it('still reads every version it used to (v1 through v7)', () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const doc = {
        app: 'OpenLiDARViewer',
        kind: 'measurement-session',
        version,
        upAxis: 'z',
        origin: [1, 2, 3],
        unitSystem: 'metric',
        views: [],
        measurements: [],
        annotations: [],
      };
      const parsed = parseSession(JSON.stringify(doc));
      expect(parsed.origin).toEqual([1, 2, 3]);
      expect(parsed.projectFrame).toBeUndefined();
    }
  });

  it('refuses a version it does not know', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 9,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
    };
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/Unsupported session version/);
  });
});

describe('session v8: project-frame round trip', () => {
  it('preserves every layer field exactly across export then import', () => {
    const frame = twoLayerFrame();
    const back = parseSession(serializeSession({ ...baseSession(), projectFrame: frame }));
    expect(back.projectFrame).toEqual(frame);
  });

  it('keeps the transform in Float64 (a Float32 pass would round it)', () => {
    const frame = twoLayerFrame();
    const back = parseSession(serializeSession({ ...baseSession(), projectFrame: frame }));
    const layer = frameLayer(back.projectFrame!, 'layer_anchor')!;
    expect(layer.sourceOrigin[0]).toBe(516_000.123_456_789_1);
    expect(layer.sourceOrigin[1]).toBe(4_644_000.987_654_321);
    expect(back.projectFrame!.projectOrigin[0]).toBe(516_000.123_456_789_1);
    // The value must not merely be close: Float32 cannot represent it at all.
    expect(Math.fround(516_000.123_456_789_1)).not.toBe(516_000.123_456_789_1);
  });

  it('preserves the CRS and the up axis per layer', () => {
    const frame = twoLayerFrame();
    const back = parseSession(serializeSession({ ...baseSession(), projectFrame: frame }));
    const layer = frameLayer(back.projectFrame!, 'layer_second')!;
    expect(layer.crs).toEqual(CRS);
    expect(layer.upAxis).toBe('z');
    expect(layer.sourceName).toBe('scan.laz');
    expect(layer.sourceFingerprint).toBe(secondLayer().sourceFingerprint);
  });

  it('accepts a layer with no CRS and a Y-up layer', () => {
    const frame: SessionProjectFrame = {
      projectOrigin: [0, 0, 0],
      layers: [
        {
          layerId: 'layer_mesh',
          sourceFingerprint: 'f mesh.ply 4000 3.000000 2.000000 1.000000  ',
          sourceName: 'mesh.ply',
          sourceOrigin: [0, 0, 0],
          sourceToProject: [0, 0, 0],
          upAxis: 'y',
        },
      ],
    };
    const back = parseSession(serializeSession({ ...baseSession(), projectFrame: frame }));
    expect(back.projectFrame).toEqual(frame);
    expect(back.projectFrame!.layers[0].crs).toBeUndefined();
  });

  it('omits the field entirely when no frame is supplied (byte shape preserved)', () => {
    const json = serializeSession(baseSession());
    expect(json).not.toContain('projectFrame');
    expect(parseSession(json).projectFrame).toBeUndefined();
  });

  it('a written session is readable by the version that wrote it', () => {
    const json = serializeSession({ ...baseSession(), projectFrame: twoLayerFrame() });
    const once = parseSession(json);
    const twice = parseSession(
      serializeSession({ ...baseSession(), projectFrame: once.projectFrame }),
    );
    expect(twice.projectFrame).toEqual(once.projectFrame);
  });
});

describe('session v8: an inconsistent frame is refused, not coerced', () => {
  const refuse = (frame: unknown, pattern: RegExp): void => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 8,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      projectFrame: frame,
    };
    expect(() => parseSession(JSON.stringify(doc))).toThrow(pattern);
  };

  it('refuses a transform that contradicts the origins it is derived from', () => {
    const frame = twoLayerFrame();
    const broken: SessionProjectFrame = {
      projectOrigin: frame.projectOrigin,
      // The record claims an offset of 7 where its own origins say 100.
      layers: [frame.layers[0], { ...frame.layers[1], sourceToProject: [7, 50, 1] }],
    };
    refuse(broken, /transform/i);
  });

  it('refuses two layers declaring the same id', () => {
    const frame = twoLayerFrame();
    refuse(
      { projectOrigin: frame.projectOrigin, layers: [frame.layers[0], { ...frame.layers[1], layerId: 'layer_anchor' }] },
      /duplicate/i,
    );
  });

  it('refuses a non-finite project origin', () => {
    refuse({ projectOrigin: [0, 'x', 0], layers: [anchorLayer()] }, /project origin/i);
  });

  it('refuses a frame that declares no layers', () => {
    refuse({ projectOrigin: [0, 0, 0], layers: [] }, /no layers/i);
  });

  it('refuses a layer with no id', () => {
    refuse({ projectOrigin: [0, 0, 0], layers: [{ ...anchorLayer(), layerId: '', sourceOrigin: [0, 0, 0] }] }, /layer id/i);
  });

  it('refuses an up axis outside x/y/z', () => {
    refuse(
      { projectOrigin: [0, 0, 0], layers: [{ ...anchorLayer(), sourceOrigin: [0, 0, 0], upAxis: 'up' }] },
      /up axis/i,
    );
  });

  it('refuses a frame that is not an object at all', () => {
    refuse('a frame', /project frame/i);
  });

  it('refuses to WRITE an inconsistent frame (never produces a file it cannot read)', () => {
    const frame = twoLayerFrame();
    const broken = {
      projectOrigin: frame.projectOrigin,
      layers: [frame.layers[0], { ...frame.layers[1], sourceToProject: [7, 50, 1] as Vec3 }],
    };
    expect(() => serializeSession({ ...baseSession(), projectFrame: broken })).toThrow(/transform/i);
  });

  it('names every reason it refused, not just the first', () => {
    const reasons = validateSessionProjectFrame({
      projectOrigin: [0, 0, 0],
      layers: [
        { ...anchorLayer(), layerId: '', sourceOrigin: [0, 0, 0], upAxis: 'up' },
      ],
    });
    expect(reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('session v8: the placement rule the frame encodes', () => {
  it('accepts a horizontal-only placement (Z left on the source origin)', () => {
    // A layer whose vertical datum is unproven is placed in X/Y and keeps its
    // own Z. That is what LayerService writes, so the schema must accept it.
    const frame: SessionProjectFrame = {
      projectOrigin: [516_000, 4_644_000, 70],
      layers: [
        anchorLayerAt([516_000, 4_644_000, 70]),
        {
          ...secondLayer(),
          sourceOrigin: [516_100, 4_644_050, 71.5],
          sourceToProject: [100, 50, 0],
        },
      ],
    };
    expect(validateSessionProjectFrame(frame)).toEqual([]);
    const back = parseSession(serializeSession({ ...baseSession(), projectFrame: frame }));
    expect(back.projectFrame).toEqual(frame);
  });

  it('accepts an unplaced layer (its own frame, all-zero transform)', () => {
    const frame: SessionProjectFrame = {
      projectOrigin: [516_000, 4_644_000, 70],
      layers: [
        anchorLayerAt([516_000, 4_644_000, 70]),
        { ...secondLayer(), sourceOrigin: [516_100, 4_644_050, 71.5], sourceToProject: [0, 0, 0] },
      ],
    };
    expect(validateSessionProjectFrame(frame)).toEqual([]);
  });

  it('refuses a placement applied on one horizontal axis only', () => {
    const frame: SessionProjectFrame = {
      projectOrigin: [516_000, 4_644_000, 70],
      layers: [
        anchorLayerAt([516_000, 4_644_000, 70]),
        { ...secondLayer(), sourceOrigin: [516_100, 4_644_050, 71.5], sourceToProject: [100, 0, 0] },
      ],
    };
    expect(validateSessionProjectFrame(frame).join(' ')).toMatch(/horizontal/i);
  });
});

function anchorLayerAt(origin: Vec3): SessionLayerRecord {
  return { ...anchorLayer(), sourceOrigin: origin, sourceToProject: [0, 0, 0] };
}

describe('sessionFrame: building a frame from live layers', () => {
  it('derives each transform from the origins rather than trusting a caller', () => {
    const frame = buildSessionProjectFrame({
      projectOrigin: [516_000, 4_644_000, 70],
      layers: [
        {
          layerId: 'layer_a',
          sourceFingerprint: 'f a.laz 10 1.000000 1.000000 1.000000  ',
          sourceName: 'a.laz',
          sourceOrigin: [516_000, 4_644_000, 70],
          upAxis: 'z',
        },
        {
          layerId: 'layer_b',
          sourceFingerprint: 'f b.laz 20 2.000000 2.000000 2.000000  ',
          sourceName: 'b.laz',
          sourceOrigin: [516_250, 4_644_125, 72],
          upAxis: 'z',
          placed: true,
        },
      ],
    });
    expect(frameLayer(frame, 'layer_b')!.sourceToProject).toEqual([250, 125, 2]);
    // Not placed ⇒ stays in its own frame, which is an all-zero transform.
    expect(frameLayer(frame, 'layer_a')!.sourceToProject).toEqual([0, 0, 0]);
    expect(validateSessionProjectFrame(frame)).toEqual([]);
  });

  it('places horizontally only when the vertical is unproven', () => {
    const frame = buildSessionProjectFrame({
      projectOrigin: [516_000, 4_644_000, 70],
      layers: [
        {
          layerId: 'layer_b',
          sourceFingerprint: 'f b.laz 20 2.000000 2.000000 2.000000  ',
          sourceName: 'b.laz',
          sourceOrigin: [516_250, 4_644_125, 72],
          upAxis: 'z',
          placed: true,
          placedVertically: false,
        },
      ],
    });
    expect(frameLayer(frame, 'layer_b')!.sourceToProject).toEqual([250, 125, 0]);
  });

  it('refuses to build a frame with a duplicate layer id', () => {
    expect(() =>
      buildSessionProjectFrame({
        projectOrigin: [0, 0, 0],
        layers: [
          { layerId: 'x', sourceFingerprint: 'f', sourceName: 'a', sourceOrigin: [0, 0, 0], upAxis: 'z' },
          { layerId: 'x', sourceFingerprint: 'f', sourceName: 'b', sourceOrigin: [0, 0, 0], upAxis: 'z' },
        ],
      }),
    ).toThrow(/duplicate/i);
  });
});

describe('sessionFrame: lookups and set edits', () => {
  it('finds a layer by id and reports the anchor', () => {
    const frame = twoLayerFrame();
    expect(frameLayer(frame, 'layer_second')!.sourceName).toBe('scan.laz');
    expect(frameLayer(frame, 'layer_missing')).toBeNull();
    expect(frameAnchorLayerId(frame)).toBe('layer_anchor');
  });

  it('has no anchor when two layers both sit on the project origin', () => {
    const frame: SessionProjectFrame = {
      projectOrigin: [0, 0, 0],
      layers: [
        { ...anchorLayer(), sourceOrigin: [0, 0, 0] },
        { ...secondLayer(), sourceOrigin: [0, 0, 0], sourceToProject: [0, 0, 0] },
      ],
    };
    expect(frameAnchorLayerId(frame)).toBeNull();
  });

  it('removing a layer leaves the project origin and every other record untouched', () => {
    const frame = twoLayerFrame();
    const after = withoutFrameLayer(frame, 'layer_second');
    expect(after.projectOrigin).toEqual(frame.projectOrigin);
    expect(after.layers).toEqual([frame.layers[0]]);
    expect(validateSessionProjectFrame(after)).toEqual([]);
  });

  it('removing the last layer is refused rather than leaving an empty frame', () => {
    const frame: SessionProjectFrame = { projectOrigin: [0, 0, 0], layers: [anchorLayerAt([0, 0, 0])] };
    expect(() => withoutFrameLayer(frame, 'layer_anchor')).toThrow(/no layers/i);
  });

  it('reordering changes only the order, never a record', () => {
    const frame = twoLayerFrame();
    const after = withFrameLayerOrder(frame, ['layer_second', 'layer_anchor']);
    expect(after.layers.map((l) => l.layerId)).toEqual(['layer_second', 'layer_anchor']);
    expect(after.projectOrigin).toEqual(frame.projectOrigin);
    expect(frameLayer(after, 'layer_anchor')).toEqual(frameLayer(frame, 'layer_anchor'));
    expect(frameLayer(after, 'layer_second')).toEqual(frameLayer(frame, 'layer_second'));
  });

  it('an order naming an unknown or missing layer is refused', () => {
    const frame = twoLayerFrame();
    expect(() => withFrameLayerOrder(frame, ['layer_second', 'layer_ghost'])).toThrow(/order/i);
    expect(() => withFrameLayerOrder(frame, ['layer_second'])).toThrow(/order/i);
  });
});

describe('sessionFrame: parse and serialize agree', () => {
  it('a parsed frame re-serialises to the same document', () => {
    const frame = twoLayerFrame();
    const doc = serializeSessionProjectFrame(frame);
    expect(parseSessionProjectFrame(JSON.parse(JSON.stringify(doc)))).toEqual(frame);
  });

  it('drops nothing and adds nothing to a record', () => {
    const doc = JSON.parse(JSON.stringify(serializeSessionProjectFrame(twoLayerFrame())));
    expect(Object.keys(doc).sort()).toEqual(['layers', 'projectOrigin']);
    expect(Object.keys(doc.layers[0]).sort()).toEqual([
      'crs',
      'layerId',
      'sourceFingerprint',
      'sourceName',
      'sourceOrigin',
      'sourceToProject',
      'upAxis',
    ]);
  });
});

describe('validateSessionProjectFrame — layer-count ceiling (hostile input)', () => {
  it('refuses a frame that declares more than MAX_FRAME_LAYERS layers', () => {
    const layer = {
      layerId: 'L',
      sourceFingerprint: 'f',
      sourceName: 'n',
      sourceOrigin: [0, 0, 0],
      sourceToProject: [0, 0, 0],
      upAxis: 'z',
    };
    const frame = { projectOrigin: [0, 0, 0], layers: new Array(MAX_FRAME_LAYERS + 1).fill(layer) };
    const reasons = validateSessionProjectFrame(frame);
    // The count check fires up front and returns early — so the cap reason is
    // present (the per-layer duplicate-id walk never runs).
    expect(reasons.some((r) => r.includes('above the') && r.includes(String(MAX_FRAME_LAYERS)))).toBe(true);
    // And the strict reader refuses it, like any other inconsistent frame.
    expect(() => parseSessionProjectFrame(frame)).toThrow(/inconsistent/i);
  });
});
