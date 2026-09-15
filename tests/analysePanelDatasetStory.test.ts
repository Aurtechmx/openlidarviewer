/**
 * analysePanelDatasetStory.test.ts
 *
 * The Dataset Story used to be reachable only through a command-palette modal,
 * so the fitness read that decides what a scan may be used for was invisible to
 * anyone who did not know the action existed. The Analyse panel now hosts it as
 * a collapsible section at the top of the panel.
 *
 * The properties pinned here: the host slot exists before any story is set, the
 * card mounts inside a disclosure rather than a modal, a second call replaces
 * the card instead of stacking one, and null clears the section entirely.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  href = '';
  download = '';
  open = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add(): void { /* no-op */ },
    remove(): void { /* no-op */ },
    toggle(): void { /* no-op */ },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** The first descendant (or this node) carrying `cls`. */
  find(cls: string): FakeEl | null {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return null;
  }
  /** Every tag name in the subtree. */
  tags(): string[] {
    return [this.tagName, ...this.children.flatMap((c) => c.tags())];
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

const { AnalysePanel } = await import('../src/ui/AnalysePanel');

function panel(): { panel: InstanceType<typeof AnalysePanel>; root: FakeEl } {
  const p = new AnalysePanel({});
  return { panel: p, root: p.element as unknown as FakeEl };
}

describe('the Analyse panel hosts the Dataset Story', () => {
  it('keeps an empty slot for it above the run control', () => {
    const { root } = panel();
    const host = root.find('olv-analyse-story');
    expect(host).not.toBeNull();
    expect(host!.children).toHaveLength(0);
    const order = root.children.map((c) => c.className);
    expect(order.indexOf('olv-analyse-story')).toBeLessThan(
      order.findIndex((c) => c.includes('olv-analyse-run')),
    );
  });

  it('mounts the card in a disclosure, not a modal', () => {
    const { panel: p, root } = panel();
    const card = new FakeEl('aside');
    card.className = 'olv-story-card';
    card.textContent = 'Dataset Story';
    p.setDatasetStory(card as unknown as HTMLElement);
    const host = root.find('olv-analyse-story')!;
    expect(host.children).toHaveLength(1);
    expect(host.children[0].tagName).toBe('details');
    expect(host.children[0].open).toBe(false);
    expect(host.textContent).toContain('Dataset Story');
    expect(root.tags()).not.toContain('dialog');
  });

  it('replaces the card rather than stacking a second one', () => {
    const { panel: p, root } = panel();
    const a = new FakeEl('aside'); a.textContent = 'first';
    const b = new FakeEl('aside'); b.textContent = 'second';
    p.setDatasetStory(a as unknown as HTMLElement);
    p.setDatasetStory(b as unknown as HTMLElement);
    const host = root.find('olv-analyse-story')!;
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toContain('second');
    expect(host.textContent).not.toContain('first');
  });

  it('clears the section when there is no story to tell', () => {
    const { panel: p, root } = panel();
    const a = new FakeEl('aside'); a.textContent = 'first';
    p.setDatasetStory(a as unknown as HTMLElement);
    p.setDatasetStory(null);
    expect(root.find('olv-analyse-story')!.children).toHaveLength(0);
  });
});
