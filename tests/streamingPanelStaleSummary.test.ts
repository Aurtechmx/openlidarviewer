/**
 * streamingPanelStaleSummary.test.ts
 *
 * The StreamingPanel's Scan section belongs to the scan currently streaming.
 *
 * Two ways it stopped doing that. `hide()` reset the pause button, the progress
 * bar and the grade affordance but left the title and the summary rows alone,
 * so closing a scan and opening the next one showed the closed scan's File,
 * Format, Source, Extent and Octree until a new `setSummary` overwrote them.
 * And `setSummary` decided its title from a two-way branch — EPT or COPC — so a
 * third streaming format fell through to "Streaming COPC" and a "COPC LAZ ·
 * PDRF undefined" Format row.
 *
 * Same recording DOM stub the other panel tests use (FakeEl), so the render
 * tree is pinned in the node environment without a browser.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    _set: new Set<string>(),
    add(c: string): void { this._set.add(c); },
    remove(c: string): void { this._set.delete(c); },
    toggle(c: string): void { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    contains(c: string): boolean { return this._set.has(c); },
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
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids.filter(Boolean)); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** First descendant whose own text contains `substr`, or undefined. */
  findContaining(substr: string): FakeEl | undefined {
    if (this._text.includes(substr)) return this;
    for (const c of this.children) {
      const hit = c.findContaining(substr);
      if (hit) return hit;
    }
    return undefined;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

function noopCallbacks() {
  return {
    onColorMode() {}, onQuality() {}, onPauseToggle() {}, onClearCache() {},
    onGradeFullCloud() {}, onCancelGrade() {},
  };
}

const COPC_SUMMARY = {
  fileName: 'autzen.copc.laz',
  pointFormat: 6,
  sourcePoints: 10_653_336,
  width: 620.5,
  depth: 480.2,
  height: 63.7,
  spacing: 2.5,
  octreeDepth: 5,
  nodeCount: 141,
  format: 'copc' as const,
};

const TILESET_SUMMARY = {
  fileName: 'tileset.json',
  pointFormat: -1,
  sourcePoints: null,
  width: 120,
  depth: 90,
  height: 14,
  octreeDepth: 3,
  nodeCount: 27,
  format: '3dtiles' as const,
};

async function panelWith(summary: Parameters<
  Awaited<typeof import('../src/ui/StreamingPanel')>['StreamingPanel']['prototype']['setSummary']
>[0]) {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const panel = new StreamingPanel(noopCallbacks());
  panel.setSummary(summary);
  return { panel, root: panel.element as unknown as FakeEl };
}

describe('hide() drops the closed scan', () => {
  it('clears the summary rows so the next scan cannot inherit them', async () => {
    const { panel, root } = await panelWith(COPC_SUMMARY);
    expect(root.findContaining('autzen.copc.laz')).toBeDefined();
    panel.hide();
    expect(
      root.findContaining('autzen.copc.laz'),
      "the closed scan's File row survives into the next open",
    ).toBeUndefined();
    expect(root.findContaining('10,653,336')).toBeUndefined();
  });

  it('returns the title to the format-neutral one', async () => {
    const { panel, root } = await panelWith(COPC_SUMMARY);
    expect(root.findContaining('Streaming COPC')).toBeDefined();
    panel.hide();
    expect(root.findContaining('Streaming COPC')).toBeUndefined();
    expect(root.findContaining('Streaming scan')).toBeDefined();
  });
});

describe('a 3D Tiles summary states 3D Tiles', () => {
  it('titles the card for the format that is actually streaming', async () => {
    const { root } = await panelWith(TILESET_SUMMARY);
    expect(root.findContaining('Streaming 3D Tiles')).toBeDefined();
    expect(root.findContaining('Streaming COPC')).toBeUndefined();
  });

  it('never renders a LAS point-data record format for a format that has none', async () => {
    const { root } = await panelWith(TILESET_SUMMARY);
    expect(root.findContaining('PDRF')).toBeUndefined();
    expect(root.findContaining('3D Tiles')).toBeDefined();
  });

  it('says the point total is absent rather than printing one', async () => {
    const { root } = await panelWith(TILESET_SUMMARY);
    expect(root.findContaining('Unknown from source metadata')).toBeDefined();
  });

  it('omits the spacing row the format does not state', async () => {
    // COPC declares a root-node spacing and EPT a node budget. 3D Tiles states
    // neither, and a dash row would only be a place for a future number to
    // appear from nowhere.
    const { root } = await panelWith(TILESET_SUMMARY);
    expect(root.findContaining('Spacing')).toBeUndefined();
    expect(root.findContaining('Node budget')).toBeUndefined();
    // The rows it does state are still there.
    expect(root.findContaining('depth 3 · 27 nodes')).toBeDefined();
  });

  it('replaces a previous scan’s rows rather than appending to them', async () => {
    const { panel, root } = await panelWith(COPC_SUMMARY);
    panel.setSummary(TILESET_SUMMARY);
    expect(root.findContaining('autzen.copc.laz')).toBeUndefined();
    expect(root.findContaining('tileset.json')).toBeDefined();
  });
});
