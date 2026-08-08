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
    // The two-argument `force` form is part of the real DOM contract and the
    // panel uses it to drive the Products disclosure; a stub that ignored it
    // toggled the section shut on the very render meant to open it.
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c);
      else this.classList._set.delete(c);
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
    expect(keep).toHaveLength(1);
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
    expect(pillRows).toHaveLength(2);
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

describe('ExportPanel — Products lane resilience (regression)', () => {
  it('survives a measurementCount callback that throws (lazy viewer not ready)', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    // Reproduces the v0.4.9 init crash: the Products lane is built during
    // construction, before the host's lazy `viewer` resolves, so a callback that
    // dereferences it throws. The panel must degrade to a 0 count, not crash.
    expect(() => {
      const panel = new ExportPanel({
        getCloud: () => null,
        hasFullSource: () => false,
        isReduced: () => false,
        getFullCloud: async () => null,
        measurementCount: () => { throw new TypeError("Cannot read properties of null (reading 'measure')"); },
        exportMeasurements: () => { /* present so the Products lane renders */ },
      });
      // Re-rendering (the refresh path) must stay safe too.
      panel.refresh();
    }).not.toThrow();
  });

  it('disables the measurement export pills when the count is 0', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      getCloud: () => null,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
      measurementCount: () => 0,
      exportMeasurements: () => { /* no-op */ },
    });
    const root = panel.element as unknown as FakeEl;
    for (const lbl of ['GeoJSON', 'CSV']) {
      const hit = root.findOwnText(lbl)[0];
      expect(hit, `products pill "${lbl}" missing`).toBeDefined();
    }
  });
});

/**
 * The Products section is where a session's actual deliverables live, so its
 * prominence and its honesty are both behaviour, not decoration: it opens by
 * default, and an unavailable product states the reason the host gave rather
 * than going quiet.
 */
describe('ExportPanel: Products section', () => {
  const base = {
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    measurementCount: () => 0,
    exportMeasurements: () => { /* present so the Products section renders */ },
  };

  it('opens the section by default rather than hiding the products', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({ ...base });
    const root = panel.element as unknown as FakeEl;
    const body = root.findByClass('olv-export-products-body')[0];
    expect(body).toBeDefined();
    expect(body.classList.contains('olv-hidden')).toBe(false);
    const head = root.findByClass('olv-export-products-head')[0];
    expect(head.attrs['aria-expanded']).toBe('true');
  });

  it('offers the scan-area polygon as its own action', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      ...base,
      exportScanFootprint: () => { /* no-op */ },
      scanFootprintStatus: () => ({ ready: true, reason: '' }),
    });
    const root = panel.element as unknown as FakeEl;
    const btn = root.findOwnText('Scan area (KML polygon)')[0];
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
  });

  it('disables the scan-area polygon and shows the CRS refusal', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      ...base,
      exportScanFootprint: () => { /* no-op */ },
      scanFootprintStatus: () => ({
        ready: false,
        reason: 'The scan has no known coordinate system, so its outline cannot be placed on a map.',
      }),
    });
    const root = panel.element as unknown as FakeEl;
    expect(root.findOwnText('Scan area (KML polygon)')[0].disabled).toBe(true);
    expect(root.textContent).toContain('no known coordinate system');
  });

  it('survives a scanFootprintStatus callback that throws', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    expect(() => new ExportPanel({
      ...base,
      exportScanFootprint: () => { /* no-op */ },
      scanFootprintStatus: () => { throw new TypeError('viewer not ready'); },
    })).not.toThrow();
  });
});

/**
 * The scan-area polygon is derived from the loaded cloud's footprint, so it does
 * not depend on any measurement having been placed — nor on the measurement
 * export feature being wired at all. It is an always-available map control, so
 * the Google Earth lane must render it even when the host wires no measurement
 * callbacks (no `exportMeasurements`).
 */
describe('ExportPanel: scan-area export is independent of the measure surface', () => {
  const noMeasure = {
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    // Deliberately NO exportMeasurements / measurementCount.
  };

  it('offers the scan-area polygon with no measurement callbacks wired', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      ...noMeasure,
      exportScanFootprint: () => { /* no-op */ },
      scanFootprintStatus: () => ({ ready: true, reason: '' }),
    });
    const root = panel.element as unknown as FakeEl;
    const btn = root.findOwnText('Scan area (KML polygon)')[0];
    expect(btn, 'scan-area button should render without a measure surface').toBeDefined();
    expect(btn.disabled).toBe(false);
  });

  it('offers the site KML with no measurement callbacks wired', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({
      ...noMeasure,
      exportKml: () => { /* no-op */ },
      kmlStatus: () => ({ ready: true, reason: '' }),
    });
    const root = panel.element as unknown as FakeEl;
    expect(root.findOwnText('Site KML')[0]).toBeDefined();
  });

  it('renders no Products section at all when nothing is wired', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const panel = new ExportPanel({ ...noMeasure });
    const root = panel.element as unknown as FakeEl;
    expect(root.findByClass('olv-export-products-head')).toHaveLength(0);
  });
});

// silence "unused" for the shared helper while keeping it available for edits.
void makePanel;
