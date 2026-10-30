/**
 * tests/annotationOwnerFromPickedLayer.test.ts
 *
 * A note belongs to the scan it was placed on. With two scans open, a click on
 * scan A while scan B is the selected layer must record A as the owner, the
 * same way a measurement records the layer each point was picked on. A pick
 * that names no cloud (a streamed scan) keeps the active-layer owner, and a
 * single open scan still records no owner at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { annotationGeorefFor } from '../src/render/annotate/pickGeoref';
import { createLayerIdentityService } from '../src/app/layerIdentityService';
import type { LayerFingerprint } from '../src/model/layerIdentity';
import { installFakeDom, type FakeEl } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true, textarea: true, noResizeObserver: true });
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).querySelector = () => null;
  g.window = { innerWidth: 1280, innerHeight: 800 };
});

const FP_A: LayerFingerprint = { fileName: 'a.laz', sourcePoints: 1_000_000, width: 120, depth: 80, height: 12, epsg: 25830 };
const FP_B: LayerFingerprint = { fileName: 'b.laz', sourcePoints: 250_000, width: 60, depth: 40, height: 9, epsg: 25830 };

const cloudA = { name: 'a.laz', worldXYZ: (): [number, number, number] => [1, 2, 3] };
const cloudB = { name: 'b.laz', worldXYZ: (): [number, number, number] => [4, 5, 6] };

/** Two scans open, B selected, the controller wired the way openScan wires it. */
async function twoScans(open: Array<'A' | 'B'> = ['A', 'B']) {
  const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
  const c = new AnnotationController();
  await c.ensureEditor();
  let n = 0;
  const svc = createLayerIdentityService({ generateId: () => `layer_${n++}` });
  const viewerIds = open.map((_, i) => `cloud_${i}`);
  const objects = open.map((k) => (k === 'A' ? cloudA : cloudB));
  open.forEach((k, i) => svc.bindOnLoad(viewerIds[i]!, k === 'A' ? FP_A : FP_B, `${k.toLowerCase()}.laz`, viewerIds.slice(0, i)));
  const active = viewerIds[viewerIds.length - 1]!;
  svc.ensureStoresWired([c], () => active, () => viewerIds.length);
  c.setLayerResolver((obj) => (viewerIds.length > 1 ? svc.stableIdFor(viewerIds[objects.indexOf(obj as typeof cloudA)] ?? '') : null));
  const card = c.editorElement as unknown as FakeEl;
  const place = (cloud: typeof cloudA | null): void => {
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0, undefined, cloud ? annotationGeorefFor({ cloud, index: 0 }, null) : undefined);
    card.querySelectorAll('.olv-anno-editor-save')[0].click();
  };
  return { c, svc, place, ids: viewerIds.map((v) => svc.stableIdFor(v)!) };
}

describe('the owner of a new note', () => {
  it('is the scan the note was placed on, not the selected scan', async () => {
    const h = await twoScans();
    h.place(cloudA);
    const [note] = h.c.getAnnotations();
    expect(note!.owner).toEqual({ layerId: h.ids[0], frame: 'project' });
    expect(note!.layerId).toBe('a.laz');
  });

  it('is the selected scan when the pick names no cloud', async () => {
    const h = await twoScans();
    h.place(null);
    expect(h.c.getAnnotations()[0]!.owner?.layerId).toBe(h.ids[1]);
  });

  it('is not recorded while a single scan is open', async () => {
    const h = await twoScans(['A']);
    h.place(cloudA);
    expect(h.c.getAnnotations()[0]!.owner).toBeUndefined();
  });

  it('survives a session save and reopen', async () => {
    const { serializeSession, parseSession } = await import('../src/io/session');
    const h = await twoScans();
    h.place(cloudA);
    const reread = parseSession(serializeSession({
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [],
      annotations: h.c.getAnnotations().map((a) => ({ ...a })), software: 'test',
    }));
    expect(reread.annotations[0]!.owner).toEqual({ layerId: h.ids[0], frame: 'project' });
  });
});
