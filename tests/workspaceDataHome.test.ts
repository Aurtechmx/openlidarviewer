/**
 * workspaceDataHome.test.ts
 *
 * The Data home: the layer list plus compact Classes and Source rows, the
 * Classes page that shows the live class legend, Layer Health kept in the
 * Inspector (a row only while the right rail is collapsed), the empty state,
 * and the removed mode switch on file open.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

function deps(over: Partial<Record<string, unknown>> = {}) {
  return {
    hasScan: () => true,
    classCount: () => 6,
    sourceSummary: () => 'LAZ, NAD83 / UTM zone 15N',
    inspectorCollapsed: () => false,
    openClasses: vi.fn(),
    openSource: vi.fn(),
    openLayerHealth: vi.fn(),
    openFile: vi.fn(),
    ...over,
  };
}

async function home(over: Partial<Record<string, unknown>> = {}) {
  const { createDataHome } = await import('../src/app/workspace/dataHome');
  const d = deps(over);
  const h = createDataHome(d as never);
  const root = h.element as unknown as FakeEl;
  const rows = root.findAll((e) => e.hasClass('olv-data-row'));
  const byLabel = (l: string): FakeEl => rows.find((r) => r.textContent.startsWith(l))!;
  const empty = root.find((e) => e.hasClass('olv-data-empty'))!;
  return { h, d, root, byLabel, empty };
}

describe('Data home rows', () => {
  it('shows the class count and the source summary', async () => {
    const t = await home();
    expect(t.byLabel('Classes').textContent).toContain('6 detected');
    expect(t.byLabel('Source and metadata').textContent).toContain('LAZ, NAD83 / UTM zone 15N');
    expect(t.byLabel('Classes').hidden).toBe(false);
    expect(t.empty.hidden).toBe(true);
  });

  it('rows navigate and nothing else', async () => {
    const t = await home();
    t.byLabel('Classes').fire('click');
    t.byLabel('Source and metadata').fire('click');
    expect(t.d.openClasses).toHaveBeenCalledTimes(1);
    expect(t.d.openSource).toHaveBeenCalledTimes(1);
    expect(t.d.openFile).not.toHaveBeenCalled();
  });

  it('shows the Layer Health row only while the right rail is collapsed', async () => {
    let collapsed = false;
    const t = await home({ inspectorCollapsed: () => collapsed });
    expect(t.byLabel('Layer Health').hidden).toBe(true);
    collapsed = true;
    t.h.refresh();
    expect(t.byLabel('Layer Health').hidden).toBe(false);
    t.byLabel('Layer Health').fire('click');
    expect(t.d.openLayerHealth).toHaveBeenCalledTimes(1);
  });

  it('with no scan shows only the open prompt, wired to the open action', async () => {
    const t = await home({ hasScan: () => false });
    expect(t.empty.hidden).toBe(false);
    expect(t.empty.textContent).toContain('Open a point cloud to begin');
    for (const l of ['Classes', 'Source and metadata', 'Layer Health']) expect(t.byLabel(l).hidden).toBe(true);
    t.empty.find((e) => e.tagName === 'button')!.fire('click');
    expect(t.d.openFile).toHaveBeenCalledTimes(1);
  });
});

describe('Classes page', () => {
  async function make() {
    const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
    const { createWorkspaceRouter } = await import('../src/app/workspace/workspaceRouter');
    let router: ReturnType<typeof createWorkspaceRouter> | null = null;
    const ws = new DesktopWorkspace({ onModeChange: () => router?.sync() });
    const n = (): FakeEl => new FakeEl('section');
    const layers = n(); const dataHome = n(); const legend = n();
    const legendToggle = new FakeEl('input');
    legend.append(legendToggle);
    ws.layoutDesktop({
      dataLayers: layers, dataHome, classLegend: legend, annotation: n(), clip: n(), processStudio: n(), export: n(),
    } as never);
    router = createWorkspaceRouter(ws, {
      data: { classes: { title: 'Classes', element: () => legend as unknown as HTMLElement } },
    });
    router.sync();
    const host = ws.mode('data') as unknown as FakeEl;
    return { ws, router, host, layers, dataHome, legend, legendToggle };
  }

  it('Data holds the layer list, the rows and the legend, and no Layer Health', async () => {
    const t = await make();
    expect(t.host.children.filter((c) => !c.hasClass('olv-ws-task'))).toEqual([t.layers, t.dataHome, t.legend]);
  });

  it('home hides the legend; the Classes page shows only the live legend', async () => {
    const t = await make();
    t.ws.setMode('data');
    expect(t.legend.hasClass('olv-ws-off')).toBe(true);
    expect(t.layers.hasClass('olv-ws-off')).toBe(false);
    t.router.navigate({ mode: 'data', page: 'classes' });
    expect(t.router.route()).toEqual({ mode: 'data', page: 'classes' });
    expect(t.legend.hasClass('olv-ws-off')).toBe(false);
    expect(t.layers.hasClass('olv-ws-off')).toBe(true);
    expect(t.dataHome.hasClass('olv-ws-off')).toBe(true);
    // Same node with its controls, moved never recreated.
    expect(t.legend.children).toContain(t.legendToggle);
    const header = t.host.find((e) => e.hasClass('olv-ws-task'))!;
    expect(header.textContent).toContain('Classes');
    t.router.back();
    expect(t.router.route()).toEqual({ mode: 'data', page: null });
    expect(t.legend.hasClass('olv-ws-off')).toBe(true);
  });
});

describe('Layer Health placement and mode switches', () => {
  const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the Inspector hands the workspace only the layer list', () => {
    const inspector = src('src/ui/Inspector.ts');
    expect(inspector).toMatch(/workspaceDataElements\(\): \{ layers: HTMLElement \}/);
    // The health slot stays in the Inspector body, right under the layer list's old place.
    expect(inspector).toMatch(/this\._layersSection,\s*\n\s*this\._layerHealthSlot,/);
  });

  it('opening a file does not switch the rail mode', () => {
    const main = src('src/main.ts');
    const body = main.slice(main.indexOf('function handleFile('), main.indexOf('function handleFile(') + 200);
    expect(body).not.toMatch(/showWorkspaceMode/);
  });
});
