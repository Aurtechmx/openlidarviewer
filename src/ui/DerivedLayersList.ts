/**
 * DerivedLayersList.ts — the Layers-panel section that lists analytical layers.
 *
 * A derived product (contours today; conductors, surfaces and change rasters as
 * each is routed through the store) is a first-class scene layer: named,
 * provenance-carrying, and shown or faded like a scan. This is the generic list
 * that makes them manageable in one place, reading the shared
 * {@link DerivedLayerStore} and re-rendering whenever it changes.
 *
 * It owns no product lifecycle. The store holds the display STATE, but each
 * product's own service is what mirrors that state onto the geometry it draws,
 * so a control here calls back through `onSetVisible` / `onSetOpacity` — the
 * caller routes those to the right service, which updates the store and the
 * scene together. The list then re-renders from the store's notification, so
 * what it shows can never drift from what is drawn. Pure DOM, no three.js.
 */

import { el } from './dom';
import type { DerivedLayer, DerivedLayerStore, DerivedLayerType } from '../model/DerivedLayer';

/** Human label for a layer type, so a row reads as a product not an enum. */
const TYPE_LABEL: Record<DerivedLayerType, string> = {
  'dtm-mesh': 'Terrain (DTM)',
  'dsm-mesh': 'Surface (DSM)',
  contours: 'Contours',
  slope: 'Slope',
  hillshade: 'Hillshade',
  'change-raster': 'Change',
  'building-polygons': 'Buildings',
  'conductor-lines': 'Conductors',
};

export interface DerivedLayersListDeps {
  readonly store: DerivedLayerStore;
  /**
   * Show or hide a layer. Routed by the caller to the product's own service so
   * the geometry follows; returns the applied visibility, or undefined when the
   * layer is gone. The control re-reads the store on the resulting notification.
   */
  readonly onSetVisible: (layer: DerivedLayer, visible: boolean) => void;
  /** Set a layer's opacity (0..1), routed the same way as {@link onSetVisible}. */
  readonly onSetOpacity: (layer: DerivedLayer, opacity: number) => void;
}

export interface DerivedLayersList {
  /** The section element to mount into the Layers panel. */
  readonly element: HTMLElement;
  /** Stop observing the store. */
  dispose(): void;
}

/** One layer's row: name, type, honesty chip, Show toggle, opacity. */
function renderRow(layer: DerivedLayer, deps: DerivedLayersListDeps): HTMLElement {
  const row = el('div', { className: 'olv-analyse-layer-row' });

  const label = el('label', { className: 'olv-analyse-layer-toggle' });
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = layer.visible;
  cb.setAttribute('aria-label', `Show ${layer.name} in the 3D scene`);
  cb.addEventListener('change', () => {
    // The service, not the checkbox, decides; the store notification re-renders
    // the row to the applied state, so no optimistic write is kept here.
    deps.onSetVisible(layer, cb.checked);
  });
  label.append(cb, el('span', { text: layer.name }));

  const meta = el('span', {
    className: 'olv-analyse-layer-tag',
    text: layer.evidenceExploratory ? `${TYPE_LABEL[layer.type]} · exploratory` : TYPE_LABEL[layer.type],
  });

  const opRow = el('label', { className: 'olv-analyse-layer-slider' });
  const opVal = el('span', {
    className: 'olv-analyse-layer-val',
    text: `${Math.round(layer.opacity * 100)}%`,
  });
  const opInput = document.createElement('input');
  opInput.type = 'range';
  opInput.min = '0';
  opInput.max = '100';
  opInput.step = '5';
  opInput.value = String(Math.round(layer.opacity * 100));
  opInput.setAttribute('aria-label', `${layer.name} opacity`);
  opInput.addEventListener('input', () => {
    deps.onSetOpacity(layer, Number(opInput.value) / 100);
  });
  opRow.append(el('span', { className: 'olv-analyse-layer-tag', text: 'Opacity' }), opInput, opVal);

  row.append(label, meta, opRow);
  return row;
}

export function createDerivedLayersList(deps: DerivedLayersListDeps): DerivedLayersList {
  const element = el('div', { className: 'olv-analyse-layer-controls' });

  const render = (): void => {
    element.replaceChildren();
    const layers = deps.store.list();
    if (layers.length === 0) {
      // Empty until the first analysis produces a layer; hidden so the panel
      // shows no empty header.
      element.classList.add('olv-hidden');
      return;
    }
    element.classList.remove('olv-hidden');
    element.append(el('div', { className: 'olv-analyse-layer-head', text: 'Derived layers' }));
    for (const layer of layers) element.append(renderRow(layer, deps));
  };

  render();
  const unsubscribe = deps.store.subscribe(render);

  return {
    element,
    dispose(): void {
      unsubscribe();
    },
  };
}
