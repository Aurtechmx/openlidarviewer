/**
 * exportPanelProductSelection.test.ts
 *
 * The Results shelf's Export action opens the Products lane with one product
 * marked. The mark belongs to that hand-off only: it goes once the product is
 * used and when the active scan changes, so a later render never highlights a
 * product nobody asked for. The terrain lane's arrival also re-renders the
 * export-health block, so its "Terrain products" row follows the run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import { buildExportHealth } from '../src/intelligence/scanStory';

beforeAll(() => { installLiveFakeDom(); });

async function panel(extra: Record<string, unknown> = {}) {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const p = new ExportPanel({
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    ...extra,
  } as ConstructorParameters<typeof ExportPanel>[0]);
  return { p, root: p.element as unknown as FakeEl };
}

const lane = { ready: () => true, run: () => {} };
const marked = (root: FakeEl): string[] =>
  root.findAll((e) => e.hasClass('olv-export-product-group') && e.hasClass('is-selected')).map((e) => e.dataset.product!);

describe('Export panel product selection', () => {
  it('drops the mark once the marked product is used', async () => {
    const { p, root } = await panel();
    p.setTerrainExports(lane);
    expect(p.select('terrain-dem')).toBe(true);
    expect(marked(root)).toEqual(['terrain-dem']);
    const group = root.find((e) => e.dataset.product === 'terrain-dem')!;
    group.find((e) => e.tagName === 'button')!.fire('click');
    p.refresh();
    expect(marked(root)).toEqual([]);
  });

  it('drops the mark when the active scan changes', async () => {
    let scan = 'a';
    const { p, root } = await panel({ getActiveScanId: () => scan });
    p.setTerrainExports(lane);
    p.select('contours');
    p.refresh();
    expect(marked(root)).toEqual(['contours']);
    scan = 'b';
    p.refresh();
    expect(marked(root)).toEqual([]);
    scan = 'a';
    p.refresh();
    expect(marked(root)).toEqual([]);
  });
});

describe('Export panel terrain readiness row', () => {
  it('reads the run once the terrain lane arrives', async () => {
    let analysed = false;
    const { p, root } = await panel({
      exportHealth: () => buildExportHealth({ pointCount: 10, surfaceTier: analysed ? 'Good' : undefined }),
    });
    p.refresh();
    expect(root.textContent).toContain('Not analysed');
    analysed = true;
    p.setTerrainExports(lane);
    expect(root.textContent).not.toContain('Not analysed');
    expect(root.textContent).toContain('Export-ready');
  });
});

describe('Export panel terrain lane refusals', () => {
  const productButton = (root: FakeEl, product: string): FakeEl =>
    root.find((e) => e.dataset.product === product)!.find((e) => e.tagName === 'button')!;
  const hintOf = (root: FakeEl, product: string): string =>
    root.find((e) => e.dataset.product === product)!.find((e) => e.hasClass('olv-export-fullres-hint'))!.textContent;

  it('disables a product that cannot run and says why', async () => {
    const reason = 'No contours at this interval to export.';
    const { p, root } = await panel();
    p.setTerrainExports({
      ready: () => true,
      status: (kind) => (kind === 'contours' ? { ready: false, reason } : { ready: true, reason: '' }),
      run: () => ({ ok: true }),
    });
    const btn = productButton(root, 'contours');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(reason);
    expect(hintOf(root, 'contours')).toBe(reason);
    expect(productButton(root, 'terrain-dem').disabled).toBe(false);
  });

  it('shows the reason when a product refuses at click time', async () => {
    const reason = 'Run a terrain analysis first.';
    const { p, root } = await panel();
    p.setTerrainExports({ ready: () => true, run: () => ({ ok: false, reason }) });
    productButton(root, 'terrain-dem').fire('click');
    expect(hintOf(root, 'terrain-dem')).toBe(reason);
  });

  it('shows the gate reason when a product refuses after it starts', async () => {
    const reason = 'The selected area has too much unsupported surface.';
    const { p, root } = await panel();
    p.setTerrainExports({ ready: () => true, run: () => Promise.resolve({ ok: false, reason }) });
    productButton(root, 'contours').fire('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(hintOf(root, 'contours')).toBe(reason);
  });
});
