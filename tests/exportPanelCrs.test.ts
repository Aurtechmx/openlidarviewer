/**
 * exportPanelCrs.test.ts
 *
 * The Export / Convert panel auto-collapses the Coordinate-System step for an
 * ungeoreferenced (local / unknown) scan: the Keep / Assign EPSG / Reproject
 * pills + label hide and a one-line note shows. A georeferenced scan keeps the
 * step visible. The point-cloud format buttons (LAS / LAZ / XYZ / ASC) are
 * unaffected either way. Runs in the node environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll } from 'vitest';

/** A fake element exposing the surface ExportPanel + `el()` touch. */
class FakeEl {
  className = '';
  title = '';
  type = '';
  href = '';
  value = '';
  placeholder = '';
  inputMode = '';
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
    toggle: (c: string): void => {
      if (this.classList._set.has(c)) this.classList._set.delete(c);
      else this.classList._set.add(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* unused */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  /** Every descendant whose own (direct) text equals `label`. */
  findOwnText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findOwnText(label));
    return out;
  }
  /** Every descendant with the given class. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  // `dom.el()` guards its href/type assignment with `instanceof` checks against
  // these globals; define them so the bare `instanceof` doesn't ReferenceError
  // (our FakeEl never matches, which is fine — the panel sets .type directly).
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function makePanel() {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
  });
  return panel.element as unknown as FakeEl;
}

const isHidden = (e: FakeEl): boolean => e.style.display === 'none';

describe('ExportPanel — CRS step auto-collapse', () => {
  it('CRS known: the Coordinate-system step is visible, note hidden', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      getCloud: () => null,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
    });
    panel.setCrsKnown(true);
    const root = panel.element as unknown as FakeEl;
    const note = root.findByClass('olv-export-crs-note')[0];
    expect(note).toBeDefined();
    expect(isHidden(note)).toBe(true);
    // The three CRS mode pills are present + their container visible.
    const keep = root.findOwnText('Keep');
    expect(keep.length).toBe(1);
    expect(isHidden(keep[0])).toBe(false);
  });

  it('CRS unknown: the step collapses + the local-coords note shows', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      getCloud: () => null,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
    });
    panel.setCrsKnown(false);
    const root = panel.element as unknown as FakeEl;
    const note = root.findByClass('olv-export-crs-note')[0];
    expect(isHidden(note)).toBe(false);
    expect(note.textContent).toMatch(/local coordinates/i);
    // The CRS pills container is hidden (the pills still exist in the DOM tree,
    // but their row carries display:none).
    const pillRows = root.findByClass('olv-bc-pills');
    // [0] = format row (visible), [1] = CRS row (hidden when collapsed).
    expect(pillRows.length).toBe(2);
    expect(isHidden(pillRows[1])).toBe(true);
  });

  it('format buttons (LAS/LAZ/XYZ/ASC) are unaffected by the CRS collapse', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const { CONVERT_FORMATS } = await import('../src/convert/types');
    const labels = Object.values(CONVERT_FORMATS).map((s) => s.label);
    const panel = new ExportPanel({
      getCloud: () => null,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
    });
    const root = panel.element as unknown as FakeEl;
    const formatRow = root.findByClass('olv-bc-pills')[0];
    for (const lbl of labels) {
      const hit = formatRow.findOwnText(lbl);
      expect(hit.length, `format pill "${lbl}" missing`).toBe(1);
    }
    // Collapsing the CRS step leaves the same format pills present + visible.
    panel.setCrsKnown(false);
    expect(isHidden(formatRow)).toBe(false);
    for (const lbl of labels) {
      expect(formatRow.findOwnText(lbl).length, `format pill "${lbl}" lost after collapse`).toBe(1);
    }
  });
});

// silence "unused" for the shared helper while keeping it available for edits.
void makePanel;
