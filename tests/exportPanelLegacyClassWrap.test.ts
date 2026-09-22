/**
 * exportPanelLegacyClassWrap.test.ts
 *
 * The Export panel's LAS 1.2 path when the cloud carries classes above 31.
 * The write gate in `convertCloud` refuses such a file unless the request opts
 * in, because each wrapped class lands on another valid class and the file
 * reads back without an error. These tests drive the panel with the REAL
 * converter and pin what the user sees: a blocked export with the reason, the
 * two ways forward it names (LAS 1.4, or the opt-in checkbox), the same
 * sentence in the live preview before the click, and a written file once the
 * opt-in is ticked. Node environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { LEGACY_CLASS_WRAP_OPT_IN } from '../src/convert/types';
import { legacyClassWrapRefusal, legacyClassWrapWarning } from '../src/convert/legacyClassGuard';

const hoisted = vi.hoisted(() => ({
  /** Filenames and bytes that reached the browser download helper. */
  downloads: [] as { name: string; bytes: Uint8Array }[],
}));

vi.mock('../src/io/download', () => ({
  downloadBytes: (name: string, bytes: Uint8Array) => { hoisted.downloads.push({ name, bytes }); },
  triggerDownload: () => { /* unused here */ },
}));

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
  readonly dataset: Record<string, string> = {};
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly _listeners: Record<string, (() => void)[]> = {};
  readonly classList = {
    _set: new Set<string>(),
    add: (c: string): void => { this.classList._set.add(c); },
    remove: (c: string): void => { this.classList._set.delete(c); },
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c);
      else this.classList._set.delete(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* icons only */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: () => void): void {
    (this._listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (const fn of this._listeners[type] ?? []) fn();
  }
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
  /** Hidden by the global utility class, however it was applied. */
  get hidden(): boolean {
    return this.classList.contains('olv-hidden') || this.className.split(/\s+/).includes('olv-hidden');
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

beforeEach(() => {
  hoisted.downloads.length = 0;
});

function cloud(classes: number[], name = 'survey.las'): PointCloud {
  return new PointCloud({
    positions: new Float32Array(classes.length * 3).map((_, i) => i),
    origin: [500000, 4100000, 0],
    classification: Uint8Array.from(classes),
    sourceFormat: 'las',
    name,
  });
}

/** Click the format pill whose label is exactly `label`. */
function pickFormat(root: FakeEl, label: string): void {
  const pill = root.findByClass('olv-bc-pill').find((p) => p.textContent === label);
  expect(pill, `format pill ${label} missing`).toBeDefined();
  pill!.fire('click');
}

/** The checkbox row whose label reads `text`. */
function checkRow(root: FakeEl, text: string): FakeEl | undefined {
  return root.findByClass('olv-export-fullres').find((r) => r.textContent.includes(text));
}

function setCheckbox(root: FakeEl, text: string, on: boolean): void {
  const label = root.findByClass('olv-export-fullres-label').find((l) => l.textContent.includes(text));
  expect(label, `checkbox "${text}" missing`).toBeDefined();
  const box = label!.children[0];
  box.checked = on;
  box.fire('change');
}

/**
 * Let the preview's lazily loaded guard arrive and the panel render again. The
 * module is imported here first so the panel's own import resolves from cache.
 */
const settle = async (): Promise<void> => {
  await import('../src/convert/legacyClassGuard');
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Press Export and wait until the run has set its outcome in the status line. */
async function pressExport(root: FakeEl): Promise<void> {
  const before = root.findByClass('olv-export-status')[0].textContent;
  root.findByClass('olv-export-btn')[0].fire('click');
  // The first run imports the real converter, which takes longer than a tick.
  await vi.waitFor(() => {
    expect(root.findByClass('olv-export-status')[0].textContent).not.toBe(before);
    expect(root.findByClass('olv-export-btn')[0].textContent).toBe('Export');
  }, { timeout: 5000 });
}

const status = (root: FakeEl): FakeEl => root.findByClass('olv-export-status')[0];
const note = (root: FakeEl): FakeEl => root.findByClass('olv-export-summary-note')[0];

async function panelFor(display: PointCloud, extra: Record<string, unknown> = {}) {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => display,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    ...extra,
  });
  return panel.element as unknown as FakeEl;
}

describe('ExportPanel — LAS 1.2 with classes above 31', () => {
  it('blocks the export and gives the reason, naming LAS 1.4 and the opt-in', async () => {
    const root = await panelFor(cloud([2, 64, 64, 33]));
    pickFormat(root, 'LAS 1.2');
    await pressExport(root);

    expect(hoisted.downloads, 'a wrapped file was written').toEqual([]);
    const refusal = legacyClassWrapRefusal({ points: 3, codes: [33, 64] });
    expect(status(root).textContent).toBe(refusal);
    expect(status(root).className).toContain('is-error');
    expect(refusal).toContain('LAS 1.4');
    expect(refusal).toContain(LEGACY_CLASS_WRAP_OPT_IN);
    // The control the message names is on screen.
    expect(checkRow(root, LEGACY_CLASS_WRAP_OPT_IN)?.hidden).toBe(false);
  });

  it('previews the same refusal before the click', async () => {
    const root = await panelFor(cloud([2, 64, 64, 33]));
    pickFormat(root, 'LAS 1.2');
    await settle(); // the preview's class tables load lazily, then it re-renders
    expect(note(root).textContent).toBe(legacyClassWrapRefusal({ points: 3, codes: [33, 64] }));
    expect(note(root).className).toContain('is-error');
  });

  it('writes the file once the opt-in is ticked, and reports the wrap as a warning', async () => {
    const root = await panelFor(cloud([2, 64]));
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_CLASS_WRAP_OPT_IN, true);
    await settle();
    expect(note(root).className).toContain('is-warn');
    await pressExport(root);

    expect(hoisted.downloads.map((d) => d.name)).toEqual(['survey.las']);
    expect(status(root).textContent).toBe(legacyClassWrapWarning(1));
    expect(status(root).className).toContain('is-warn');
  });

  it('choosing LAS 1.4 writes the full classes with no opt-in', async () => {
    const root = await panelFor(cloud([2, 64]));
    pickFormat(root, 'LAS 1.2');
    pickFormat(root, 'LAS 1.4');
    await pressExport(root);
    expect(hoisted.downloads.length).toBe(1);
    expect(status(root).className).not.toContain('is-error');
  });

  it('refuses at full resolution when only the re-decoded file carries the codes', async () => {
    // The display subsample has no class above 31, so the preview is silent;
    // the write gate reads the file that is actually converted.
    const full = cloud([2, 6, 200]);
    const root = await panelFor(cloud([2, 6]), {
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => full,
      getActiveScanId: () => 'scan-a',
    });
    setCheckbox(root, 'Convert at full resolution', true);
    pickFormat(root, 'LAS 1.2');
    await pressExport(root);

    expect(hoisted.downloads).toEqual([]);
    expect(status(root).textContent).toBe(legacyClassWrapRefusal({ points: 1, codes: [200] }));
  });
});

