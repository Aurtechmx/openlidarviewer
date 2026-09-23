/**
 * exportPanelWrapPreviewLoadFailure.test.ts
 *
 * `ExportPanel`'s LAS 1.2 class-wrap preview is fetched lazily
 * (`loadLegacyClassGuard`, kept out of the eager shell — the class tables it
 * carries name every ASPRS code). A chunk-load failure used to reset the
 * retry flag and stop there: no re-render, so the row stayed on whatever it
 * showed before the click until an unrelated re-render happened to run
 * `_legacyClassWrap` again. This pins the fix — the failure re-renders the
 * summary immediately, with an honest "could not load" line instead of a
 * stale or blank one — by forcing `loadLegacyClassGuard` to reject. Node
 * environment via a recording DOM stub (same shape as
 * exportPanelLegacyClassWrap.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';

const rec = vi.hoisted(() => ({ attempts: 0 }));

vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // Always fails — deterministic, so the test can pin the failure state
  // without racing a later successful retry.
  loadLegacyClassGuard: () => {
    rec.attempts++;
    return Promise.reject(new Error('chunk failed to load'));
  },
}));

class FakeEl {
  className = '';
  title = '';
  type = '';
  checked = false;
  disabled = false;
  readonly style: Record<string, string> = {};
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
  rec.attempts = 0;
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

function pickFormat(root: FakeEl, label: string): void {
  const pill = root.findByClass('olv-bc-pill').find((p) => p.textContent === label);
  expect(pill, `format pill ${label} missing`).toBeDefined();
  pill!.fire('click');
}

function checkRow(root: FakeEl, text: string): FakeEl | undefined {
  return root.findByClass('olv-export-fullres').find((r) => r.textContent.includes(text));
}

const note = (root: FakeEl): FakeEl => root.findByClass('olv-export-summary-note')[0];

async function panelFor(display: PointCloud): Promise<FakeEl> {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => display,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
  });
  return panel.element as unknown as FakeEl;
}

/** Let the mocked (rejecting) fetch's microtasks settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('ExportPanel — LAS 1.2 class-wrap preview, chunk-load failure', () => {
  it('re-renders immediately with an honest "could not load" line, not a stale or blank one', async () => {
    const { WRAP_PREVIEW_LOAD_FAILED } = await import('../src/ui/ExportPanel');
    const root = await panelFor(cloud([2, 64, 200]));

    pickFormat(root, 'LAS 1.2');
    // Before the fetch settles the row says nothing yet — same as a real load
    // in flight.
    expect(note(root).textContent).toBe('');

    await settle();

    expect(note(root).textContent).toBe(WRAP_PREVIEW_LOAD_FAILED);
    expect(note(root).className).toContain('is-warn');
    // The checkbox itself is unaffected by the preview failing to load — the
    // write gate still enforces the rule at Export regardless.
    expect(checkRow(root, 'Allow classes above 31 to wrap')?.hidden).toBe(false);
    expect(rec.attempts).toBe(1);

    // A later, unrelated re-render is what retries — not the failure's own
    // render, which would spin forever against a chunk that keeps failing.
    pickFormat(root, 'LAS 1.2');
    await settle();
    expect(rec.attempts).toBe(2);
    expect(note(root).textContent).toBe(WRAP_PREVIEW_LOAD_FAILED);
  });
});
