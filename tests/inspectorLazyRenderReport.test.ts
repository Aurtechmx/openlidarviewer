/**
 * inspectorLazyRenderReport.test.ts
 *
 * `Inspector.setReport()` renders the Scan report rows through a lazy
 * `renderReport` chunk (`ui/inspector/renderReport.ts`). Same shape as
 * `inspectorLazyRenderCrs.test.ts`: placeholder first, in-flight dedupe,
 * retry-on-failure, latest-wins.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom, byClass, findContaining } from './support/measurePanelDom';
import type { AnalysisRow } from '../src/analysis/ModuleApi';

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
  loadRenderProvenance: vi.fn(),
  loadRenderReport: vi.fn(() => {
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

function rows(label: string): AnalysisRow[] {
  return [{ label, value: '1,234', status: 'pass' }];
}

async function resolveNextImport(): Promise<void> {
  const mod = await import('../src/ui/inspector/renderReport');
  const p = state.pending.pop();
  p?.resolve(mod);
  await tick();
}

describe('Inspector.setReport — lazy renderReport chunk', () => {
  it('shows a loading placeholder synchronously, then the real rows once the chunk resolves', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const report = byClass(
      (inspector as unknown as { element: FakeEl }).element,
      'olv-report',
    ) ?? (inspector as unknown as { _report: FakeEl })._report;

    inspector.setReport(rows('Point count'));
    expect(findContaining(report, 'Loading scan report')).toBeTruthy();
    expect(state.calls).toBe(1);

    await resolveNextImport();

    expect(findContaining(report, 'Point count')).toBeTruthy();
  });

  it('dedupes a second setReport() call before the chunk resolves, and the latest rows win', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const report = (inspector as unknown as { _report: FakeEl })._report;

    inspector.setReport(rows('First metric'));
    inspector.setReport(rows('Second metric'));
    expect(state.calls).toBe(1);

    await resolveNextImport();

    expect(findContaining(report, 'Second metric')).toBeTruthy();
    expect(findContaining(report, 'First metric')).toBeUndefined();
  });

  it('shows a retry caption on a failed chunk load, and a retry re-attempts the import', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    const report = (inspector as unknown as { _report: FakeEl })._report;

    inspector.setReport(rows('Point count'));
    const failing = state.pending.pop();
    failing?.reject(new Error('network error'));
    await tick();

    expect(findContaining(report, 'Could not load the scan report')).toBeTruthy();
    const retry = byClass(report, 'olv-inline-retry');
    expect(retry).toBeTruthy();

    retry!.click();
    expect(state.calls).toBe(2);

    await resolveNextImport();
    expect(findContaining(report, 'Point count')).toBeTruthy();
  });
});
