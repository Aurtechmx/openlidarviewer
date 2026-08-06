/**
 * tests/sessionWorkOwnership.test.ts
 *
 * Ownership of saved work. Every measurement and annotation persists either the
 * stable id of the layer it belongs to plus source-local geometry, or an
 * explicit declaration that its stored coordinates are already project-frame.
 * Nothing is ever attributed from a filename or a display label, because both
 * collide and both change.
 *
 * The properties under test are the ones a user would notice being wrong: work
 * keeps its owner across an export and import even when two layers share a
 * filename, reordering or removing a layer does not move anything that survives,
 * and a session written before ownership existed imports intact with its
 * assignment marked inferred rather than asserted.
 */

import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';
import type { SessionProjectFrame } from '../src/io/sessionFrame';
import {
  sourceLocalOwnership,
  projectFrameOwnership,
  parseWorkOwnership,
  resolveOwnerLayer,
  hasDistinguishingSourceFacts,
  resolveWorldPoint,
} from '../src/model/workOwnership';
import { migrateSessionOwnership, resolveSessionAnchorLayerId } from '../src/io/sessionOwnership';
import { LayerIdentityRegistry, fingerprintKey } from '../src/model/layerIdentity';
import type { LayerFingerprint } from '../src/model/layerIdentity';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { Annotation } from '../src/render/annotate/types';
import { withoutFrameLayer, withFrameLayerOrder } from '../src/io/sessionFrame';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

// Two layers, same filename, different content: the collision case.
const FACTS_A: LayerFingerprint = {
  fileName: 'scan.laz',
  sourcePoints: 1_000_000,
  width: 120,
  depth: 80,
  height: 12,
  epsg: 25830,
  crs: 'ETRS89 / UTM zone 30N',
};
const FACTS_B: LayerFingerprint = {
  fileName: 'scan.laz',
  sourcePoints: 250_000,
  width: 60,
  depth: 40,
  height: 9,
  epsg: 25830,
  crs: 'ETRS89 / UTM zone 30N',
};

const FRAME: SessionProjectFrame = {
  projectOrigin: [516_000, 4_644_000, 70],
  layers: [
    {
      layerId: 'layer_a',
      sourceFingerprint: fingerprintKey(FACTS_A),
      sourceName: 'scan.laz',
      sourceOrigin: [516_000, 4_644_000, 70],
      sourceToProject: [0, 0, 0],
      upAxis: 'z',
    },
    {
      layerId: 'layer_b',
      sourceFingerprint: fingerprintKey(FACTS_B),
      sourceName: 'scan.laz',
      sourceOrigin: [516_400, 4_644_200, 74],
      sourceToProject: [400, 200, 4],
      upAxis: 'z',
    },
  ],
};

function measurement(id: string, owner?: Measurement['owner']): Measurement {
  const m: Measurement = {
    id,
    kind: 'distance',
    name: id,
    points: [p(1.5, 2.5, 3.5), p(11.5, 2.5, 3.5)],
  };
  if (owner) m.owner = owner;
  return m;
}

function annotation(id: string, owner?: Annotation['owner']): Annotation {
  const a: Annotation = {
    id,
    title: id,
    type: 'note',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    localPosition: { x: 4, y: 5, z: 6 },
  };
  if (owner) a.owner = owner;
  return a;
}

function session(
  over: Partial<Omit<InspectionSession, 'app' | 'kind' | 'version'>> = {},
): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return {
    upAxis: 'z',
    origin: p(516_000, 4_644_000, 70),
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations: [],
    ...over,
  };
}

