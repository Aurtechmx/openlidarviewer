/**
 * tests/helpers/inspectorLazyHarness.ts
 *
 * Shared DOM/callbacks/tick harness for the Inspector lazy-chunk suites:
 * `inspectorLazyRenderCrs`, `inspectorLazyRenderProvenance`,
 * `inspectorLazyRenderReport`, and `inspectorNewGroup`. Each of those tests
 * mounts a real `Inspector` against the same fake DOM and the same no-op
 * callback set, then drives a manually-resolved mock of `src/lazyChunks` to
 * reproduce the placeholder/dedupe/retry sequence around one lazily loaded
 * chunk. Only the mocked chunk, the section it renders, and the assertions
 * differ from one file to the next. This module holds what stayed the same
 * across all four copies before they were pulled out.
 */

import { FakeEl, installFakeDom } from '../support/measurePanelDom';
import type { InspectorCallbacks } from '../../src/ui/Inspector';

/** Installs the fake DOM and the globals Inspector's constructor touches, call it from each suite's `beforeAll`. */
export function installInspectorFakeDom(): void {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).createElementNS = (_ns: string, tag: string): FakeEl =>
    new FakeEl(tag);
  (g.document as Record<string, unknown>).createDocumentFragment = (): FakeEl =>
    new FakeEl('#fragment');
  g.window = { setTimeout, clearTimeout, localStorage: undefined, confirm: () => true };
  g.HTMLSelectElement = class {};
  g.HTMLTextAreaElement = class {};
}

/**
 * A full no-op `InspectorCallbacks` set, the minimum needed to construct an
 * Inspector. None of these callbacks are exercised by the lazy-chunk suites.
 */
export function fakeCallbacks(): InspectorCallbacks {
  const noop = (): void => {};
  return {
    onColorMode: noop,
    onHeightPercentileTrim: noop,
    onPointSize: noop,
    onToggleVisible: noop,
    onRemove: noop,
    onSaveView: noop,
    onApplyView: noop,
    onRenameView: noop,
    onDeleteView: noop,
    onEdlToggle: noop,
    onEdlStrength: noop,
    onPointSizeMode: noop,
    onAntialiasing: noop,
    onTwoFingerTwist: noop,
    onNavigationPrefsChange: noop,
    onRgbAppearancePreset: noop,
    onEdlPreset: noop,
    onSkyPreset: noop,
    onWhiteBalance: noop,
    onAutoBalance: noop,
    onSplatMode: noop,
    onTerrainWorkflowPreset: noop,
  };
}

/** Flushes the microtask queue so pending `.then`/`.catch`/`.finally` callbacks run. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
