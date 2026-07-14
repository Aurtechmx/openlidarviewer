/**
 * analysePanelReportButton.test.ts
 *
 * v0.5.9 architecture: the contour / DEM / map / report export buttons no longer
 * live in the always-visible AnalysePanel flow. They are built as DETACHED
 * backing actions and surfaced through the Contour Studio workspace (mounted
 * lazily after analysis), which dispatches to them. This test locks that move:
 * the raw export buttons must NOT appear in the static panel tree, and the panel
 * must lead with the Terrain Products surface instead. Runs in the node
 * environment via a small recording DOM stub.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  href = '';
  download = '';
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
  /** Recursively collect every descendant whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
  /** True when any descendant (or this node) carries `cls` in its className. */
  hasClass(cls: string): boolean {
    if (this.className.split(/\s+/).includes(cls)) return true;
    return this.children.some((c) => c.hasClass(cls));
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('AnalysePanel — export area (Contour Studio architecture)', () => {
  it('does not mount the raw contour / DEM / map / report export buttons in the panel tree', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as FakeEl;
    // These moved out of the always-visible flow: the panel builds them only as
    // detached backing actions the Contour Studio workspace dispatches to, so
    // none must appear in the static panel tree.
    expect(root.findByText('Intelligence report (PDF)').length).toBe(0);
    expect(root.findByText('DEM (ZIP)').length).toBe(0);
    expect(root.findByText('Export Contours').length).toBe(0);
    expect(root.findByText('GEOJSON').length).toBe(0);
  });

  it('leads the results with the Terrain Products surface (launcher + gated deliverable)', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as FakeEl;
    // The Contour Studio launcher slot + gated deliverable container exist even
    // before analysis (the workspace mounts into them lazily on a result).
    expect(root.hasClass('olv-analyse-products')).toBe(true);
    expect(root.hasClass('olv-analyse-contour-launcher')).toBe(true);
    expect(root.hasClass('olv-analyse-contour-deliverable')).toBe(true);
  });
});
