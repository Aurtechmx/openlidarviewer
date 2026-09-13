/**
 * exportPanelLedgerGate.test.ts
 *
 * The findings ledger appears under the rule its sibling deliverables use:
 * once a measurement exists, or once the ledger already holds an entry. An
 * empty ledger beside an empty measurement list offered three inert controls.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  value = '';
  checked = false;
  disabled = false;
  readonly style: Record<string, string> = {};
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly classList = {
    _set: new Set<string>(),
    add: (c: string): void => { this.classList._set.add(c); },
    remove: (c: string): void => { this.classList._set.delete(c); },
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c); else this.classList._set.delete(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' '); }
  set innerHTML(_v: string) {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void {}
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: (tag: string) => new FakeEl(tag) };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function panelWith(measurementCount: number) {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    exportMeasurements: async () => {},
    measurementCount: () => measurementCount,
    collectMeasurementFindings: () => [],
    exportFindingsReport: async () => {},
  } as never);
  return panel.element as unknown as FakeEl;
}

describe('ExportPanel findings ledger', () => {
  it('is absent while no measurement has been placed', async () => {
    const root = await panelWith(0);
    expect(root.findByClass('olv-findings-slot')).toHaveLength(0);
    // The sibling deliverables state the same rule in their caption.
    expect(root.textContent).toMatch(/Place measurements, then export them/);
  });

  it('appears once a measurement exists', async () => {
    const root = await panelWith(1);
    expect(root.findByClass('olv-findings-slot')).toHaveLength(1);
  });
});
