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
  indeterminate = false;
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
  clientWidth = 0;
  offsetWidth = 0;
  width = 0;
  height = 0;

  get parentElement(): FakeEl | null {
    return this.parent;
  }

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
      add: (...c: string[]): void => void c.forEach((x) => classes.add(x)),
      remove: (...c: string[]): void => void c.forEach((x) => classes.delete(x)),
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

  /** Returns the node(s) actually inserted: a `#fragment` contributes its
   * children (exactly as the real DOM does — the fragment itself never
   * becomes a child), anything else adopts as one node. */
  private _adopt(kid: unknown): FakeEl[] {
    if (kid instanceof FakeEl) {
      if (kid.tagName === '#fragment') {
        const kids = [...kid.children];
        kid.children.length = 0;
        for (const k of kids) k.parent = this;
        return kids;
      }
      kid.parent?.detach(kid);
      kid.parent = this;
      return [kid];
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return [t];
  }
  /** Remove `kid` from `this.children` if present. */
  detach(kid: FakeEl): void {
    const at = this.children.indexOf(kid);
    if (at >= 0) this.children.splice(at, 1);
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  appendChild(kid: unknown): unknown {
    this.children.push(...this._adopt(kid));
    return kid;
  }
  /** DOM's `insertBefore`: `ref === null` inserts at the end, matching the spec. */
  insertBefore(kid: unknown, ref: FakeEl | null): FakeEl {
    const nodes = this._adopt(kid);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at === -1) this.children.push(...nodes);
    else this.children.splice(at, 0, ...nodes);
    return nodes[0] as unknown as FakeEl;
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  /** DOM's `Element.remove`: detach this node from its parent, if any. */
  remove(): void {
    this.parent?.detach(this);
    this.parent = null;
  }
  /** DOM's `Element.replaceWith`: swap this node for `node` in its parent's
   * children, preserving position. */
  replaceWith(node: FakeEl): void {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    this.parent = null;
    if (at < 0) return;
    node.parent?.detach(node);
    node.parent = parent;
    parent.children[at] = node;
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
  removeEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    const at = a.indexOf(fn);
    if (at >= 0) a.splice(at, 1);
  }
  dispatchEvent(evt: { type: string; stopPropagation?: () => void } & Record<string, unknown>): boolean {
    for (const fn of [...(this.handlers.get(evt.type) ?? [])]) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null {
    return null;
  }
  /** No-op: nothing under test reads a text-selection state off this stub. */
  select(): void {
    /* not exercised */
  }
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

/** Extra globals a given suite's `dom.ts` call sites need beyond the base set. */
export interface FakeDomOptions {
  /** `document.createElementNS` — the measurement overlay is an `<svg>`, built
   * through the namespaced call. */
  ns?: boolean;
  /** `document.createDocumentFragment`. */
  fragment?: boolean;
  /** `document.addEventListener`/`removeEventListener` (document-level, not
   * per-node — panels that watch outside clicks need this). */
  docListeners?: boolean;
  /** `HTMLTextAreaElement`, for panels with a textarea control. */
  textarea?: boolean;
  /** Skip installing `ResizeObserver` (a caller that supplies its own). */
  noResizeObserver?: boolean;
}

/** Install the stub globals MeasurePanel (and sibling panel/view) tests read
 * at construction time. `options` adds the handful of extras a few suites
 * need on top of the common `createElement`/`HTMLInputElement`/`HTMLAnchorElement`
 * surface, so those suites can share this one stub too. */
export function installFakeDom(options: FakeDomOptions = {}): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const doc: Record<string, unknown> = { createElement: (tag: string) => new FakeEl(tag) };
  if (options.ns) doc.createElementNS = (_ns: string, tag: string) => new FakeEl(tag);
  if (options.fragment) doc.createDocumentFragment = () => new FakeEl('#fragment');
  if (options.docListeners) {
    doc.addEventListener = (): void => {};
    doc.removeEventListener = (): void => {};
  }
  g.document = doc;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  if (options.textarea) g.HTMLTextAreaElement = class HTMLTextAreaElement {};
  if (!options.noResizeObserver) g.ResizeObserver = FakeResizeObserver;
}

/** Remove the globals `installFakeDom` set, mirroring suites that reset state
 * between tests instead of relying on the next `installFakeDom` to overwrite it. */
export function uninstallFakeDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLInputElement;
  delete g.HTMLAnchorElement;
  delete g.HTMLTextAreaElement;
  delete g.ResizeObserver;
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
