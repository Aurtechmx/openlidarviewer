/**
 * tests/layerIdentityWorkStamping.test.ts
 *
 * The creation-path half of the wiring: a new measurement or annotation records
 * WHICH layer it belongs to, by stable id, in that layer's source-local frame —
 * and records NOTHING while a single layer is open, so the session it serialises
 * into keeps its exact pre-identity byte shape.
 *
 * These drive the REAL controllers (through the same DOM stub the other
 * controller tests use — the project keeps its unit tests DOM-free for speed),
 * because the guarantee is about the object the controller actually pushes onto
 * its store, not about a pure helper in isolation. The owner VALUE and its
 * gating are proven exhaustively in `layerIdentityService.test.ts`; here the
 * provider is a plain stub, so what is under test is that the controllers
 * consult it at creation and that an unowned result leaves the record untouched.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { serializeSession, parseSession } from '../src/io/session';
import { sourceLocalOwnership, type WorkOwnership } from '../src/model/workOwnership';
import type { VolumeRecord, Vec3 } from '../src/render/measure/types';

import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true, textarea: true });
});

const OWNER: WorkOwnership = sourceLocalOwnership('layer_test_active');

/** A minimal, schema-valid cut/fill record — enough to make a Volume measurement. */
function volumeRecord(): VolumeRecord {
  return {
    fill: 10,
    cut: 4,
    net: 6,
    referenceZ: 1,
    footprintArea: 20,
    pointsInPolygon: 100,
    densityNative: 5,
    confidence: 'high',
  };
}

const TRIANGLE: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [1, 2, 0],
];

async function makeMeasure() {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  return new MeasureController({
    onExit: () => {},
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
}

async function makeAnnotate() {
  const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
  return new AnnotationController();
}

describe('a new measurement records the active layer, by stable id', () => {
  it('stamps the provider-supplied owner onto a created measurement', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => OWNER);
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toEqual({ layerId: 'layer_test_active', frame: 'source-local' });
  });

  it('leaves the measurement unowned when the provider returns nothing (single-layer)', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => undefined);
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toBeUndefined();
  });

  it('leaves the measurement unowned when no provider is wired at all', async () => {
    const measure = await makeMeasure();
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toBeUndefined();
  });
});

describe('a new annotation records the active layer, by stable id', () => {
  it('stamps the provider-supplied owner onto a created annotation', async () => {
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => OWNER);
    const a = annotate.add({ title: 'crack', type: 'issue', localPosition: { x: 1, y: 2, z: 3 } });
    expect(a.owner).toEqual({ layerId: 'layer_test_active', frame: 'source-local' });
  });

  it('leaves the annotation unowned when the provider returns nothing (single-layer)', async () => {
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => undefined);
    const a = annotate.add({ title: 'crack', type: 'issue', localPosition: { x: 1, y: 2, z: 3 } });
    expect(a.owner).toBeUndefined();
  });
});

describe('single-layer work still round-trips byte-identically', () => {
  it('a session of unowned, controller-created work carries no ownership surface', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => undefined); // single-layer: the provider withholds an owner
    measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => undefined);
    annotate.add({ title: 'note', type: 'note', localPosition: { x: 4, y: 5, z: 6 } });

    const session = {
      upAxis: 'z' as const,
      origin: [100, 200, 300] as Vec3,
      unitSystem: 'metric' as const,
      views: [],
      measurements: measure.getMeasurements(),
      annotations: annotate.getAnnotations(),
    };
    const json = serializeSession(session);
    // The pre-identity byte shape has no ownership / project-frame / layer-id noise.
    expect(json).not.toContain('"owner"');
    expect(json).not.toContain('projectFrame');
    expect(json).not.toContain('"layerId"');
    // And the file is stable across a reload — parse → re-serialise is identical.
    expect(serializeSession({ ...session, measurements: parseSession(json).measurements, annotations: parseSession(json).annotations })).toBe(json);
  });
});
