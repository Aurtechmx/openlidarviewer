/**
 * analyseWorkspace.test.ts
 *
 * The Analyse home and its pages over the real router and workspace: one row
 * per analysis from Process Studio's state, a blocked lab row whose fix lands
 * on the Terrain page, lab rows that open their modal without a page change,
 * Contours as the one child page (Back returns to Terrain, then home), the
 * depth limit, and that the live panels are moved, never rebuilt.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import type { ProductId, ScanFacts } from '../src/process/ProcessPlan';
import type { CrsInfo } from '../src/io/crs';

beforeAll(installLiveFakeDom);

const metreCrs = { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88' } as unknown as CrsInfo;
const facts = {
  kind: 'static', coverage: 'full', crs: metreCrs, pointCount: 1_000_000,
  hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
  classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
} as ScanFacts;

const tick = () => new Promise((r) => setTimeout(r, 0));

async function make(produced: ProductId[] = []) {
  const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
  const { createWorkspaceRouter } = await import('../src/app/workspace/workspaceRouter');
  const { createAnalyseWorkspace } = await import('../src/app/workspace/analyseWorkspace');
  let router: ReturnType<typeof createWorkspaceRouter> | null = null;
  const ws = new DesktopWorkspace({ storage: { getItem: () => null, setItem: () => undefined }, onModeChange: () => router?.sync() });
  const listeners = new Set<() => void>();
  let state = { facts: facts as ScanFacts | null, view: undefined, produced: new Set<ProductId>(produced) };
  const studio = {
    state: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    canRemediate: () => false,
    remediate: vi.fn(),
  };
  const parts = { contours: new FakeEl('div'), range: new FakeEl('div'), features: new FakeEl('div') };
  const links = new FakeEl('div');
  const panelEl = new FakeEl('section');
  const panel = {
    element: panelEl as unknown as HTMLElement,
    part: (n: keyof typeof parts) => parts[n] as unknown as HTMLElement,
    hasPart: (n: keyof typeof parts) => n === 'contours',
    restoreParts: vi.fn(),
    linksHost: () => links as unknown as HTMLElement,
    setPartsListener: vi.fn(),
  };
  const processStudio = new FakeEl('section');
  const showTerrain = vi.fn(async () => undefined);
  const runAction = vi.fn();
  const aw = createAnalyseWorkspace({
    studio,
    processStudio: processStudio as unknown as HTMLElement,
    analysePanel: () => panel,
    objectPanel: () => null,
    showTerrain,
    showObjects: vi.fn(async () => undefined),
    runAction,
    isMobile: () => false,
  });
  router = createWorkspaceRouter(ws, { analyse: aw.pages });
  aw.attach(router);
  const host = ws.mode('analyse') as unknown as FakeEl;
  ws.mountInMode('analyse', aw.home);
  aw.place(host as unknown as HTMLElement);
  ws.setMode('analyse');
  const row = (id: string): FakeEl => (aw.home as unknown as FakeEl).find((e) => e.dataset.analysis === id)!;
  const setState = (s: typeof state) => { state = s; for (const fn of listeners) fn(); };
  return { aw, router, host, row, showTerrain, runAction, panelEl, parts, processStudio, studio, setState };
}

describe('Analyse home', () => {
  it('lists one row per analysis with its status and reason, and no page is open', async () => {
    const t = await make();
    expect(t.router.route()).toEqual({ mode: 'analyse', page: null });
    for (const id of ['terrain', 'flow-pulse', 'terrain-access', 'observatory', 'objects']) {
      const r = t.row(id);
      expect(r).toBeDefined();
      expect(r.find((e) => e.hasClass('olv-ah-badge'))?.ownText).toMatch(/^(Ready|Review|Blocked)$/);
      expect(r.find((e) => e.hasClass('olv-ah-reason'))?.ownText.length).toBeGreaterThan(0);
    }
    expect(t.row('terrain-access').hasClass('is-blocked')).toBe(true);
  });

  it('a BLOCKED lab row offers Prepare terrain, which lands on the Terrain page', async () => {
    const t = await make();
    const remedy = t.row('terrain-access').find((e) => e.hasClass('olv-ah-remedy'))!;
    expect(remedy.ownText).toBe('Prepare terrain');
    remedy.fire('click');
    await tick();
    expect(t.showTerrain).toHaveBeenCalledTimes(1);
    expect(t.router.route()).toEqual({ mode: 'analyse', page: 'terrain' });
    const title = t.host.find((e) => e.hasClass('olv-ws-task-title'))!;
    expect(title.ownText).toBe('Terrain');
    expect(title.focused).toBe(true);
  });

  it('a lab row opens its modal through the palette action, with no page change', async () => {
    const t = await make(['dtm', 'contours']);
    t.row('flow-pulse').find((e) => e.hasClass('olv-ah-open'))!.fire('click');
    t.row('observatory').find((e) => e.hasClass('olv-ah-open'))!.fire('click');
    expect(t.runAction.mock.calls.map((c) => c[0])).toEqual(['analyse.flowPulse', 'analyse.observatory']);
    expect(t.router.route().page).toBeNull();
  });

  it('repaints when Process Studio repaints: a terrain run unblocks the labs', async () => {
    const t = await make();
    expect(t.row('flow-pulse').hasClass('is-blocked')).toBe(true);
    t.setState({ facts, view: undefined, produced: new Set<ProductId>(['dtm', 'contours']) });
    expect(t.row('flow-pulse').hasClass('is-blocked')).toBe(false);
  });

  it('Contours sit under Terrain: Back returns to Terrain, then home (max depth two)', async () => {
    const t = await make(['dtm', 'contours']);
    await t.aw.open('terrain');
    await t.aw.open('contours');
    expect(t.router.route().page).toBe('contours');
    const back = t.host.find((e) => e.hasClass('olv-ws-back'))!;
    expect(back.ownText).toBe('← Terrain');
    back.fire('click');
    expect(t.router.route().page).toBe('terrain');
    expect(back.ownText).toBe('← Analyse');
    back.fire('click');
    expect(t.router.route().page).toBeNull();
  });

  it('moves the live panels into the pages and never rebuilds them', async () => {
    const t = await make(['dtm', 'contours']);
    const shell = (page: string) => t.host.find((e) => e.dataset.page === page)!;
    expect(t.panelEl.parent?.parent).toBe(shell('terrain'));
    expect(t.parts.contours.parent?.parent).toBe(shell('contours'));
    // Terrain's Why? holds the Process Studio panel itself.
    expect(t.processStudio.closest('.olv-why')).not.toBeNull();
    await t.aw.open('contours');
    t.router.back();
    t.router.back();
    expect(t.panelEl.parent?.parent).toBe(shell('terrain'));
    expect(t.parts.contours.parent?.parent).toBe(shell('contours'));
  });
});

describe('workspace router depth limit', () => {
  it('refuses a page whose parent has a parent', async () => {
    const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
    const { createWorkspaceRouter } = await import('../src/app/workspace/workspaceRouter');
    const ws = new DesktopWorkspace({ storage: { getItem: () => null, setItem: () => undefined } });
    const page = (parent?: string) => ({ title: 'x', element: () => null, ...(parent ? { parent } : {}) });
    expect(() => createWorkspaceRouter(ws, { analyse: { a: page(), b: page('a') } })).not.toThrow();
    expect(() => createWorkspaceRouter(ws, { analyse: { a: page(), b: page('a'), c: page('b') } })).toThrow(/top-level/);
    expect(() => createWorkspaceRouter(ws, { analyse: { b: page('missing') } })).toThrow(/top-level/);
  });
});
