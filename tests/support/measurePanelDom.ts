/**
 * tests/support/measurePanelDom.ts
 *
 * Recording node stub the MeasurePanel tests mount against. Covers only the
 * DOM surface `src/ui/MeasurePanel.ts` touches: class lists, children, string
 * `innerHTML`, attributes, datasets and event handlers.
 *
 * `installFakeDom()` puts the stub on `globalThis` and is safe to call from
 * several suites in one worker.
 */

type Handler = (e: unknown) => void;

/** A recording node covering the surface MeasurePanel and the annotation
 * editor/panel views touch. */
export class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  private _text = '';
  title = '';
  value = '';
  type = '';
  placeholder = '';
  rows = 0;
  maxLength = 0;
  checked = false;
  tabIndex = -1;
  innerHTML = '';
  open = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();
  clientHeight = 0;
  offsetWidth = 0;

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set textContent(v: string) {
    this._text = v;
  }
  /** Aggregated over children, so a strip built from nested spans (the
   * annotation views' pattern) reads as one string. A leaf node with no
   * children behaves exactly like the old flat field. */
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }

  /** DOM's `Node.contains`: true for itself or any descendant, recursively. */
  contains(node: unknown): boolean {
    if (node === this) return true;
    for (const c of this.children) if (c.contains(node)) return true;
    return false;
  }

  get lastElementChild(): FakeEl | null {
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i].tagName !== '#text') return this.children[i];
    }
    return null;
  }

  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) {
      kid.parent = this;
      return kid;
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return t;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(this._adopt(k));
  }
  appendChild(kid: unknown): unknown {
    this.children.push(this._adopt(kid));
    return kid;
  }
  /** DOM's `insertBefore`: `ref === null` inserts at the end, matching the spec. */
  insertBefore(kid: unknown, ref: FakeEl | null): FakeEl {
    const node = this._adopt(kid);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node as unknown as FakeEl;
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  /** DOM's `Element.remove`: detach this node from its parent, if any. */
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }

  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {
    /* not exercised */
  }
  dispatchEvent(evt: { type: string }): boolean {
    for (const fn of this.handlers.get(evt.type) ?? []) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}
  select(): void {}
  /** Fire the registered click handlers — how DOM tests activate a control.
   * Carries no-op stopPropagation/preventDefault so a handler that calls
   * either (the annotation editor's collapse toggle does) does not throw. */
  click(): void {
    for (const fn of this.handlers.get('click') ?? [])
      fn({
        type: 'click',
        clientX: 0,
        clientY: 0,
        stopPropagation: () => {},
        preventDefault: () => {},
      });
  }

  /** `tag`, `.class`, or `tag.class` — the only selector shapes this panel uses. */
  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/** No-op observer so the panel's resize-persistence path never fires. */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Install the stub globals MeasurePanel reads at construction time. */
export function installFakeDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.ResizeObserver = FakeResizeObserver;
}

/**
 * First descendant (or `root` itself) carrying `cls` in its className, else
 * undefined. Shared by the panel tests so each one does not re-declare a DOM
 * stub; the recording `FakeEl` above is the single implementation.
 */
export function byClass(root: FakeEl, cls: string): FakeEl | undefined {
  if (root.className.split(' ').includes(cls)) return root;
  for (const child of root.children) {
    const hit = byClass(child, cls);
    if (hit) return hit;
  }
  return undefined;
}

/** First descendant whose own text contains `substr`, else undefined. */
export function findContaining(root: FakeEl, substr: string): FakeEl | undefined {
  if (typeof root.textContent === 'string' && root.textContent.includes(substr)) return root;
  for (const child of root.children) {
    const hit = findContaining(child, substr);
    if (hit) return hit;
  }
  return undefined;
}
