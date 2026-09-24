/**
 * tests/helpers/catalogPanelDomFake.ts
 *
 * The recording DOM node catalogPanelStatus.test.ts and
 * catalogPanelPcSearchAria.test.ts both drive CatalogPanel against:
 * `setAttribute` records into `.attrs` (so a11y attributes can be asserted),
 * `fire()` replays a registered listener, `byClass` finds the first match
 * and `allByClass` every match — the surface CatalogPanel's status/PC-search
 * views touch.
 */

import { makeFakeClassList } from './fakeClassList';

export type Listener = (event: unknown) => void;

export class FakeEl {
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

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** Direct text only (not descendants) — for asserting a node's own label. */
  get ownText(): string {
    return this._text;
  }
  set innerHTML(_v: string) {
    /* unused */
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  append(...kids: (FakeEl | string)[]): void {
    for (const k of kids) if (typeof k !== 'string') this.children.push(k);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  remove(): void {
    /* detach no-op */
  }
  addEventListener(type: string, cb: Listener): void {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(cb);
  }
  /** Invoke listeners registered for `type`. */
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
  /** Every descendant (incl. self) carrying `cls`, in tree order. */
  allByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.allByClass(cls));
    return out;
  }
}
