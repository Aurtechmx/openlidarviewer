/**
 * tests/layerIdentityService.test.ts
 *
 * The app service that finally gives the identity/ownership model a caller. It
 * binds a loaded cloud to a stable, name-independent id from its SOURCE facts,
 * and decides the owner stamped on new work. The properties under test are the
 * ones that keep the feature safe rather than merely present:
 *
 *   • identity keys on source facts, so the SAME file at two load strides gets
 *     the SAME id (a phone's budget must not fork a scan's identity);
 *   • two genuinely different scans dropped under one filename get DISTINCT ids;
 *   • a fingerprint that distinguishes nothing but a filename is refused a
 *     binding, and its active layer yields NO owner — fail closed, never a guess;
 *   • a single-layer scene stamps NO owner, so the byte-identical round trip the
 *     v8 schema guarantees is preserved; a second layer is what turns ownership
 *     on.
 *
 * Pure Node — no DOM, no viewer. The source-fact adapter it is fed in production
 * (`scanFactsFromStatic`) is exercised here too, so the "same file, two strides"
 * guarantee is proven end-to-end rather than assumed.
 */

import { describe, it, expect } from 'vitest';
import { createLayerIdentityService } from '../src/app/layerIdentityService';
import { scanFactsFromStatic, type StaticScanCloud } from '../src/app/sessionIo';
import type { LayerFingerprint } from '../src/model/layerIdentity';

/** A deterministic id generator so a test never depends on WebCrypto. */
function counter(): () => string {
  let n = 0;
  return () => `layer_test_${n++}`;
}

const FACTS_A: LayerFingerprint = {
  fileName: 'survey.laz',
  sourcePoints: 1_000_000,
  width: 120,
  depth: 80,
  height: 12,
  epsg: 25830,
};

// Same display filename, genuinely different scan — the collision case identity
// must resolve on content, never on the shared name.
const FACTS_B_SAME_NAME: LayerFingerprint = {
  fileName: 'survey.laz',
  sourcePoints: 250_000,
  width: 60,
  depth: 40,
  height: 9,
  epsg: 25830,
};

/** A static cloud whose declared source count is fixed but whose DISPLAY count varies with the device stride. */
function cloudAtStride(displayPointCount: number): StaticScanCloud {
  return {
    name: 'survey.laz',
    pointCount: displayPointCount,
    declaredPointCount: 1_000_000,
    bounds: () => ({ min: [10, 20, 30], max: [130, 100, 42] }),
    sourceFormat: 'laz',
    metadata: { crs: { name: 'ETRS89 / UTM zone 30N', epsg: 25830 } },
  };
}

describe('LayerIdentityService — binding a loaded cloud to a stable id', () => {
  it('binds distinguishing source facts and hands back a name-independent id', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    const rec = svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    expect(rec).not.toBeNull();
    expect(rec!.layerId).toBe('layer_test_0');
    expect(rec!.layerId.toLowerCase()).not.toContain('survey');
    expect(svc.stableIdFor('cloud_0')).toBe('layer_test_0');
  });

  it('gives the SAME id to the same file loaded at two different strides', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    // Desktop: full budget. Mobile: tight budget, far fewer display points.
    const desktop = svc.bindOnLoad('cloud_0', scanFactsFromStatic(cloudAtStride(1_000_000)), 'survey.laz');
    const mobile = svc.bindOnLoad('cloud_1', scanFactsFromStatic(cloudAtStride(120_000)), 'survey.laz');
    expect(desktop!.layerId).toBe(mobile!.layerId);
  });

  it('gives two genuinely different scans under one filename DISTINCT ids', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    const a = svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    const b = svc.bindOnLoad('cloud_1', FACTS_B_SAME_NAME, 'survey.laz');
    expect(a!.layerId).not.toBe(b!.layerId);
  });

  it('reuses the remembered id when the same scan is reopened under a fresh viewer id', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    const first = svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    // A reopen mints a new viewer id; identity comes back through the fingerprint.
    const reopened = svc.bindOnLoad('cloud_7', { ...FACTS_A }, 'renamed after reopen.laz');
    expect(reopened!.layerId).toBe(first!.layerId);
    expect(svc.stableIdFor('cloud_7')).toBe(first!.layerId);
  });
});

describe('LayerIdentityService — fail closed on a filename-only fingerprint', () => {
  const nameOnly: LayerFingerprint = { fileName: 'scan.laz' };

  it('refuses to bind a fingerprint that distinguishes nothing but a name', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    expect(svc.bindOnLoad('cloud_0', nameOnly, 'scan.laz')).toBeNull();
    expect(svc.stableIdFor('cloud_0')).toBeNull();
  });

  it('gives an unbindable active layer no owner, even with two layers open', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    svc.bindOnLoad('cloud_1', nameOnly, 'scan.laz'); // refused — no binding
    // cloud_1 is active and there are two layers, but it carries no proven
    // identity, so its work is left unowned rather than attributed by a guess.
    expect(svc.ownerForNewWork('cloud_1', 2)).toBeUndefined();
  });
});

describe('LayerIdentityService — the owner stamped on new work', () => {
  it('stamps no owner while a single layer is open (byte shape preserved)', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    expect(svc.ownerForNewWork('cloud_0', 1)).toBeUndefined();
    // Zero layers, or no active layer, likewise carry nothing.
    expect(svc.ownerForNewWork('cloud_0', 0)).toBeUndefined();
    expect(svc.ownerForNewWork(null, 2)).toBeUndefined();
  });

  it('stamps the active layer, by stable id in its source-local frame, once a second layer joins', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    svc.bindOnLoad('cloud_1', FACTS_B_SAME_NAME, 'survey.laz');
    expect(svc.ownerForNewWork('cloud_0', 2)).toEqual({
      layerId: 'layer_test_0',
      frame: 'source-local',
    });
    // Switching the active layer switches whom new work is attributed to.
    expect(svc.ownerForNewWork('cloud_1', 2)).toEqual({
      layerId: 'layer_test_1',
      frame: 'source-local',
    });
  });
});

describe('LayerIdentityService — wiring the work stores', () => {
  it('installs a live provider once and never rewires it', () => {
    const svc = createLayerIdentityService({ generateId: counter() });
    svc.bindOnLoad('cloud_0', FACTS_A, 'survey.laz');
    svc.bindOnLoad('cloud_1', FACTS_B_SAME_NAME, 'survey.laz');

    let active: string | null = 'cloud_0';
    let count = 1;
    const providers: Array<() => unknown> = [];
    const store = { setOwnerProvider: (p: () => unknown) => providers.push(p) };

    svc.ensureStoresWired([store], () => active, () => count);
    svc.ensureStoresWired([store], () => active, () => count); // second call is a no-op
    expect(providers).toHaveLength(1);

    const provider = providers[0];
    // Single layer → no owner.
    expect(provider()).toBeUndefined();
    // A second layer joins and the provider follows the live state with no rewire.
    count = 2;
    expect(provider()).toEqual({ layerId: 'layer_test_0', frame: 'source-local' });
    active = 'cloud_1';
    expect(provider()).toEqual({ layerId: 'layer_test_1', frame: 'source-local' });
  });
});
