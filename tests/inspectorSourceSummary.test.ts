/**
 * The Data home's source row reads Inspector.sourceSummary() and refreshes on
 * onSourceChange, which fires on every layer, CRS and provenance change.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

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

describe('Inspector source summary signal', () => {
  it('reports format and CRS, and fires on layer add, CRS override and clear', () => {
    const ins = new Inspector(fakeCallbacks());
    const fn = vi.fn();
    ins.onSourceChange(fn);
    ins.addCloud('a', 'tile.laz', 10);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ins.sourceSummary()).toBe('LAZ');
    ins.setCrs({ kind: 'projected', name: 'NAD83 / UTM zone 15N', linearUnit: 'metre', linearUnitToMetres: 1 } as never);
    expect(ins.sourceSummary()).toBe('LAZ, NAD83 / UTM zone 15N');
    // A user override reaches the Inspector through the same setCrs path.
    ins.setCrs({ kind: 'projected', name: 'WGS 84 / UTM zone 15N', linearUnit: 'metre', linearUnitToMetres: 1 } as never);
    expect(ins.sourceSummary()).toBe('LAZ, WGS 84 / UTM zone 15N');
    ins.clearCrs();
    expect(ins.sourceSummary()).toBe('LAZ');
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
