/**
 * The Export panel's saved-findings mount survives a chunk that fails to load
 * (offline, or a defaulted-out stale chunk that resolves undefined): it says
 * so in the slot, and Try again mounts the panel once the chunk loads.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { waitForCondition } from './helpers/waitForCondition';
import { FakeEl } from './helpers/exportPanelPillDomFake';

const cap = vi.hoisted(() => ({ calls: 0, mode: 'undefined' as 'undefined' | 'reject' | 'ok', built: 0 }));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadFindingsPanel: async () => {
    cap.calls++;
    if (cap.mode === 'undefined') return undefined;
    if (cap.mode === 'reject') throw new TypeError('Failed to fetch dynamically imported module: http://x/assets/findingsPanel-abc.js');
    return {
      buildFindingsPanel: () => {
        cap.built++;
        return { element: new FakeEl('div'), refresh: () => {} };
      },
    };
  },
}));

class ClickEl extends FakeEl {
  private _handlers: Array<() => void> = [];
  parent: ClickEl | null = null;
  override addEventListener(type?: string, handler?: () => void): void {
    if (type === 'click' && handler) this._handlers.push(handler);
  }
  override append(...kids: FakeEl[]): void {
    for (const k of kids) if (k instanceof ClickEl) k.parent = this;
    super.append(...kids);
  }
  click(): void {
    for (const h of this._handlers) h();
  }
  remove(): void {
    const sib = this.parent?.children;
    if (sib) sib.splice(sib.indexOf(this), 1);
  }
  find(pred: (e: FakeEl) => boolean): ClickEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c instanceof ClickEl ? c.find(pred) : null;
      if (hit) return hit;
    }
    return null;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ClickEl(tag),
    createElementNS: (_ns: string, tag: string) => new ClickEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

const failNote = (root: ClickEl): ClickEl | null => root.find((e) => e.className.includes('olv-findings-load-failed'));

describe('ExportPanel saved findings when the chunk fails to load', () => {
  for (const mode of ['undefined', 'reject'] as const) {
    it(`shows a retry note when the import ${mode === 'undefined' ? 'resolves undefined' : 'rejects'}, and Try again mounts it`, async () => {
      cap.calls = 0;
      cap.built = 0;
      cap.mode = mode;
      const { ExportPanel } = await import('../src/ui/ExportPanel');
      const panel = new ExportPanel({
        getCloud: () => null,
        hasFullSource: () => false,
        isReduced: () => false,
        getFullCloud: async () => null,
        exportMeasurements: async () => {},
        measurementCount: () => 1,
        activeFindingsTargetId: () => 'scan-A',
        collectMeasurementFindings: async () => [],
        exportFindingsReport: async () => 'downloaded',
      } as never);
      const root = panel.element as unknown as ClickEl;
      await waitForCondition(() => failNote(root) !== null, () => 'no failure note after the import failed');
      expect(cap.built).toBe(0);
      const retry = failNote(root)!.find((e) => e.tagName === 'button');
      expect(retry).not.toBeNull();
      cap.mode = 'ok';
      retry!.click();
      await waitForCondition(() => cap.built === 1, () => 'Try again did not mount the findings panel');
      expect(failNote(root)).toBeNull();
      expect(cap.calls).toBe(2);
    });
  }
});
