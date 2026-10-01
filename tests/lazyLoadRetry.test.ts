/**
 * lazyLoadRetry.test.ts
 *
 * Each lazy loader below keeps its first attempt so concurrent callers share
 * one import. Kept after a rejection, that attempt would answer every later
 * call, a toast's Try again included, with the same failure until the page
 * reloads. All of them go through `retryableOnce`; these pin that it drops
 * a failed load, that the plan view controller and the Measurements panel
 * load again after one, and, by their source, that the loaders in main.ts
 * (which a unit test cannot import) use it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const loadPlanViewController = vi.fn();
const loadMeasurePanel = vi.fn();
vi.mock('../src/lazyChunks', () => ({
  loadPlanViewController: () => loadPlanViewController(),
  loadMeasurePanel: () => loadMeasurePanel(),
  loadProfileWorkbenchRuntime: () => Promise.reject(new Error('not under test')),
}));

import { createNavBarWiring } from '../src/ui/navBarWiring';
import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { retryableOnce, runWithRetry, mountPanelOnce } from '../src/app/lazySurfaceLoad';

const chunk404 = (): Promise<never> => Promise.reject(new Error('chunk 404'));

beforeEach(() => {
  loadPlanViewController.mockReset();
  loadMeasurePanel.mockReset();
});

describe('retryableOnce', () => {
  it('shares one load between callers, while it runs and once it resolves', async () => {
    const load = vi.fn(async () => 'panel');
    const ensure = retryableOnce(load);
    const [a, b] = await Promise.all([ensure(), ensure()]);
    expect(await ensure()).toBe('panel');
    expect([a, b]).toEqual(['panel', 'panel']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes a rejection to every caller that shared it, then loads again on the next call', async () => {
    const load = vi.fn().mockImplementationOnce(chunk404).mockImplementation(async () => 'panel');
    const ensure = retryableOnce(load);
    const first = ensure();
    const joined = ensure();
    await expect(first).rejects.toThrow('chunk 404');
    await expect(joined).rejects.toThrow('chunk 404');
    expect(await ensure()).toBe('panel');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('runWithRetry', () => {
  it('reports a failure with a Try again that runs the same load again', async () => {
    const load = vi.fn().mockImplementationOnce(chunk404).mockImplementation(async () => 'done');
    const toasts: Array<{ message: string; action?: { readonly label: string; readonly onClick: () => void } }> = [];
    runWithRetry({ show: (message, action) => { toasts.push({ message, action }); } }, load, 'panel');
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.map((t) => t.message)).toEqual(['chunk 404']);
    toasts[0].action!.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(load).toHaveBeenCalledTimes(2);
    expect(toasts).toHaveLength(1);
  });
});

describe('mountPanelOnce', () => {
  it('builds, mounts and hydrates once, and returns an existing panel untouched', () => {
    const order: string[] = [];
    const panel = { element: {} as HTMLElement };
    const built = mountPanelOnce(null, () => { order.push('build'); return panel; }, () => order.push('mount'), () => order.push('hydrate'));
    expect(built).toBe(panel);
    expect(order).toEqual(['build', 'mount', 'hydrate']);
    expect(mountPanelOnce(panel, () => { throw new Error('rebuilt'); }, null, () => order.push('again'))).toBe(panel);
    expect(order).toHaveLength(3);
  });

  it('still builds and hydrates when no mount hook is set (bare and embed layouts)', () => {
    const order: string[] = [];
    const panel = { element: {} as HTMLElement };
    expect(mountPanelOnce(null, () => { order.push('build'); return panel; }, null, () => order.push('hydrate'))).toBe(panel);
    expect(order).toEqual(['build', 'hydrate']);
  });
});

describe('plan view controller', () => {
  it('loads again on the next press after a failed load', async () => {
    const toggle = vi.fn();
    loadPlanViewController
      .mockImplementationOnce(chunk404)
      .mockImplementation(async () => ({ createPlanViewController: () => ({ toggle }) }));
    const wiring = createNavBarWiring({ getViewer: () => null, getNavBar: () => null, toast: vi.fn() });
    await expect(wiring.togglePlanView()).rejects.toThrow('chunk 404');
    await wiring.togglePlanView();
    expect(loadPlanViewController).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('Measurements panel mount', () => {
  it('loads the panel chunk again on the next call after a failed load', async () => {
    loadMeasurePanel.mockImplementation(chunk404);
    const mount = createMeasurePanelMount({
      getViewer: () => { throw new Error('no viewer in this test'); },
      crsService: {} as never,
      getExportPanel: () => ({ refresh: () => {} }),
      exportSession: () => undefined,
      handleFile: () => undefined,
      recordUsage: () => {},
    });
    await expect(mount.ensure()).rejects.toThrow('chunk 404');
    await expect(mount.ensure()).rejects.toThrow('chunk 404');
    expect(loadMeasurePanel).toHaveBeenCalledTimes(2);
    expect(mount.panel).toBeNull();
  });
});

describe('main.ts lazy loaders', () => {
  const MAIN = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

  it.each(['ensureActionRegistry', 'ensureWorkflowConfigPanel', 'ensureAnalysePanel', 'ensureObjectPanel', 'mountReclassifyUi'])(
    '%s loads through retryableOnce, which drops a failed load',
    (loader) => {
      expect(MAIN).toContain(`const ${loader} = retryableOnce(`);
    },
  );

  it('keeps no promise cache of its own that could hold a rejection', () => {
    for (const cache of ['let actionRegistry', '_analyseReady', '_objectReady', 'reclassifyUiLoading', 'workflowConfigPanelLoading']) {
      expect(MAIN, cache).not.toContain(cache);
    }
  });

  it('mounts the command palette only once its actions have arrived', () => {
    const start = MAIN.indexOf('const palette = new CommandPalette();');
    expect(start).toBeGreaterThan(-1);
    const build = MAIN.slice(start, MAIN.indexOf('return palette;', start));
    const setActions = build.indexOf('palette.setActions(await ensureActionRegistry());');
    const mount = build.indexOf('stage.overlay.append(palette.element);');
    expect(setActions).toBeGreaterThan(-1);
    // A registry that fails to build throws before the append, so a failed
    // attempt leaves no palette element behind in the overlay.
    expect(mount).toBeGreaterThan(setActions);
  });
});