describe('ExportPanel — LAS 1.2 whose classes all fit', () => {
  it('exports as before and the preview says nothing about wrapping', async () => {
    const root = await panelFor(cloud([0, 2, 6, 31]));
    pickFormat(root, 'LAS 1.2');
    await settle();
    expect(note(root).textContent).not.toMatch(/wrap|above 31|5-bit|5 bits|clamp/i);
    await pressExport(root);
    expect(hoisted.downloads.length).toBe(1);
    expect(status(root).className).not.toContain('is-error');
  });
});

describe('ExportPanel — the opt-in row', () => {
  it('shows only while LAS 1.2 would write a classification', async () => {
    const root = await panelFor(cloud([2, 64]));
    const row = (): FakeEl | undefined => checkRow(root, LEGACY_CLASS_WRAP_OPT_IN);
    expect(row(), 'the opt-in row is missing').toBeDefined();
    expect(row()!.hidden, 'shown for the default LAS 1.4').toBe(true);
    pickFormat(root, 'LAS 1.2');
    expect(row()!.hidden).toBe(false);
    setCheckbox(root, 'Include classification', false);
    expect(row()!.hidden, 'shown with the classification omitted').toBe(true);
  });

  it('stays hidden for a cloud with no classification', async () => {
    const plain = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'plain.las',
    });
    const root = await panelFor(plain);
    pickFormat(root, 'LAS 1.2');
    expect(checkRow(root, LEGACY_CLASS_WRAP_OPT_IN)!.hidden).toBe(true);
  });
});

describe('exportClassFacts', () => {
  it('hands the host the class buffer by reference with its provenance', async () => {
    const { exportClassFacts } = await import('../src/ui/ExportPanel');
    const c = cloud([2, 64]);
    const facts = exportClassFacts(c);
    expect(facts.classProvenance).toBe('source');
    expect(facts.classification).toBe(c.classification);
  });
});
