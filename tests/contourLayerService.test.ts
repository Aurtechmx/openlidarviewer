/**
 * contourLayerService.test.ts
 *
 * The contours derived-layer lifecycle. The two invariants under test are the
 * reason the service exists at all:
 *
 *  - a RE-ANALYSIS replaces the drawn geometry and bumps the record's
 *    generation — it never leaves the old overlay stacked behind the new one;
 *  - a CLOSED scan takes its derived layers with it, and closing a BACKGROUND
 *    scan never blanks the contours of the one on screen.
 *
 * The overlay is faked, so this stays pure orchestration with no three.js.
 */

import { describe, it, expect } from 'vitest';
import {
  createContourLayerService,
  contourLayerId,
  type ContourLayerInput,
} from '../src/app/contourLayerService';
import { DerivedLayerStore } from '../src/model/DerivedLayer';
import type { ContourOverlay } from '../src/render/ContourOverlay';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

const MODEL = { features: [] } as unknown as ContourFeatureModel;

/** Records every call the service makes onto the overlay. */
function fakeOverlay() {
  const calls: string[] = [];
  const state = {
    models: 0,
    visible: null as boolean | null,
    opacity: null as number | null,
    heightOffset: null as number | null,
    indexEmphasis: null as boolean | null,
    disposed: 0,
  };
  const overlay = {
    setModel: () => { state.models++; calls.push('setModel'); },
    setVisible: (v: boolean) => { state.visible = v; calls.push('setVisible'); },
    setOpacity: (o: number) => { state.opacity = o; calls.push('setOpacity'); },
    setHeightOffset: (h: number) => { state.heightOffset = h; calls.push('setHeightOffset'); },
    setIndexEmphasis: (b: boolean) => { state.indexEmphasis = b; calls.push('setIndexEmphasis'); },
    dispose: () => { state.disposed++; calls.push('dispose'); },
  } as unknown as ContourOverlay;
  return { overlay, state, calls };
}

function setup() {
  const made: ReturnType<typeof fakeOverlay>[] = [];
  const store = new DerivedLayerStore();
  const service = createContourLayerService({
    host: { add: () => {}, remove: () => {} },
    store,
    makeOverlay: () => {
      const f = fakeOverlay();
      made.push(f);
      return f.overlay;
    },
  });
  return { service, store, made };
}

const input = (over: Partial<ContourLayerInput> = {}): ContourLayerInput => ({
  scanId: 'scan-a',
  model: MODEL,
  format: 'las',
  renderOrigin: [1, 2, 3],
  ...over,
});

