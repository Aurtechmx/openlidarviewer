/**
 * inspectorNewGroup.test.ts
 *
 * INSPECT-INSP-3 / INSPECT-INSP-6: "+ New group" loads the LayerGroupsPanel
 * chunk lazily on first click. Two bugs shared that path:
 *
 *   - INSP-6: `_ensureGroups()` only short-circuited once `_groups` was
 *     already built, so a second click before the first import settled
 *     started a second `import()` and both `.then` callbacks ran
 *     `createGroup()` against the one instance the second resolution found
 *     already built — two groups from one action.
 *   - INSP-3: a failed chunk load only logged `console.warn`; the click
 *     handler's `.then((groups) => groups?.createGroup())` was then a
 *     silent no-op with no toast, no message, no retry affordance.
 *
 * These tests drive the click through a deferred (manually-resolved) mock of
 * the lazy import, so the "before the first import settles" window is
 * reproducible without a real network delay.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';

const state = vi.hoisted(() => ({
  calls: 0,
  pending: [] as Array<{
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>,
}));

vi.mock('../src/lazyChunks', () => ({
  loadLayerHealthCard: vi.fn(),
  loadLayerGroupsPanel: vi.fn(() => {
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

/** Flush the microtask queue so pending `.then`/`.catch`/`.finally` callbacks run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The "+ New group" button specifically — `.olv-group-new` also matches
 * "+ Add dataset" (`olv-group-new olv-add-dataset-row`), so `byClass`'s
 * first-match search is not enough here.
 */
function newGroupButton(root: FakeEl): FakeEl {
  const match = root
    .querySelectorAll('.olv-group-new')
    .find((n) => !n.classList.contains('olv-add-dataset-row'));
  if (!match) throw new Error('"+ New group" button not found');
  return match;
}

async function resolveNextImport(): Promise<void> {
  const { LayerGroupsPanel } = await import('../src/ui/LayerGroupsPanel');
  const p = state.pending.pop();
  p?.resolve({ LayerGroupsPanel });
  await tick();
}

describe('Inspector — "+ New group"', () => {
  it('reuses the in-flight chunk import: a second click before it settles does not import twice or create two groups', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('layer-1', 'campus.laz', 1_000);
    const root = (inspector as unknown as { element: FakeEl }).element;
    const button = newGroupButton(root);

    button.click();
    button.click(); // fires before the mocked import has resolved

    expect(state.calls).toBe(1);

    await resolveNextImport();

    const groups = (inspector as unknown as { _groups: { groupsForSession(): unknown[] } })
      ._groups;
    expect(groups).toBeTruthy();
    expect(groups.groupsForSession().length).toBe(1);
  });

  it('shows a pending state on the button while the chunk loads, and clears it after', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('layer-1', 'campus.laz', 1_000);
    const root = (inspector as unknown as { element: FakeEl }).element;
    const button = newGroupButton(root);

    button.click();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).not.toBe('+ New group');

    await resolveNextImport();

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(button.textContent).toBe('+ New group');
  });

  it('reports a failed chunk load visibly, and leaves the button clickable to retry', async () => {
    state.calls = 0;
    state.pending.length = 0;
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('layer-1', 'campus.laz', 1_000);
    const root = (inspector as unknown as { element: FakeEl }).element;
    const button = newGroupButton(root);
    const errorCaption = byClass(root, 'olv-group-load-error')!;

    expect(errorCaption.classList.contains('olv-hidden')).toBe(true);

    button.click();
    const failing = state.pending.pop();
    failing?.reject(new Error('network error'));
    await tick();

    expect(errorCaption.classList.contains('olv-hidden')).toBe(false);
    expect(errorCaption.textContent.length).toBeGreaterThan(0);
    // Retry affordance: the button is clickable again, not stuck disabled.
    expect(button.disabled).toBe(false);

    // Retrying actually re-attempts the import (state was cleared, not stuck).
    button.click();
    expect(state.calls).toBe(2);
  });
});
