/**
 * catalogPanelStatus.test.ts
 *
 * v0.5.7 Gate 10: unit coverage for the CatalogPanel status transitions that
 * used to be exercised only through the browser suite. CatalogPanel is DOM-only
 * (no GPU / three import), so it builds under the recording DOM stub the other
 * panel tests use, in the node environment.
 *
 * The status element (`.olv-catalog-status`) carries three visual states via two
 * classes:
 *   - idle/info  : no class, text cleared;
 *   - opening    : `is-opening`, "Opening <name>…" (set when a curated dataset
 *                  is submitted);
 *   - error      : `is-error`, the failure message (set by `showOpenError`).
 * `markLoaded()` returns it to idle. This pins each transition and that the
 * classes are mutually exclusive (a later state clears the earlier one).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { CURATED_LOCATIONS } from '../src/io/catalog/curatedLocations';

type Listener = (event: unknown) => void;

/** A recording DOM element supporting the surface CatalogPanel + `el()` touch. */
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

  constructor(tagName: string) { this.tagName = tagName; }

  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** Direct text only (not descendants) — for asserting a node's own label. */
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
  /** Test helper: invoke listeners registered for `type`. */
  fire(type: string, event: unknown = { preventDefault(): void {} }): void {
    this._listeners.get(type)?.forEach((cb) => cb(event));
  }
  /** First descendant (incl. self) carrying `cls`. */
  byClass(cls: string): FakeEl | undefined {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const c of this.children) {
      const hit = c.byClass(cls);
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
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function makePanel(onPickUrl: (url: string, name: string) => void = () => {}) {
  const { CatalogPanel } = await import('../src/ui/CatalogPanel');
  const panel = new CatalogPanel({ onPickUrl });
  const root = panel.root as unknown as FakeEl;
  const status = root.byClass('olv-catalog-status')!;
  return { panel, root, status };
}

describe('CatalogPanel — status transitions', () => {
  it('starts idle: status text empty, neither state class set', async () => {
    const { status } = await makePanel();
    expect(status).toBeDefined();
    expect(status.ownText).toBe('');
    expect(status.classList.contains('is-opening')).toBe(false);
    expect(status.classList.contains('is-error')).toBe(false);
  });

  it('showOpenError sets the message and the error class only', async () => {
    const { panel, status } = await makePanel();
    panel.showOpenError('Remote host refused the connection.');
    expect(status.ownText).toBe('Remote host refused the connection.');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(status.classList.contains('is-opening')).toBe(false);
  });

  it('markLoaded clears the text and both state classes', async () => {
    const { panel, status } = await makePanel();
    panel.showOpenError('boom');
    panel.markLoaded();
    expect(status.ownText).toBe('');
    expect(status.classList.contains('is-error')).toBe(false);
    expect(status.classList.contains('is-opening')).toBe(false);
  });

  it('submitting a curated dataset enters the opening state and hands off the URL', async () => {
    const picks: Array<[string, string]> = [];
    const loc = CURATED_LOCATIONS[0];
    const { root, status } = await makePanel((url, name) => picks.push([url, name]));

    const select = root.byClass('olv-catalog-select')!;
    select.value = loc.id;
    const form = root.byClass('olv-catalog-form')!;
    form.fire('submit');

    expect(status.ownText).toBe(`Opening ${loc.displayName}…`);
    expect(status.classList.contains('is-opening')).toBe(true);
    expect(status.classList.contains('is-error')).toBe(false);
    expect(picks).toEqual([[loc.streamUrl, loc.displayName]]);
  });

  it('opening then loaded then error are mutually exclusive states', async () => {
    const loc = CURATED_LOCATIONS[0];
    const { panel, root, status } = await makePanel();

    // opening
    (root.byClass('olv-catalog-select')!).value = loc.id;
    root.byClass('olv-catalog-form')!.fire('submit');
    expect(status.classList.contains('is-opening')).toBe(true);

    // loaded clears opening
    panel.markLoaded();
    expect(status.classList.contains('is-opening')).toBe(false);
    expect(status.ownText).toBe('');

    // error sets only error
    panel.showOpenError('later failure');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(status.classList.contains('is-opening')).toBe(false);
  });

  it('submitting with no dataset picked prompts instead of opening', async () => {
    const picks: string[] = [];
    const { root, status } = await makePanel((url) => picks.push(url));
    // Leave the select on its empty placeholder value.
    root.byClass('olv-catalog-form')!.fire('submit');
    expect(status.classList.contains('is-opening')).toBe(false);
    expect(status.ownText).toMatch(/pick a dataset/i);
    expect(picks).toEqual([]);
  });
});
