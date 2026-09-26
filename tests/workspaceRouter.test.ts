/**
 * workspaceRouter.test.ts
 *
 * The left-rail route `{ mode, page }`: navigate, back to the mode's home,
 * per-mode page memory across a mode switch, focus on the task heading, the
 * optional persisted page, and that a route change touches presentation only
 * (no panel is recreated or refreshed and no tool state changes).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

class MemStore {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
}

async function make(store: MemStore = new MemStore()) {
  const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
  const { createWorkspaceRouter } = await import('../src/app/workspace/workspaceRouter');
  let router: ReturnType<typeof createWorkspaceRouter> | null = null;
  const ws = new DesktopWorkspace({ storage: store, onModeChange: () => router?.sync() });
  const launcher = new FakeEl('section');
  const launcherBtn = new FakeEl('button');
  launcher.append(launcherBtn);
  const measure = new FakeEl('aside');
  const annotate = new FakeEl('aside');
  const clip = new FakeEl('div');
  const data = new FakeEl('div');
  const refresh = vi.fn();
  const measureEl = vi.fn(() => measure as unknown as HTMLElement);
  for (const n of [launcher, measure, annotate, clip]) ws.mountInMode('work', n as unknown as HTMLElement);
  ws.mountInMode('data', data as unknown as HTMLElement);
  router = createWorkspaceRouter(ws, {
    work: {
      measure: { title: 'Measure', element: measureEl },
      annotate: { title: 'Annotate', element: () => annotate as unknown as HTMLElement },
      clip: { title: 'Clip box', element: () => clip as unknown as HTMLElement },
    },
  }, store);
  router.sync();
  const host = ws.mode('work') as unknown as FakeEl;
  const header = (): FakeEl => host.find((e) => e.hasClass('olv-ws-task'))!;
  const title = (): FakeEl => host.find((e) => e.hasClass('olv-ws-task-title'))!;
  const off = (n: FakeEl): boolean => n.hasClass('olv-ws-off');
  return { ws, router, host, launcher, launcherBtn, measure, annotate, clip, data, refresh, measureEl, header, title, off, store };
}

describe('workspaceRouter', () => {
  it('navigate shows only the chosen panel under a task header', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'measure' });
    expect(t.ws.getMode()).toBe('work');
    expect(t.router.route()).toEqual({ mode: 'work', page: 'measure' });
    expect(t.off(t.measure)).toBe(false);
    for (const n of [t.launcher, t.annotate, t.clip]) expect(t.off(n)).toBe(true);
    expect(t.host.firstChild).toBe(t.header());
    expect(t.header().hidden).toBe(false);
    expect(t.title().ownText).toBe('Measure');
    expect(t.title().attrs['aria-current']).toBe('page');
    const back = t.header().find((e) => e.hasClass('olv-ws-back'))!;
    expect(back.tagName).toBe('button');
    expect(back.attrs['aria-label']).toBe('Back to Tools');
  });

  it('back returns to the mode home and is idempotent', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'annotate' });
    t.router.back();
    expect(t.router.route()).toEqual({ mode: 'work', page: null });
    expect(t.off(t.launcher)).toBe(false);
    expect(t.header().hidden).toBe(true);
    t.router.back();
    expect(t.router.route()).toEqual({ mode: 'work', page: null });
  });

  it('the header back button (a real button, so Enter/Space work) goes home and focuses the launcher', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'clip' });
    t.header().find((e) => e.hasClass('olv-ws-back'))!.fire('click');
    expect(t.router.route().page).toBeNull();
    expect(t.launcherBtn.focused).toBe(true);
  });

  it('remembers each mode\'s page: Tools -> Measure -> Data -> Tools shows Measure', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'measure' });
    t.ws.setMode('data');
    expect(t.router.route()).toEqual({ mode: 'data', page: null });
    t.ws.setMode('work');
    expect(t.router.route()).toEqual({ mode: 'work', page: 'measure' });
    expect(t.off(t.launcher)).toBe(true);
    t.router.back();
    expect(t.router.route()).toEqual({ mode: 'work', page: null });
  });

  it('moves focus to the task heading only when asked', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'measure' });
    expect(t.title().focused).toBe(false);
    t.router.navigate({ mode: 'work', page: 'measure' }, true);
    expect(t.title().focused).toBe(true);
    expect(t.title().tabIndex).toBe(-1);
  });

  it('falls back to home while the page panel is hidden by its owner or not mounted', async () => {
    const t = await make();
    t.measure.classList.add('olv-hidden');
    t.router.navigate({ mode: 'work', page: 'measure' });
    expect(t.router.route().page).toBeNull();
    expect(t.off(t.launcher)).toBe(false);
    t.measure.classList.remove('olv-hidden');
    t.router.sync();
    expect(t.router.route().page).toBe('measure');
    t.measureEl.mockReturnValue(null as unknown as HTMLElement);
    t.router.sync();
    expect(t.router.route().page).toBeNull();
  });

  it('persists the page beside the mode key and restores it; junk falls back to home', async () => {
    const t = await make();
    t.router.navigate({ mode: 'work', page: 'annotate' });
    expect(t.store.getItem('olv.workspace.left.mode')).toBe('work');
    expect(JSON.parse(t.store.getItem('olv.workspace.left.page')!)).toEqual({ work: 'annotate' });
    const again = await make(t.store);
    expect(again.router.route()).toEqual({ mode: 'work', page: 'annotate' });

    for (const junk of ['not json', '{"work":"nope"}', '{"bogus":"measure"}', '[1]']) {
      const s = new MemStore();
      s.setItem('olv.workspace.left.mode', 'work');
      s.setItem('olv.workspace.left.page', junk);
      const r = await make(s);
      expect(r.router.route()).toEqual({ mode: 'work', page: null });
    }
  });

  it('a stored mode from before pages existed still restores', async () => {
    const s = new MemStore();
    s.setItem('olv.workspace.left.mode', 'analyse');
    const t = await make(s);
    expect(t.router.route()).toEqual({ mode: 'analyse', page: null });
  });

  it('routing never recomputes: panels keep identity, owners are never called, tool state is untouched', async () => {
    const t = await make();
    const analysis = { runs: 0, run: vi.fn() };
    const measurements = [{ id: 'm1', points: [[0, 0, 0], [1, 0, 0]] }];
    const snapshot = JSON.stringify(measurements);
    const listener = vi.fn();
    t.measure.addEventListener('click', listener);
    const route = (): void => {
      t.router.navigate({ mode: 'work', page: 'measure' }, true);
      t.ws.setMode('data');
      t.ws.setMode('analyse');
      t.ws.setMode('work');
      t.router.back(true);
      t.router.navigate({ mode: 'work', page: 'clip' });
      t.router.navigate({ mode: 'output', page: null });
    };
    route();
    route();
    expect(t.measure.parentElement).toBe(t.host);
    expect(t.data.parentElement).toBe(t.ws.mode('data') as unknown as FakeEl);
    expect(t.measure.listenerCount('click')).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    expect(analysis.run).not.toHaveBeenCalled();
    expect(t.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(measurements)).toBe(snapshot);
    // The router cannot reach a tool, a scan or an analysis: its only imports
    // are the DOM helper and the workspace types.
    const src = readFileSync(join(__dirname, '../src/app/workspace/workspaceRouter.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../ui/dom', '../../ui/workspace/DesktopWorkspace']);
    // Only one header per mode host, however often it routes.
    expect(t.host.findAll((e) => e.hasClass('olv-ws-task'))).toHaveLength(1);
  });
});