describe('work ownership: the record itself', () => {
  it('a source-local owner names the layer and the frame its coordinates are in', () => {
    const owner = sourceLocalOwnership('layer_a');
    expect(owner).toEqual({ layerId: 'layer_a', frame: 'source-local' });
  });

  it('a project-frame owner declares the frame with no layer required', () => {
    expect(projectFrameOwnership()).toEqual({ frame: 'project' });
  });

  it('an inferred assignment says so', () => {
    expect(sourceLocalOwnership('layer_a', { inferred: true })).toEqual({
      layerId: 'layer_a',
      frame: 'source-local',
      inferred: true,
    });
  });

  it('refuses to build a source-local owner with no layer id', () => {
    expect(() => sourceLocalOwnership('')).toThrow(/layer id/i);
  });

  it('parses a stored owner and rejects the malformed ones', () => {
    expect(parseWorkOwnership({ layerId: 'layer_a', frame: 'source-local' })).toEqual({
      layerId: 'layer_a',
      frame: 'source-local',
    });
    expect(parseWorkOwnership({ frame: 'project' })).toEqual({ frame: 'project' });
    // A source-local claim with no layer names no owner at all.
    expect(parseWorkOwnership({ frame: 'source-local' })).toBeNull();
    expect(parseWorkOwnership({ layerId: 'layer_a' })).toBeNull();
    expect(parseWorkOwnership({ layerId: 'layer_a', frame: 'world' })).toBeNull();
    expect(parseWorkOwnership(null)).toBeNull();
    expect(parseWorkOwnership('layer_a')).toBeNull();
  });
});

describe('work ownership: resolving an owner from source facts, never a name', () => {
  const candidates = [
    { layerId: 'layer_a', facts: FACTS_A },
    { layerId: 'layer_b', facts: FACTS_B },
  ];

  it('resolves two same-named layers apart on their content facts', () => {
    expect(resolveOwnerLayer(candidates, FACTS_A)).toEqual({ kind: 'resolved', layerId: 'layer_a' });
    expect(resolveOwnerLayer(candidates, FACTS_B)).toEqual({ kind: 'resolved', layerId: 'layer_b' });
  });

  it('refuses to resolve on a filename alone', () => {
    const nameOnly: LayerFingerprint = { fileName: 'scan.laz' };
    expect(hasDistinguishingSourceFacts(nameOnly)).toBe(false);
    expect(resolveOwnerLayer(candidates, nameOnly)).toEqual({
      kind: 'unresolved',
      reason: 'filename-only',
    });
  });

  it('treats a point count or an extent as distinguishing, a CRS label alone as not', () => {
    expect(hasDistinguishingSourceFacts({ fileName: 'a.laz', sourcePoints: 10 })).toBe(true);
    expect(hasDistinguishingSourceFacts({ fileName: 'a.laz', width: 10, depth: 5, height: 1 })).toBe(true);
    expect(hasDistinguishingSourceFacts({ fileName: 'a.laz', crs: 'EPSG:25830' })).toBe(false);
  });

  it('reports no match rather than picking the nearest', () => {
    expect(resolveOwnerLayer(candidates, { ...FACTS_A, sourcePoints: 7 })).toEqual({
      kind: 'unresolved',
      reason: 'no-match',
    });
  });

  it('reports an ambiguity rather than choosing between identical candidates', () => {
    const twins = [
      { layerId: 'layer_a', facts: FACTS_A },
      { layerId: 'layer_a_copy', facts: FACTS_A },
    ];
    expect(resolveOwnerLayer(twins, FACTS_A)).toEqual({ kind: 'unresolved', reason: 'ambiguous' });
  });

  it('resolves a reopened scan onto the id the registry remembers', () => {
    let n = 0;
    const registry = new LayerIdentityRegistry({ generateId: () => `layer_${++n}` });
    const first = registry.resolve(FACTS_A, 'scan.laz');
    registry.remove(first.layerId);
    const reopened = registry.resolve(FACTS_A, 'renamed after reopen');
    expect(reopened.layerId).toBe(first.layerId);
    expect(
      resolveOwnerLayer([{ layerId: reopened.layerId, facts: FACTS_A }], FACTS_A),
    ).toEqual({ kind: 'resolved', layerId: first.layerId });
  });
});

