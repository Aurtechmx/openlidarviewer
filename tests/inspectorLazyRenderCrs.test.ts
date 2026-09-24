/**
 * inspectorLazyRenderCrs.test.ts
 *
 * `Inspector.setCrs()` renders the Coordinate-system section through a lazy
 * `renderCrs` chunk (`ui/inspector/renderCrs.ts`, split out for the
 * CRS-catalog table it drags in). Same shape as the `_ensureGroups()` /
 * "+ New group" precedent (`inspectorNewGroup.test.ts`): a placeholder
 * shows synchronously, the chunk import is deduped in flight, a failure
 * shows a retry caption, and a second `setCrs()` before the chunk resolves
 * makes the newest call the one that wins.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom, byClass, findContaining } from './support/measurePanelDom';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

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
  loadRenderProvenance: vi.fn(),
  loadRenderReport: vi.fn(),
  loadRenderCrs: vi.fn(() => {
    state.calls++;
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject });
    });
  }),
}));

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).createElementNS = (_ns: string, tag: string): FakeEl =>
    new FakeEl(tag);
  (g.document as Record<string, unknown>).createDocumentFragment = (): FakeEl =>
    new FakeEl('#fragment');
  g.window = { setTimeout, clearTimeout, localStorage: undefined, confirm: () => true };
  g.HTMLSelectElement = class {};
  g.HTMLTextAreaElement = class {};
});

function fakeCallbacks(): InspectorCallbacks {
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

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeCrs(overrides: Partial<ResolvedCrs> = {}): ResolvedCrs {
  return {
    kind: 'projected',
    name: 'WGS 84 / UTM zone 13N',
    epsg: 32613,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
    ...overrides,
  } as ResolvedCrs;
}

async function resolveNextImport(): Promise<void> {
  const mod = await import('../src/ui/inspector/renderCrs');
  const p = state.pending.pop();
  p?.resolve(mod);
  await tick();
}

describe('Inspector.setCrs — lazy renderCrs chunk', () => {
  it('shows a loading placeholder synchronously, then the real content once the chunk resolves', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const crsBody = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-crs',
    )!;

    inspector.setCrs(makeCrs());
    expect(findContaining(crsBody, 'Loading coordinate system')).toBeTruthy();
    expect(state.calls).toBe(1);

    await resolveNextImport();

    expect(findContaining(crsBody, 'WGS 84 / UTM zone 13N')).toBeTruthy();
    expect(crsBody.querySelectorAll('.olv-crs-select').length).toBe(1);
  });

  it('dedupes a second setCrs() call that arrives before the chunk resolves, and the latest data wins', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const crsBody = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-crs',
    )!;

    inspector.setCrs(makeCrs({ name: 'First CRS' }));
    inspector.setCrs(makeCrs({ name: 'Second CRS' }));
    expect(state.calls).toBe(1); // one in-flight import, not two

    await resolveNextImport();

    expect(findContaining(crsBody, 'Second CRS')).toBeTruthy();
    expect(findContaining(crsBody, 'First CRS')).toBeUndefined();
  });

  it('shows a retry caption on a failed chunk load, and a retry re-attempts the import', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const crsBody = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-crs',
    )!;

    inspector.setCrs(makeCrs());
    const failing = state.pending.pop();
    failing?.reject(new Error('network error'));
    await tick();

    expect(findContaining(crsBody, 'Could not load the coordinate system')).toBeTruthy();
    const retry = byClass(crsBody, 'olv-inline-retry');
    expect(retry).toBeTruthy();

    retry!.click();
    expect(state.calls).toBe(2);

    await resolveNextImport();
    expect(crsBody.querySelectorAll('.olv-crs-select').length).toBe(1);
  });
});
