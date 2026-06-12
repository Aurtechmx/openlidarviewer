/**
 * analysePanelReportButton.test.ts
 *
 * The Analyse panel's export area exposes the one-click "Intelligence report
 * (PDF)" button. Runs in the node environment via a small recording DOM stub
 * (same style as objectPanelExport.test.ts) — it asserts the button is present
 * in the rendered tree, distinct from the contour / DEM / map exports.
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
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('AnalysePanel — export area', () => {
  it('exposes the Intelligence report (PDF) button', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Intelligence report (PDF)').length).toBe(1);
  });

  it('keeps the report button distinct from the contour / DEM / map exports', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as FakeEl;
    // The other export actions are still present alongside the report button.
    expect(root.findByText('DEM (ZIP)').length).toBe(1);
    expect(root.findByText('Export Contours').length).toBe(1);
    expect(root.findByText('Intelligence report (PDF)').length).toBe(1);
  });
});