describe('work ownership: where the stored coordinates actually are', () => {
  it('lifts source-local geometry through its OWN layer origin', () => {
    expect(resolveWorldPoint(p(1, 2, 3), sourceLocalOwnership('layer_b'), FRAME)).toEqual([
      516_401, 4_644_202, 77,
    ]);
  });

  it('lifts project-frame geometry through the project origin', () => {
    expect(resolveWorldPoint(p(1, 2, 3), projectFrameOwnership(), FRAME)).toEqual([
      516_001, 4_644_002, 73,
    ]);
  });

  it('returns null rather than guessing when the owner is unknown or absent', () => {
    expect(resolveWorldPoint(p(1, 2, 3), undefined, FRAME)).toBeNull();
    expect(resolveWorldPoint(p(1, 2, 3), sourceLocalOwnership('layer_ghost'), FRAME)).toBeNull();
  });
});

describe('session v8: ownership survives export and import', () => {
  it('a measurement keeps the SAME owning layer, with two layers sharing a filename', () => {
    const json = serializeSession(
      session({
        projectFrame: FRAME,
        measurements: [
          measurement('m1', sourceLocalOwnership('layer_a')),
          measurement('m2', sourceLocalOwnership('layer_b')),
        ],
        annotations: [annotation('a1', sourceLocalOwnership('layer_b'))],
      }),
    );
    const back = parseSession(json);
    expect(back.measurements[0].owner).toEqual({ layerId: 'layer_a', frame: 'source-local' });
    expect(back.measurements[1].owner).toEqual({ layerId: 'layer_b', frame: 'source-local' });
    expect(back.annotations[0].owner).toEqual({ layerId: 'layer_b', frame: 'source-local' });
    // Both layers carry the same source NAME; only the ids tell them apart.
    expect(FRAME.layers[0].sourceName).toBe(FRAME.layers[1].sourceName);
  });

  it('a renamed layer does not change what its work belongs to', () => {
    const renamed: SessionProjectFrame = {
      projectOrigin: FRAME.projectOrigin,
      layers: [FRAME.layers[0], { ...FRAME.layers[1], sourceName: 'north scarp (renamed).laz' }],
    };
    const back = parseSession(
      serializeSession({
        ...session({ projectFrame: renamed }),
        measurements: [measurement('m2', sourceLocalOwnership('layer_b'))],
      }),
    );
    expect(back.measurements[0].owner!.layerId).toBe('layer_b');
    expect(
      resolveWorldPoint(back.measurements[0].points[0], back.measurements[0].owner, back.projectFrame!),
    ).toEqual(resolveWorldPoint(p(1.5, 2.5, 3.5), sourceLocalOwnership('layer_b'), FRAME));
  });

  it('a project-frame declaration round-trips as a declaration', () => {
    const back = parseSession(
      serializeSession(
        session({ projectFrame: FRAME, measurements: [measurement('m3', projectFrameOwnership())] }),
      ),
    );
    expect(back.measurements[0].owner).toEqual({ frame: 'project' });
  });

  it('refuses a session whose work names a layer the frame does not contain', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 8,
      upAxis: 'z',
      origin: [516_000, 4_644_000, 70],
      unitSystem: 'metric',
      views: [],
      measurements: [measurement('m1', { layerId: 'layer_ghost', frame: 'source-local' })],
      annotations: [],
      projectFrame: FRAME,
    };
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/layer/i);
  });

  it('keeps the work but not a malformed ownership claim', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 8,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [{ ...measurement('m1'), owner: { frame: 'somewhere' } }],
      annotations: [{ ...annotation('a1'), owner: 42 }],
    };
    const back = parseSession(JSON.stringify(doc));
    expect(back.measurements).toHaveLength(1);
    expect(back.measurements[0].owner).toBeUndefined();
    expect(back.annotations).toHaveLength(1);
    expect(back.annotations[0].owner).toBeUndefined();
  });

  it('omits the owner from the JSON when the work carries none (byte shape preserved)', () => {
    const json = serializeSession(session({ measurements: [measurement('m1')] }));
    expect(json).not.toContain('owner');
  });
});

