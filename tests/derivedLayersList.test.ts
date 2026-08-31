/**
 * derivedLayersList.test.ts — the Layers-panel section that lists derived
 * products, over the recording DOM shim the other panel tests use.
 *
 * The property under test: the list is a pure view of the shared
 * `DerivedLayerStore`. It renders a row per layer, re-renders on every store
 * change (so it can never drift from what is drawn), routes a control back
 * through the injected handler rather than writing the store itself, and stops
 * observing on dispose.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { DerivedLayerStore, type DerivedLayer } from '../src/model/DerivedLayer';
import { createDerivedLayersList } from '../src/ui/DerivedLayersList';

beforeEach(() => installFakeDom());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (root: any, sel: string): any => root.querySelector(sel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qa = (root: any, sel: string): any[] => root.querySelectorAll(sel);

describe('createDerivedLayersList', () => {
  it('is hidden with no rows until a layer exists', () => {
    const store = new DerivedLayerStore();
    const { element } = createDerivedLayersList({
      store,
      onSetVisible: () => {},
      onSetOpacity: () => {},
    });
    expect(element.classList.contains('olv-hidden')).toBe(true);
    expect(qa(element, '.olv-analyse-layer-row')).toHaveLength(0);
  });

  it('renders a row per layer and re-renders when the store changes', () => {
    const store = new DerivedLayerStore();
    const { element } = createDerivedLayersList({
      store,
      onSetVisible: () => {},
      onSetOpacity: () => {},
    });
    store.put({ id: 'contours:a', type: 'contours', name: 'Contours', sourceScanIds: ['a'] });
    expect(element.classList.contains('olv-hidden')).toBe(false);
    expect(qa(element, '.olv-analyse-layer-row')).toHaveLength(1);
    expect(q(element, '.olv-analyse-layer-head').textContent).toBe('Derived layers');

    // A second product joins — the list follows the store's notification.
    store.put({ id: 'cond:a', type: 'conductor-lines', name: 'Conductors', sourceScanIds: ['a'] });
    expect(qa(element, '.olv-analyse-layer-row')).toHaveLength(2);
  });

  it('marks an exploratory layer in its type tag', () => {
    const store = new DerivedLayerStore();
    const { element } = createDerivedLayersList({
      store,
      onSetVisible: () => {},
      onSetOpacity: () => {},
    });
    store.put({
      id: 'ch',
      type: 'change-raster',
      name: 'Change',
      sourceScanIds: ['a', 'b'],
      evidenceExploratory: true,
    });
    const tags = qa(element, '.olv-analyse-layer-tag').map((t) => t.textContent);
    expect(tags).toContain('Change · exploratory');
  });

  it('routes a visibility toggle back through the handler, not the store', () => {
    const store = new DerivedLayerStore();
    const calls: { layer: DerivedLayer; visible: boolean }[] = [];
    const { element } = createDerivedLayersList({
      store,
      onSetVisible: (layer, visible) => calls.push({ layer, visible }),
      onSetOpacity: () => {},
    });
    store.put({ id: 'contours:a', type: 'contours', name: 'Contours', sourceScanIds: ['a'] });
    const cb = q(element, 'input');
    cb.checked = false;
    cb.dispatchEvent({ type: 'change' });
    expect(calls).toHaveLength(1);
    expect(calls[0].visible).toBe(false);
    expect(calls[0].layer.id).toBe('contours:a');
    // The list itself did not write the store — the record is still visible
    // until the service applies the change and notifies.
    expect(store.get('contours:a')!.visible).toBe(true);
  });

  it('routes an opacity change through the handler', () => {
    const store = new DerivedLayerStore();
    const calls: number[] = [];
    const { element } = createDerivedLayersList({
      store,
      onSetVisible: () => {},
      onSetOpacity: (_layer, opacity) => calls.push(opacity),
    });
    store.put({ id: 'contours:a', type: 'contours', name: 'Contours', sourceScanIds: ['a'] });
    const range = qa(element, 'input').find((i) => i.type === 'range');
    range.value = '40';
    range.dispatchEvent({ type: 'input' });
    expect(calls).toEqual([0.4]);
  });

  it('stops re-rendering after dispose', () => {
    const store = new DerivedLayerStore();
    const { element, dispose } = createDerivedLayersList({
      store,
      onSetVisible: () => {},
      onSetOpacity: () => {},
    });
    store.put({ id: 'contours:a', type: 'contours', name: 'Contours', sourceScanIds: ['a'] });
    expect(qa(element, '.olv-analyse-layer-row')).toHaveLength(1);
    dispose();
    store.put({ id: 'cond:a', type: 'conductor-lines', name: 'Conductors', sourceScanIds: ['a'] });
    // No new row: the list is no longer observing.
    expect(qa(element, '.olv-analyse-layer-row')).toHaveLength(1);
  });
});
