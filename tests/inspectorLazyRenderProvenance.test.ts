/**
 * inspectorLazyRenderProvenance.test.ts
 *
 * `Inspector.setProvenance()` renders the Provenance fingerprint through a
 * lazy `renderProvenance` chunk (`ui/inspector/renderProvenance.ts`). Same
 * shape as `inspectorLazyRenderCrs.test.ts` / the `_ensureGroups()`
 * precedent: placeholder first, in-flight dedupe, retry-on-failure,
 * latest-wins.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector } from '../src/ui/Inspector';
import { FakeEl, byClass, findContaining } from './support/measurePanelDom';
import { installInspectorFakeDom, fakeCallbacks, tick } from './helpers/inspectorLazyHarness';
import type { ProvenanceFingerprint } from '../src/diagnostics/provenance';

const state = vi.hoisted(() => ({
  calls: 0,
  pending: [] as Array<{
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>,
}));

vi.mock('../src/lazyChunks', () => ({
  loadLayerHealthCard: vi.fn(),
  loadLayerGroupsPanel: vi.fn(),
  loadRenderCrs: vi.fn(),
  loadRenderReport: vi.fn(),
  loadRenderProvenance: vi.fn(() => {
    state.calls++;
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject });
    });
  }),
}));

beforeAll(() => {
  installInspectorFakeDom();
});

function makeFingerprint(overrides: Partial<ProvenanceFingerprint> = {}): ProvenanceFingerprint {
  return {
    captureType: 'aerial-als',
    confidence: 'high',
    label: 'Aerial / airborne ALS',
    signals: ['Wide swath', 'Regular scan pattern'],
    bounds: [],
    disclaimer: 'These are expected values from the cited literature, not guarantees.',
    ...overrides,
  };
}

async function resolveNextImport(): Promise<void> {
  const mod = await import('../src/ui/inspector/renderProvenance');
  const p = state.pending.pop();
  p?.resolve(mod);
  await tick();
}

describe('Inspector.setProvenance — lazy renderProvenance chunk', () => {
  it('shows a loading placeholder synchronously, then the real content once the chunk resolves', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const body = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-provenance',
    )!;

    inspector.setProvenance(makeFingerprint());
    expect(findContaining(body, 'Loading provenance')).toBeTruthy();
    expect(state.calls).toBe(1);

    await resolveNextImport();

    expect(findContaining(body, 'Aerial / airborne ALS')).toBeTruthy();
  });

  it('dedupes a second setProvenance() call before the chunk resolves, and the latest data wins', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const body = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-provenance',
    )!;

    inspector.setProvenance(makeFingerprint({ label: 'First label' }));
    inspector.setProvenance(makeFingerprint({ label: 'Second label' }));
    expect(state.calls).toBe(1);

    await resolveNextImport();

    expect(findContaining(body, 'Second label')).toBeTruthy();
    expect(findContaining(body, 'First label')).toBeUndefined();
  });

  it('shows a retry caption on a failed chunk load, and a retry re-attempts the import', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const body = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-provenance',
    )!;

    inspector.setProvenance(makeFingerprint());
    const failing = state.pending.pop();
    failing?.reject(new Error('network error'));
    await tick();

    expect(findContaining(body, 'Could not load provenance')).toBeTruthy();
    const retry = byClass(body, 'olv-inline-retry');
    expect(retry).toBeTruthy();

    retry!.click();
    expect(state.calls).toBe(2);

    await resolveNextImport();
    expect(findContaining(body, 'Aerial / airborne ALS')).toBeTruthy();
  });
});
