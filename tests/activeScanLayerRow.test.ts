/**
 * activeScanLayerRow.test.ts
 *
 * Two scans open, the second removed: the map sheet's title, notes and file
 * name, and the Terrain Intelligence report's scan name, still read the
 * removed scan while every figure came from the one left. The exports took the
 * name of the last scan opened, not the active one.
 *
 * Nothing in the Layers list could make a loaded scan the active one either:
 * only opening a scan or removing the active one changed it. A layer's name
 * now does, and the list marks which scan is active.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).createElementNS = (_ns: string, tag: string): FakeEl => new FakeEl(tag);
  g.window = { setTimeout, clearTimeout, localStorage: undefined, confirm: () => true };
  g.HTMLSelectElement = class {};
  g.HTMLTextAreaElement = class {};
});

function callbacks(onActivate: (id: string) => void): InspectorCallbacks {
  const noop = (): void => {};
  return {
    onColorMode: noop, onHeightPercentileTrim: noop, onPointSize: noop, onToggleVisible: noop, onRemove: noop,
    onSaveView: noop, onApplyView: noop, onRenameView: noop, onDeleteView: noop, onEdlToggle: noop,
    onEdlStrength: noop, onPointSizeMode: noop, onAntialiasing: noop, onTwoFingerTwist: noop,
    onNavigationPrefsChange: noop, onRgbAppearancePreset: noop, onEdlPreset: noop, onSkyPreset: noop,
    onWhiteBalance: noop, onAutoBalance: noop, onSplatMode: noop, onTerrainWorkflowPreset: noop,
    onActivate,
  };
}

const rowOf = (inspector: Inspector, id: string) =>
  (inspector as unknown as { _layerRows: Map<string, FakeEl> })._layerRows.get(id)!;
const nameOf = (inspector: Inspector, id: string) => byClass(rowOf(inspector, id), 'olv-layer-name')!;

describe('the Layers list and the active scan', () => {
  it('makes a layer the active scan when its name is pressed', () => {
    const onActivate = vi.fn();
    const inspector = new Inspector(callbacks(onActivate));
    inspector.addCloud('a', 'a.laz', 10);
    inspector.addCloud('b', 'b.laz', 10);
    nameOf(inspector, 'a').click();
    expect(onActivate).toHaveBeenCalledWith('a');
  });

  it('marks only the active scan, including a row added after the scan became active', () => {
    const inspector = new Inspector(callbacks(() => {}));
    inspector.addCloud('a', 'a.laz', 10);
    inspector.setActiveLayer('b'); // the open path sets the active scan before its row exists
    inspector.addCloud('b', 'b.laz', 10);
    expect(nameOf(inspector, 'b').getAttribute('aria-pressed')).toBe('true');
    expect(rowOf(inspector, 'b').classList.contains('is-active-layer')).toBe(true);
    expect(nameOf(inspector, 'a').getAttribute('aria-pressed')).toBe('false');
    inspector.setActiveLayer('a');
    expect(nameOf(inspector, 'a').getAttribute('aria-pressed')).toBe('true');
    expect(nameOf(inspector, 'b').getAttribute('aria-pressed')).toBe('false');
    expect(rowOf(inspector, 'b').classList.contains('is-active-layer')).toBe(false);
  });
});

describe('the shell', () => {
  const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');

  it('names exports after the active scan, falling back to the last opened only with none', () => {
    expect(main).toContain('const activeScanName = (): string => baseName(scans.activeCloud()?.name ?? lastCloudName);');
    expect(main).toContain('getExportBasename: activeScanName,');
    expect(main).toContain('title: `${activeScanName()} — Contours`,');
    // No export hook reads the last-opened name directly.
    expect(main).not.toMatch(/\(\)\s*=>\s*lastCloudName\b/);
    expect(main).not.toContain('${lastCloudName}');
  });

  it('activates a layer through the shared refresh and keeps the marked row in step', () => {
    expect(main).toContain('onActivate: activateLayer,');
    expect(main).toMatch(/scans\.onActiveChange\(\(\) => \{[^}]*inspector\.setActiveLayer\(scans\.activeId\);/);
  });
});