describe('session v8: reordering and removal do not move saved work', () => {
  const owned = session({
    projectFrame: FRAME,
    measurements: [
      measurement('m1', sourceLocalOwnership('layer_a')),
      measurement('m2', sourceLocalOwnership('layer_b')),
    ],
    annotations: [annotation('a1', sourceLocalOwnership('layer_b'))],
  });

  /** Where each measurement vertex actually is, resolved through its owner. */
  const worldOf = (s: InspectionSession, frame: SessionProjectFrame): Array<Vec3 | null> =>
    s.measurements.map((m) => resolveWorldPoint(m.points[0], m.owner, frame));

  it('reordering the layers moves nothing', () => {
    const back = parseSession(serializeSession(owned));
    const before = worldOf(back, back.projectFrame!);
    const reordered = withFrameLayerOrder(back.projectFrame!, ['layer_b', 'layer_a']);
    expect(worldOf(back, reordered)).toEqual(before);
    expect(
      resolveWorldPoint(
        [back.annotations[0].localPosition.x, back.annotations[0].localPosition.y, back.annotations[0].localPosition.z],
        back.annotations[0].owner,
        reordered,
      ),
    ).toEqual(
      resolveWorldPoint(
        [back.annotations[0].localPosition.x, back.annotations[0].localPosition.y, back.annotations[0].localPosition.z],
        back.annotations[0].owner,
        back.projectFrame!,
      ),
    );
  });

  it('removing a layer moves nothing that survives it', () => {
    const back = parseSession(serializeSession(owned));
    const before = worldOf(back, back.projectFrame!);
    const smaller = withoutFrameLayer(back.projectFrame!, 'layer_b');
    const after = worldOf(back, smaller);
    // layer_a's work is exactly where it was…
    expect(after[0]).toEqual(before[0]);
    // …and the departed layer's work resolves to nothing rather than being
    // silently re-homed onto a surviving layer.
    expect(after[1]).toBeNull();
    expect(smaller.projectOrigin).toEqual(back.projectFrame!.projectOrigin);
  });

  it('removing the ANCHOR layer does not move the project origin', () => {
    // The case a recomputed origin would break: the layer that sits on the
    // project origin goes away, and project-frame work has to stay put. A
    // frame that re-derived its origin from whatever is left would move every
    // one of those coordinates without a single visible symptom.
    const withProjectWork = session({
      projectFrame: FRAME,
      measurements: [
        measurement('m2', sourceLocalOwnership('layer_b')),
        measurement('m3', projectFrameOwnership()),
      ],
    });
    const back = parseSession(serializeSession(withProjectWork));
    const before = worldOf(back, back.projectFrame!);
    const smaller = withoutFrameLayer(back.projectFrame!, 'layer_a');
    expect(smaller.projectOrigin).toEqual(FRAME.projectOrigin);
    expect(worldOf(back, smaller)).toEqual(before);
  });

  it('a removal and re-import round trip leaves the survivor byte-identical', () => {
    const back = parseSession(serializeSession(owned));
    const smaller = withoutFrameLayer(back.projectFrame!, 'layer_b');
    const rewritten = parseSession(
      serializeSession({
        ...session({ projectFrame: smaller }),
        measurements: [back.measurements[0]],
      }),
    );
    expect(rewritten.projectFrame!.layers[0]).toEqual(FRAME.layers[0]);
    expect(rewritten.measurements[0].points).toEqual(back.measurements[0].points);
    expect(rewritten.measurements[0].owner).toEqual({ layerId: 'layer_a', frame: 'source-local' });
  });
});

