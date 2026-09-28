/**
 * modeHome.test.ts
 *
 * The mode home's Continue row (spec CE-1, CE-MODE-01) over the real router:
 * going home keeps the remembered page and its stored key, the row names the
 * page and its state, and it opens that page again.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

async function make(saved: Record<string, string> = {}) {
  const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
  const { createWorkspaceRouter, WORKSPACE_PAGE_KEY } = await import('../src/app/workspace/workspaceRouter');
  const { createModeHome } = await import('../src/app/workspace/modeHome');
  const store = new Map<string, string>([[WORKSPACE_PAGE_KEY, JSON.stringify(saved)]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  let router: ReturnType<typeof createWorkspaceRouter> | null = null;
  const ws = new DesktopWorkspace({ storage: { getItem: () => null, setItem: () => undefined }, onModeChange: () => router?.sync() });
  const launcher = new FakeEl('section');
  const measure = new FakeEl('section');
  ws.mountInMode('work', launcher as unknown as HTMLElement);
  ws.mountInMode('work', measure as unknown as HTMLElement);
  const pages = { work: { measure: { title: 'Measure', element: () => measure as unknown as HTMLElement } } };
  let count = 3;
  const open = vi.fn((_m: string, page: string) => router?.navigate({ mode: 'work', page }, true));
  let home: ReturnType<typeof createModeHome> | null = null;
  router = createWorkspaceRouter(ws, pages, storage, () => home?.refresh());
  home = createModeHome({
    router,
    pages,
    host: (m) => ws.mode(m),
    open,
    stateOf: (_m, page) => (page === 'measure' ? `${count} measurements` : null),
  });
  ws.setMode('work');
  router.sync();
  const host = ws.mode('work') as unknown as FakeEl;
  const row = (): FakeEl => host.find((e) => e.hasClass('olv-mode-continue'))!;
  return { router, host, row, open, store, key: WORKSPACE_PAGE_KEY, setCount: (n: number) => { count = n; } };
}

describe('mode home Continue row', () => {
  it('shows no row while the mode remembers no page', async () => {
    const t = await make();
    expect(t.row().hidden).toBe(true);
  });

  it('home keeps the remembered page: the row names it and its state, first on the home', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'measure' });
    expect(t.row().hasClass('olv-ws-off')).toBe(true);
    t.router.navigate({ mode: 'work', page: null });
    expect(t.router.route()).toEqual({ mode: 'work', page: null });
    expect(t.router.remembered('work')).toBe('measure');
    expect(JSON.parse(t.store.get(t.key)!)).toEqual({ work: 'measure' });
    const row = t.row();
    expect(row.hidden).toBe(false);
    expect(row.hasClass('olv-ws-off')).toBe(false);
    expect(row.ownText).toBe('Continue: Measure · 3 measurements');
    const kids = t.host.children.filter((c) => !c.hasClass('olv-ws-task'));
    expect(kids[0]).toBe(row);
  });

  it('the row opens the remembered page', async () => {
    const t = await make({ work: 'measure' });
    t.router.navigate({ mode: 'work', page: null });
    t.row().fire('click');
    expect(t.open).toHaveBeenCalledWith('work', 'measure');
    expect(t.router.route()).toEqual({ mode: 'work', page: 'measure' });
  });

  it('a stored page from an earlier session keeps its meaning', async () => {
    const t = await make({ work: 'measure' });
    expect(t.router.route()).toEqual({ mode: 'work', page: 'measure' });
  });

  it('continueLabel leaves out an unknown state', async () => {
    const { continueLabel } = await import('../src/app/workspace/modeHome');
    expect(continueLabel('Classes', null)).toBe('Continue: Classes');
    expect(continueLabel('Measure', '1 measurement')).toBe('Continue: Measure · 1 measurement');
  });
});
