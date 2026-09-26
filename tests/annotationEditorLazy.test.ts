/**
 * The annotation editor card rides its own chunk (`loadAnnotationEditor`).
 * These pin the lazy path: the first open works without a preload, switching
 * the tool on warms the chunk, the placeholder is swapped for the real card
 * in place, and a failed load leaves a visible hint and a retry.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { FakeEl } from './support/measurePanelDom';

const loadState = { fail: false };

vi.mock('../src/lazyChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lazyChunks')>();
  return {
    ...actual,
    loadAnnotationEditor: vi.fn(() =>
      loadState.fail ? Promise.reject(new Error('chunk fetch failed')) : actual.loadAnnotationEditor(),
    ),
  };
});

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    querySelector: () => null,
    contains: () => true,
    activeElement: null,
  };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.HTMLTextAreaElement = class HTMLTextAreaElement {};
  g.window = { innerWidth: 1280, innerHeight: 800 };
  g.ResizeObserver = FakeResizeObserver;
});

beforeEach(() => {
  loadState.fail = false;
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function controller() {
  const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
  return new AnnotationController();
}

describe('the lazily loaded annotation editor', () => {
  it('opens on the first click with no preload, replacing the placeholder in place', async () => {
    const c = await controller();
    const parent = new FakeEl('div');
    const slot = c.editorElement as unknown as FakeEl;
    parent.appendChild(slot);
    expect(c.isEditing).toBe(false);

    c.beginDraft({ x: 1, y: 2, z: 3 }, 10, 10);
    await vi.waitFor(() => expect(c.isEditing).toBe(true));
    const card = c.editorElement as unknown as FakeEl;
    expect(card).not.toBe(slot);
    expect(card.parent).toBe(parent);
    expect(parent.children).toEqual([card]);
  });

  it('warms the chunk when the tool is switched on, so the next open is synchronous', async () => {
    const c = await controller();
    c.setActive(true);
    await c.ensureEditor(); // the same load setActive started
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(c.isEditing).toBe(true);
  });

  it('says so in the hint when the chunk fails, and retries on the next open', async () => {
    const c = await controller();
    loadState.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    await flush();
    expect(c.isEditing).toBe(false);
    expect((c.hint as unknown as FakeEl).textContent).toContain('could not load');
    warn.mockRestore();

    loadState.fail = false;
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    await vi.waitFor(() => expect(c.isEditing).toBe(true));
  });
});
