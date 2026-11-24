/**
 * measureKindActions.test.ts: the palette arms a kind of measurement directly,
 * and lists those rows only for a query.
 */
import { describe, it, expect, vi } from 'vitest';
import { contributeToolActions } from '../src/app/actions/toolActions';
import { actionsForLayout, rankActions, type Action } from '../src/ui/actionRegistry';
import { CommandPalette } from '../src/ui/CommandPalette';
import { buildTestActionRegistry } from './helpers/actionRegistryFixture';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

function rig(measureMode: boolean) {
  const viewer = { measureMode, measure: { setKind: vi.fn() } };
  const calls: string[] = [];
  viewer.measure.setKind.mockImplementation((k: string) => calls.push(k));
  const runTool = vi.fn((t: string) => { calls.push(t); viewer.measureMode = !viewer.measureMode; });
  const actions = contributeToolActions({ getViewer: () => viewer as never, runTool, hasScan: () => true } as never);
  return { viewer, calls, run: (kind: string) => actions.find((a) => a.id === `tool.measure.${kind}`)!.run() };
}
const goTo: Action = { id: 'goto.workspace.profile-workbench', title: 'Go to Profile Workbench', section: 'Go to', keywords: ['Profile Workbench'], run: () => {} };
const all = [...buildTestActionRegistry(), goTo];

describe('measurement kinds in the palette', () => {
  it.each(['distance', 'polyline', 'area', 'height', 'angle', 'slope', 'profile', 'box', 'volume'])('typing %s offers it first', (kind) => {
    expect(rankActions(kind, all)[0]!.action.id).toBe(`tool.measure.${kind}`);
  });

  it('keeps the other rows reachable, with titles of their own', () => {
    expect(rankActions('measure', all)[0]!.action.id).toBe('tool.measure');
    expect(rankActions('lasso', all)[0]!.action.id).toBe('tool.lasso-volume');
    expect(rankActions('profile workbench', all)[0]!.action.id).toBe(goTo.id);
    const titles = all.map((a) => a.title);
    expect(titles.filter((t) => t.endsWith(' measurement'))).toHaveLength(9);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('turns Measure on, then sets the kind', () => {
    const r = rig(false);
    r.run('profile');
    expect(r.calls).toEqual(['measure', 'profile']);
  });

  it('with Measure already on only sets the kind', () => {
    const r = rig(true);
    r.run('area');
    expect(r.calls).toEqual(['area']);
    expect(r.viewer.measureMode).toBe(true);
  });

  it('is disabled with the reason when no scan is open', () => {
    const rows = all.filter((a) => a.id.startsWith('tool.measure.'));
    expect(rows).toHaveLength(9);
    for (const a of rows) expect(a.unavailable).toBe('Open a scan first.');
  });

  it('follows Measure in a bare layout', () => {
    const kept = (measurements: boolean) => actionsForLayout([...all], { bare: true, measurements, annotations: false }).filter((a) => a.id.startsWith('tool.measure')).length;
    expect([kept(false), kept(true)]).toEqual([0, 10]);
  });

  it('is listed for a query and not while browsing', () => {
    installLiveFakeDom();
    const palette = new CommandPalette();
    const read = palette as unknown as { _input: FakeEl & { value: string }; _refresh(): void; _ranked: Array<{ action: Action }> };
    palette.setActions(all);
    const ids = (q: string): string[] => { read._input.value = q; read._refresh(); return read._ranked.map((r) => r.action.id); };
    expect(ids('  ').filter((i) => i.startsWith('tool.measure'))).toEqual(['tool.measure']);
    expect(ids('')).toHaveLength(all.length - 9);
    expect(ids('profile')).toContain('tool.measure.profile');
  });
});
