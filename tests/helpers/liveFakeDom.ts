/**
 * liveFakeDom.ts: the recording element for the UI tests that DRIVE a tree
 * rather than only read it.
 *
 * `recordingDom.ts` records what was built; its classList and its listeners are
 * no-ops, which is right for a renderer test that asserts on text. The
 * workspace and launcher tests instead toggle classes, fire clicks and keys,
 * and re-parent nodes, so they need a stub where those are real. That stub was
 * written twice, once per suite; this is the single copy both import.
 */

export class FakeEl {
  title = '';
  type = '';
  id = '';
  disabled = false;
  focused = false;
  parent: FakeEl | null = null;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private _classes = new Set<string>();
  private readonly _listeners = new Map<string, ((ev: unknown) => void)[]>();
  readonly tagName: string;
  get className(): string { return [...this._classes].join(' '); }
  set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
  readonly classList = {
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this._classes.has(c);
      if (on) this._classes.add(c);
      else this._classes.delete(c);
    },
    contains: (c: string): boolean => this._classes.has(c),
    add: (c: string): void => { this._classes.add(c); },
    remove: (c: string): void => { this._classes.delete(c); },
  };
  constructor(tagName: string) { this.tagName = tagName; }
  hasClass(c: string): boolean { return this._classes.has(c); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  /** This node's own text plus every descendant's, in tree order. */
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** This node's OWN text, with no descendant text mixed in. */
  get ownText(): string { return this._text; }
  append(...kids: FakeEl[]): void {
    for (const k of kids) { k.parent = this; this.children.push(k); }
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.append(...kids);
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): void {
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
  }
  get parentElement(): FakeEl | null { return this.parent; }
  private _matches(sel: string): boolean {
    if (sel.startsWith('.')) return this._classes.has(sel.slice(1));
    const attr = /^\[([^=\]]+)="([^"]+)"\]$/.exec(sel);
    if (attr) return this.attrs[attr[1]] === attr[2];
    return false;
  }
  /** Minimal `closest`: walks up parents matching `.class` or `[attr="v"]`. */
  closest(sel: string): FakeEl | null {
    let node: FakeEl | null = this;
    while (node) {
      if (node._matches(sel)) return node;
      node = node.parent;
    }
    return null;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this._listeners.set(type, (this._listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** How many listeners are attached for `type`, which disposal asserts on. */
  listenerCount(type: string): number { return (this._listeners.get(type) ?? []).length; }
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this._listeners.get(type) ?? []) fn(ev);
  }
  focus(): void { this.focused = true; }
  blur(): void { this.focused = false; }
  /** The first node in the subtree (this one included) matching `pred`. */
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return undefined;
  }
  /** Every node in the subtree matching `pred`, in tree order. */
  findAll(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) out.push(...c.findAll(pred));
    return out;
  }
}

/**
 * The stand-in for the element globals `el()` tests with `instanceof` before it
 * writes `type` or `href`. Neither global exists in the node runtime, and a
 * FakeEl is never an instance of this, so both branches stay unvisited. One
 * class serves both names: nothing reads which one it is.
 */
class InertElementGlobal {
  readonly inert = true;
}

/**
 * Install the stub as the global `document`, plus the two element globals.
 * Call from `beforeAll`.
 */
export function installLiveFakeDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = InertElementGlobal;
  g.HTMLAnchorElement = InertElementGlobal;
}