describe('createContourLayerService — show', () => {
  it('registers a contours layer owned by its source scan and draws it', () => {
    const { service, store } = setup();
    const layer = service.show(input());
    expect(layer.type).toBe('contours');
    expect(layer.id).toBe(contourLayerId('scan-a'));
    expect(layer.sourceScanIds).toEqual(['scan-a']);
    expect(layer.generation).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('carries the analysis honesty facts onto the record', () => {
    const { service } = setup();
    const layer = service.show(
      input({ coverage: 'resident-only', evidenceExploratory: true, provenanceDigest: 'abc123' }),
    );
    expect(layer.coverage).toBe('resident-only');
    expect(layer.evidenceExploratory).toBe(true);
    expect(layer.provenanceDigest).toBe('abc123');
  });

  it('re-analysis REGENERATES: one layer, generation bumped, one overlay reused', () => {
    const { service, store, made } = setup();
    service.show(input());
    const again = service.show(input());
    expect(again.generation).toBe(2);
    expect(store.list()).toHaveLength(1);
    // One overlay across both analyses — a second would be the stale-overlay bug.
    expect(made).toHaveLength(1);
    expect(made[0].state.models).toBe(2);
  });

  it('a regeneration PRESERVES the display state the user chose, and re-paints it', () => {
    // Regression: `store.put` replaces the record, so without carrying the
    // previous display state a background re-analysis would snap a hidden or
    // faded layer back to fully visible — undoing the user's choice silently.
    const { service, made } = setup();
    service.show(input());
    service.setVisible('scan-a', false);
    service.setOpacity('scan-a', 0.3);
    service.setHeightOffset('scan-a', 0.25);
    service.setIndexEmphasis('scan-a', false);

    const regenerated = service.show(input());

    // The record kept every choice...
    expect(regenerated.visible).toBe(false);
    expect(regenerated.opacity).toBeCloseTo(0.3, 6);
    expect(regenerated.style.heightOffset).toBe(0.25);
    expect(regenerated.style.indexEmphasis).toBe(false);
    // ...and the freshly built geometry was painted with all of it.
    expect(made[0].state.visible).toBe(false);
    expect(made[0].state.opacity).toBeCloseTo(0.3, 6);
    expect(made[0].state.heightOffset).toBe(0.25);
    expect(made[0].state.indexEmphasis).toBe(false);
  });
});

describe('createContourLayerService — display controls', () => {
  it('visibility and opacity update both the record and the drawn overlay', () => {
    const { service, made } = setup();
    service.show(input());
    expect(service.setVisible('scan-a', false)?.visible).toBe(false);
    expect(service.setOpacity('scan-a', 0.5)?.opacity).toBeCloseTo(0.5, 6);
    expect(made[0].state.visible).toBe(false);
    expect(made[0].state.opacity).toBeCloseTo(0.5, 6);
  });

  it('height offset and index emphasis are recorded as style and painted', () => {
    const { service, made } = setup();
    service.show(input());
    expect(service.setHeightOffset('scan-a', 0.25)?.style.heightOffset).toBe(0.25);
    expect(service.setIndexEmphasis('scan-a', false)?.style.indexEmphasis).toBe(false);
    expect(made[0].state.heightOffset).toBe(0.25);
    expect(made[0].state.indexEmphasis).toBe(false);
  });

  it('a control for an unknown scan is a no-op, not a throw', () => {
    const { service, made } = setup();
    service.show(input());
    expect(service.setVisible('scan-zzz', false)).toBeUndefined();
    // The on-screen overlay is untouched by a control for another scan.
    expect(made[0].state.visible).toBe(true);
  });

  it('controls for a BACKGROUND scan update its record without repainting the screen', () => {
    const { service, made } = setup();
    service.show(input({ scanId: 'scan-a' }));
    service.show(input({ scanId: 'scan-b' })); // scan-b is now drawn
    const drawnCalls = made[0].calls.length;
    const rec = service.setVisible('scan-a', false); // background scan
    expect(rec?.visible).toBe(false); // record updated
    expect(made[0].calls.length).toBe(drawnCalls); // nothing repainted
  });
});

describe('createContourLayerService — scan lifetime', () => {
  it('closing the scan drops its layers and stops drawing them', () => {
    const { service, store, made } = setup();
    service.show(input());
    service.clearForScan('scan-a');
    expect(store.list()).toHaveLength(0);
    expect(service.layerFor('scan-a')).toBeUndefined();
    expect(made[0].state.disposed).toBe(1);
  });

  it('closing a BACKGROUND scan never blanks the contours on screen', () => {
    const { service, store, made } = setup();
    service.show(input({ scanId: 'scan-a' }));
    service.show(input({ scanId: 'scan-b' })); // scan-b drawn
    service.clearForScan('scan-a'); // close the background scan
    expect(store.list().map((l) => l.id)).toEqual([contourLayerId('scan-b')]);
    expect(made[0].state.disposed).toBe(0); // still drawing scan-b
  });

  it('a scan re-shown after closing gets a FRESH overlay and generation 1', () => {
    const { service, made } = setup();
    service.show(input());
    service.clearForScan('scan-a');
    const layer = service.show(input());
    expect(layer.generation).toBe(1);
    expect(made).toHaveLength(2); // the disposed overlay is not reused
  });

  it('dispose releases the overlay and is idempotent', () => {
    const { service, made } = setup();
    service.show(input());
    service.dispose();
    expect(made[0].state.disposed).toBe(1);
    expect(() => service.dispose()).not.toThrow();
    expect(made[0].state.disposed).toBe(1);
  });

  it('builds no overlay at all until something is shown', () => {
    const { service, made } = setup();
    expect(made).toHaveLength(0);
    service.clearForScan('scan-a');
    service.dispose();
    expect(made).toHaveLength(0);
  });
});
