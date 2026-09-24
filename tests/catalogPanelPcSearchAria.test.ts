/**
 * catalogPanelPcSearchAria.test.ts
 *
 * The "Search by location (Planetary Computer)" disclosure's own status line
 * (distinct from the curated-dropdown `_status` field catalogPanelStatus.test
 * covers) carried no role/aria-live, so a screen reader announced nothing at
 * the start, empty-result, or error stage of a PC search (v0.7 audit, finding
 * INTAKE-F3). Pins that the PC-search status node is wired as a
 * role="status" aria-live="polite" live region from construction, and that
 * every message `_runPcSearch` writes into it — the empty-input guard
 * messages fired synchronously on submit — lands inside that live node.
 *
 * Runs in the node environment via the same recording DOM stub
 * catalogPanelStatus.test.ts uses (FakeEl records `setAttribute` into
 * `.attrs`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { makeFakeClassList } from './helpers/fakeClassList';

type Listener = (event: unknown) => void;

class FakeEl {
  className = '';
  title = '';
  type = '';
  href = '';
  value = '';
  disabled = false;
  selected = false;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private _text = '';
  private readonly _listeners = new Map<string, Listener[]>();
  readonly tagName: string;
  readonly classList = makeFakeClassList();

  constructor(tagName: string) { this.tagName = tagName; }

  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  get ownText(): string { return this._text; }
  set innerHTML(_v: string) { /* unused */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  append(...kids: (FakeEl | string)[]): void {
    for (const k of kids) if (typeof k !== 'string') this.children.push(k);
  }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  remove(): void { /* detach no-op */ }
  addEventListener(type: string, cb: Listener): void {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(cb);
  }
  fire(type: string, event: unknown = { preventDefault(): void {} }): void {
    this._listeners.get(type)?.forEach((cb) => cb(event));
  }
  /** Every descendant (incl. self) carrying `cls`, in tree order. */
  allByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.allByClass(cls));
    return out;
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

async function makePanel() {
  const { CatalogPanel } = await import('../src/ui/CatalogPanel');
  const panel = new CatalogPanel({ onPickUrl: () => {} });
  const root = panel.root as unknown as FakeEl;
  // Two nodes carry `olv-catalog-status`: the curated-dropdown one (mounted
  // first) and the PC-search disclosure's own one (mounted second, inside
  // the `<details>` `_buildPcSearch` returns). Distinguish by position, not
  // by adding a new class, so the fix stays a two-line attribute change.
  const [curatedStatus, pcStatus] = root.allByClass('olv-catalog-status');
  const pcForm = root.allByClass('olv-catalog-form')[1];
  return { panel, root, curatedStatus, pcStatus, pcForm };
}

describe('CatalogPanel — PC-search status is a live region (INTAKE-F3)', () => {
  it('the PC-search status node exists and is distinct from the curated one', async () => {
    const { curatedStatus, pcStatus } = await makePanel();
    expect(curatedStatus).toBeDefined();
    expect(pcStatus).toBeDefined();
    expect(pcStatus).not.toBe(curatedStatus);
  });

  it('carries role="status" aria-live="polite" from construction', async () => {
    const { pcStatus } = await makePanel();
    expect(pcStatus.attrs['role']).toBe('status');
    expect(pcStatus.attrs['aria-live']).toBe('polite');
  });

  it('the curated-dropdown status is unaffected (still no PC-search live-region wiring bleeding onto it)', async () => {
    const { curatedStatus } = await makePanel();
    // Untouched by this fix — INTAKE-F3 is scoped to the PC-search node only.
    expect(curatedStatus.attrs['role']).toBeUndefined();
    expect(curatedStatus.attrs['aria-live']).toBeUndefined();
  });

  it('a non-numeric coordinate submit writes its guard message into the live PC-search status', async () => {
    const { pcStatus, pcForm } = await makePanel();
    pcForm.fire('submit');
    expect(pcStatus.ownText).toBe('Enter a numeric latitude and longitude.');
    expect(pcStatus.attrs['role']).toBe('status');
    expect(pcStatus.attrs['aria-live']).toBe('polite');
  });

  it('an out-of-range coordinate submit writes its guard message into the live PC-search status', async () => {
    const { root, pcStatus, pcForm } = await makePanel();
    const [latInput, lonInput] = root.allByClass('olv-catalog-input');
    latInput.value = '95';
    lonInput.value = '0';
    pcForm.fire('submit');
    expect(pcStatus.ownText).toBe('Latitude must be -90..90 and longitude -180..180.');
    expect(pcStatus.attrs['role']).toBe('status');
    expect(pcStatus.attrs['aria-live']).toBe('polite');
  });
});
