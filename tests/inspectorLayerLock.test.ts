/**
 * inspectorLayerLock.test.ts
 *
 * INSPECT-INSP-4: the layer lock button's `aria-label` was set once at row
 * build time ("Lock X out of picking") and never updated, so a screen reader
 * kept announcing that name forever, even after the layer was actually
 * locked and the button's real function had become "unlock".
 *
 * This pins that the button's accessible name (`aria-label`) and its
 * `aria-pressed` state both flip with the lock, matching the pattern already
 * used by this file's workflow-preset and scanType chips.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).createElementNS = (_ns: string, tag: string): FakeEl =>
    new FakeEl(tag);
  g.window = {
    setTimeout,
    clearTimeout,
    localStorage: undefined,
    confirm: () => true,
  };
  g.HTMLSelectElement = class {};
  g.HTMLTextAreaElement = class {};
});

/** Every required InspectorCallbacks member, as a no-op — only onToggleLock is read. */
function fakeCallbacks(): InspectorCallbacks {
  const noop = (): void => {};
  return {
    onColorMode: noop,
    onHeightPercentileTrim: noop,
    onPointSize: noop,
    onToggleVisible: noop,
    onRemove: noop,
    onToggleLock: vi.fn(),
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

describe('Inspector — layer lock button', () => {
  it('flips its accessible name and aria-pressed with the locked state', () => {
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('layer-1', 'campus.laz', 1_000);

    const row = (inspector as unknown as { _layerRows: Map<string, FakeEl> })._layerRows.get(
      'layer-1',
    );
    expect(row).toBeDefined();
    const lock = byClass(row!, 'olv-layer-lock');
    expect(lock).toBeDefined();

    // Before any click: matches the unlocked wording, unpressed.
    expect(lock!.getAttribute('aria-label')).toBe('Lock campus.laz out of picking');
    expect(lock!.getAttribute('aria-pressed')).toBe('false');

    lock!.click();
    expect(lock!.getAttribute('aria-label')).toBe('campus.laz is locked — unlock to pick or measure it');
    expect(lock!.getAttribute('aria-pressed')).toBe('true');

    lock!.click();
    expect(lock!.getAttribute('aria-label')).toBe('Lock campus.laz out of picking');
    expect(lock!.getAttribute('aria-pressed')).toBe('false');
  });
});
