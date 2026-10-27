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
  disabledReason: () => string | null;
  stateOf: (id: string) => string | null;
}> = {}): Promise<Harness> {
  const { createToolLauncher } = await import('../src/ui/toolLauncher');
  const actions = over.actions ?? buildTestActionRegistry();
  const launcher = createToolLauncher({
    getActions: () => (over.async ? Promise.resolve(actions) : actions),
    counts: over.counts ?? (() => ({ measurements: 0, annotations: 0 })),
    disabledReason: over.disabledReason,
    stateOf: over.stateOf,
  });
  const root = launcher.element as unknown as FakeEl;
  const rows = (): FakeEl[] => root.findAll((e) => e.hasClass('olv-tl-row'));
  return {
    root,
    refresh: launcher.refresh,
    dispose: launcher.dispose,
    rows,
    titles: () => rows().flatMap((r) => r.findAll((e) => e.hasClass('olv-tl-title')).map((t) => t.ownText)),
    countsText: () => root.findAll((e) => e.hasClass('olv-tl-counts'))[0].textContent,
  };
}

describe('tool launcher: a running clip box shows on its row', () => {
  it('the Clip box row says it is on, and stops saying so when it is off', async () => {
    let on = true;
    const h = await make({ stateOf: (id) => (id === 'tool.clip' && on ? 'On · Keep inside' : null) });
    const clipRow = () => h.rows().find((r) => r.textContent.includes('Clip box'))!;
    const state = () => clipRow().findAll((e) => e.hasClass('olv-tl-state'))[0];
    expect(state().ownText).toBe('On · Keep inside');
    expect(clipRow().hasClass('is-on')).toBe(true);
    // Other rows carry no state.
    expect(h.rows()[0].hasClass('is-on')).toBe(false);
    on = false;
    h.refresh();
    expect(state().ownText).toBe('');
    expect(clipRow().hasClass('is-on')).toBe(false);
  });
});

describe('tool launcher', () => {
  it('lists the registry tools in the card order, skipping ids the build has not got', async () => {
    const h = await make();
    // tool.probe is not a registry action, so the card lists the four that are.
    expect(h.titles()).toEqual(['Measure', 'Inspect', 'Annotate', 'Clip box']);
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

  it('always renders full rows; a tool page replaces the card instead of folding it', async () => {
    const h = await make();
    expect(h.root.hasClass('is-strip')).toBe(false);
    expect(h.rows().every((r) => r.hasClass('olv-tl-row'))).toBe(true);
  });

  it('fills from an async registry', async () => {
    const h = await make({ async: true });
    await flush();
    expect(h.titles()).toEqual(['Measure', 'Inspect', 'Annotate', 'Clip box']);
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

  it('a refresh keeps each unchanged row: same node, its focus, one listener', async () => {
    const h = await make();
    const before = h.rows();
    before[1].focus();
    for (let i = 0; i < 5; i++) h.refresh();
    const after = h.rows();
    expect(after).toHaveLength(before.length);
    after.forEach((r, i) => expect(r).toBe(before[i]));
    expect(after[1].focused).toBe(true);
    expect(after.every((r) => r.listenerCount('click') === 1)).toBe(true);
  });

  it('a refresh updates a row in place when its descriptor changes', async () => {
    const run = vi.fn();
    let title = 'Measure';
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    const l = createToolLauncher({
      getActions: () => [{ id: 'tool.measure', title, section: 'Tools', run }],
      counts: () => ({ measurements: 0, annotations: 0 }),
    });
    const row = (l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-row'))[0];
    title = 'Measure (renamed)';
    l.refresh();
    const again = (l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-row'))[0];
    expect(again).toBe(row);
    expect(again.findAll((e) => e.hasClass('olv-tl-title'))[0].ownText).toBe('Measure (renamed)');
    again.fire('click');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale async registry read that resolves after a newer one', async () => {
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    const resolvers: Array<(a: readonly Action[]) => void> = [];
    const l = createToolLauncher({
      getActions: () => new Promise<readonly Action[]>((r) => resolvers.push(r)),
      counts: () => ({ measurements: 0, annotations: 0 }),
    });
    l.refresh();
    const mk = (title: string): Action[] => [{ id: 'tool.measure', title, section: 'Tools', run: () => {} }];
    resolvers[1](mk('Newest'));
    await flush();
    resolvers[0](mk('Stale'));
    await flush();
    const titles = (l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-title')).map((t) => t.ownText);
    expect(titles).toEqual(['Newest']);
  });

  it('a registry read that fails leaves no unhandled rejection, and the next refresh fills the rows', async () => {
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let fail = true;
    const l = createToolLauncher({
      getActions: () => (fail
        ? Promise.reject(new Error('error loading dynamically imported module'))
        : Promise.resolve([{ id: 'tool.measure', title: 'Measure', section: 'Tools', run: () => {} }] as Action[])),
      counts: () => ({ measurements: 0, annotations: 0 }),
    });
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    fail = false;
    l.refresh();
    await flush();
    const titles = (l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-title')).map((t) => t.ownText);
    expect(titles).toEqual(['Measure']);
  });

  it('reopening a tool that is on resumes its page instead of toggling it off', async () => {
    const run = vi.fn();
    const resume = vi.fn(() => true);
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    const l = createToolLauncher({
      getActions: () => [{ id: 'tool.measure', title: 'Measure', section: 'Tools', run }],
      counts: () => ({ measurements: 0, annotations: 0 }),
      resume,
    });
    (l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-row'))[0].fire('click');
    expect(resume).toHaveBeenCalledWith('tool.measure');
    expect(run).not.toHaveBeenCalled();
  });

  it('a pending async read after dispose never renders', async () => {
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    let resolve: (a: readonly Action[]) => void = () => {};
    const l = createToolLauncher({
      getActions: () => new Promise<readonly Action[]>((r) => { resolve = r; }),
      counts: () => ({ measurements: 0, annotations: 0 }),
    });
    l.dispose();
    resolve([{ id: 'tool.measure', title: 'Measure', section: 'Tools', run: () => {} }]);
    await flush();
    expect((l.element as unknown as FakeEl).findAll((e) => e.hasClass('olv-tl-row'))).toHaveLength(0);
  });
});