describe('legacy sessions: imported intact, assignment marked inferred', () => {
  const v7 = {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: 7,
    upAxis: 'z',
    origin: [516_000, 4_644_000, 70],
    unitSystem: 'metric',
    views: [{ name: 'north', camera: { position: [1, 2, 3], target: [0, 0, 0] } }],
    measurements: [measurement('m1'), measurement('m2')],
    annotations: [annotation('a1')],
    layerId: 'layer_a',
    layerName: 'scan.laz',
    scanSummary: {
      fileName: 'scan.laz',
      sourcePoints: 1_000_000,
      width: 120,
      depth: 80,
      height: 12,
      crs: 'ETRS89 / UTM zone 30N',
      epsg: 25830,
    },
  };

  it('a v7 file imports with everything intact', () => {
    const back = parseSession(JSON.stringify(v7));
    expect(back.measurements).toHaveLength(2);
    expect(back.annotations).toHaveLength(1);
    expect(back.views).toHaveLength(1);
    expect(back.origin).toEqual([516_000, 4_644_000, 70]);
    expect(back.layerId).toBe('layer_a');
    expect(back.scanSummary!.sourcePoints).toBe(1_000_000);
    expect(back.projectFrame).toBeUndefined();
    // Nothing in the file claimed an owner, so nothing is asserted on read.
    expect(back.measurements[0].owner).toBeUndefined();
  });

  it('migration assigns the anchor layer and marks every assignment inferred', () => {
    const back = parseSession(JSON.stringify(v7));
    const migrated = migrateSessionOwnership(back);
    expect(migrated.anchorLayerId).toBe('layer_a');
    for (const m of migrated.measurements) {
      expect(m.owner).toEqual({ layerId: 'layer_a', frame: 'source-local', inferred: true });
    }
    expect(migrated.annotations[0].owner).toEqual({
      layerId: 'layer_a',
      frame: 'source-local',
      inferred: true,
    });
    expect(migrated.inferredMeasurementIds).toEqual(['m1', 'm2']);
    expect(migrated.inferredAnnotationIds).toEqual(['a1']);
    expect(migrated.unattributed).toBe(0);
  });

  it('migration never moves the geometry it attributes', () => {
    const back = parseSession(JSON.stringify(v7));
    const migrated = migrateSessionOwnership(back);
    expect(migrated.measurements[0].points).toEqual(back.measurements[0].points);
    expect(migrated.annotations[0].localPosition).toEqual(back.annotations[0].localPosition);
  });

  it('an inferred assignment is never presented as an asserted one', () => {
    const migrated = migrateSessionOwnership(parseSession(JSON.stringify(v7)));
    const rewritten = parseSession(
      serializeSession(session({ measurements: migrated.measurements })),
    );
    expect(rewritten.measurements[0].owner!.inferred).toBe(true);
  });

  it('takes the anchor from the loaded layer when the caller knows it', () => {
    const back = parseSession(JSON.stringify({ ...v7, layerId: undefined }));
    expect(resolveSessionAnchorLayerId(back)).toBeNull();
    const migrated = migrateSessionOwnership(back, { loadedLayerId: 'layer_reopened' });
    expect(migrated.anchorLayerId).toBe('layer_reopened');
    expect(migrated.measurements[0].owner!.layerId).toBe('layer_reopened');
    expect(migrated.measurements[0].owner!.inferred).toBe(true);
  });

  it('leaves work unattributed rather than inventing an owner', () => {
    const back = parseSession(JSON.stringify({ ...v7, layerId: undefined }));
    const migrated = migrateSessionOwnership(back);
    expect(migrated.anchorLayerId).toBeNull();
    expect(migrated.measurements[0].owner).toBeUndefined();
    expect(migrated.unattributed).toBe(3);
  });

  it('leaves an already-owned measurement exactly as the author declared it', () => {
    const back = parseSession(
      serializeSession(
        session({
          projectFrame: FRAME,
          measurements: [measurement('m1', sourceLocalOwnership('layer_b')), measurement('m2')],
        }),
      ),
    );
    const migrated = migrateSessionOwnership(back, { loadedLayerId: 'layer_a' });
    expect(migrated.measurements[0].owner).toEqual({ layerId: 'layer_b', frame: 'source-local' });
    expect(migrated.measurements[1].owner).toEqual({
      layerId: 'layer_a',
      frame: 'source-local',
      inferred: true,
    });
    expect(migrated.inferredMeasurementIds).toEqual(['m2']);
  });

  it('prefers the frame anchor over the session-wide layer id', () => {
    const back = parseSession(
      serializeSession(session({ projectFrame: FRAME, layerId: 'layer_b' })),
    );
    expect(resolveSessionAnchorLayerId(back)).toBe('layer_a');
  });
});
