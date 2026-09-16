/**
 * toolLauncher.test.ts
 *
 * The Tools-tab launcher card. It is registry-driven, so the tests assert that
 * the rows come from the real action registry in the card's fixed order, that
 * a click runs the action, that the host's gate disables a row with its reason,
 * that the counts line reads the deps rather than any count of its own, and
 * that the card folds to its strip while a tool panel holds the column.
 *
 * Runs in the node environment against a local recording document with live
 * listeners, the way the desktop workspace tests do.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildTestActionRegistry } from './helpers/actionRegistryFixture';
import type { Action } from '../src/ui/actionRegistry';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  root: FakeEl;
  refresh: () => void;
  dispose: () => void;
  rows: () => FakeEl[];
  titles: () => string[];
  countsText: () => string;
}

async function make(over: Partial<{
  actions: readonly Action[];
  async: boolean;
  counts: () => { measurements: number; annotations: number };
  isToolPanelActive: () => boolean;
  disabledReason: () => string | null;
}> = {}): Promise<Harness> {
  const { createToolLauncher } = await import('../src/ui/toolLauncher');
  const actions = over.actions ?? buildTestActionRegistry();
  const launcher = createToolLauncher({
    getActions: () => (over.async ? Promise.resolve(actions) : actions),
    counts: over.counts ?? (() => ({ measurements: 0, annotations: 0 })),
    isToolPanelActive: over.isToolPanelActive ?? (() => false),
    disabledReason: over.disabledReason,
  });
  const root = launcher.element as unknown as FakeEl;
  const rows = (): FakeEl[] => root.findAll((e) => e.hasClass('olv-tl-row') || e.hasClass('olv-tl-chip'));
  return {
    root,
    refresh: launcher.refresh,
    dispose: launcher.dispose,
    rows,
    titles: () => rows().flatMap((r) => r.findAll((e) => e.hasClass('olv-tl-title')).map((t) => t.ownText)),
    countsText: () => root.findAll((e) => e.hasClass('olv-tl-counts'))[0].textContent,
  };
}

describe('tool launcher', () => {
  it('lists the registry tools in the card order, skipping ids the build has not got', async () => {
    const h = await make();
    // tool.probe is not a registry action, so the card lists the four that are.
    expect(h.titles()).toEqual(['Measure', 'Inspect point', 'Annotate', 'Clip box']);
  });

  it('carries each row title, hint and key chip from the descriptor', async () => {
    const h = await make();
    const measure = h.rows()[0];
    expect(measure.findAll((e) => e.hasClass('olv-tl-hint'))[0].ownText)
      .toBe('Activate the measurement toolbar.');
    expect(measure.findAll((e) => e.tagName === 'kbd')[0].ownText).toBe('M');
  });

  it('runs the action on click', async () => {
    const run = vi.fn();
    const h = await make({ actions: [{ id: 'tool.measure', title: 'Measure', section: 'Tools', run }] });
    h.rows()[0].fire('click');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('renders a gated row disabled with the host reason and no click path', async () => {
    const run = vi.fn();
    const h = await make({
      actions: [{ id: 'tool.measure', title: 'Measure', section: 'Tools', run }],
      disabledReason: () => 'Load a scan to use the tools.',
    });
    expect(h.rows()[0].disabled).toBe(true);
    expect(h.rows()[0].title).toBe('Load a scan to use the tools.');
    h.rows()[0].fire('click');
    expect(run).not.toHaveBeenCalled();
  });

  it('reads the counts line from the deps on every refresh', async () => {
    let counts = { measurements: 1, annotations: 0 };
    const h = await make({ counts: () => counts });
    expect(h.countsText()).toContain('1 measurement · 0 annotations');
    counts = { measurements: 3, annotations: 2 };
    h.refresh();
    expect(h.countsText()).toContain('3 measurements · 2 annotations');
  });

  it('folds to the strip while a tool panel holds the column, and back', async () => {
    let active = false;
    const h = await make({ isToolPanelActive: () => active });
    expect(h.root.hasClass('is-strip')).toBe(false);
    expect(h.rows()[0].hasClass('olv-tl-row')).toBe(true);
    active = true;
    h.refresh();
    expect(h.root.hasClass('is-strip')).toBe(true);
    expect(h.rows().every((r) => r.hasClass('olv-tl-chip'))).toBe(true);
    // The strip keeps the titles and drops the descriptions and the counts.
    expect(h.titles()).toEqual(['Measure', 'Inspect point', 'Annotate', 'Clip box']);
    expect(h.root.findAll((e) => e.hasClass('olv-tl-hint'))).toHaveLength(0);
    active = false;
    h.refresh();
    expect(h.root.hasClass('is-strip')).toBe(false);
  });

  it('fills from an async registry', async () => {
    const h = await make({ async: true });
    await flush();
    expect(h.titles()).toEqual(['Measure', 'Inspect point', 'Annotate', 'Clip box']);
  });

  it('dispose removes every row listener and stops later renders', async () => {
    const run = vi.fn();
    const h = await make({ actions: [{ id: 'tool.measure', title: 'Measure', section: 'Tools', run }] });
    const row = h.rows()[0];
    expect(row.listenerCount('click')).toBe(1);
    h.dispose();
    expect(row.listenerCount('click')).toBe(0);
    h.refresh();
    expect(h.rows()).toHaveLength(0);
  });
});
