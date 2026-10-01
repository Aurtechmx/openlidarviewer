/**
 * sessionLogDom.ts: a small DOM stand-in for the Session log page and its
 * recorder, which need what the shared fakes leave out: `prepend`,
 * `isConnected`, selector lists in `closest`/`matches`, `click()`, a body that
 * takes `appendChild`, and a MutationObserver the test can fire by hand.
 */

type Listener = (ev: unknown) => void;

export class SNode {
  readonly tagName: string;
  parent: SNode | null = null;
  readonly children: SNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  hidden = false;
  disabled = false;
  type = '';
  scope = '';
  colSpan = 1;
  download = '';
  href = '';
  /** Marks the document body: a node under it is connected. */
  isRoot = false;
  private _text = '';
  private _classes = new Set<string>();
  private readonly _listeners = new Map<string, Listener[]>();
  constructor(tagName: string) { this.tagName = tagName.toLowerCase(); }

  get className(): string { return [...this._classes].join(' '); }
  set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
  readonly classList = {
    add: (...c: string[]): void => { for (const x of c) this._classes.add(x); },
    remove: (...c: string[]): void => { for (const x of c) this._classes.delete(x); },
    contains: (c: string): boolean => this._classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this._classes.has(c);
      if (on) this._classes.add(c); else this._classes.delete(c);
      return on;
    },
  };
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k]! : null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }

  set textContent(v: string) { for (const c of this.children) c.parent = null; this.children.length = 0; this._text = v; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(''); }

  get isConnected(): boolean {
    for (let n: SNode | null = this; n; n = n.parent) if (n.isRoot) return true;
    return false;
  }
  get firstChild(): SNode | null { return this.children[0] ?? null; }
  get parentElement(): SNode | null { return this.parent; }

  private _detach(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parent = null;
  }
  append(...kids: SNode[]): void { for (const k of kids) { k._detach(); k.parent = this; this.children.push(k); } }
  appendChild(k: SNode): SNode { this.append(k); return k; }
  prepend(...kids: SNode[]): void {
    for (const k of [...kids].reverse()) { k._detach(); k.parent = this; this.children.unshift(k); }
  }
  insertBefore(k: SNode, ref: SNode | null): SNode {
    k._detach();
    k.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
    return k;
  }
  replaceChildren(...kids: SNode[]): void {
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
    this.append(...kids);
  }
  remove(): void { this._detach(); }

  /** One compound selector: `tag`, `.a.b`, `[k]`, `[k="v"]`, or any run of them. */
  private _one(sel: string): boolean {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
    if (!m) return false;
    if (m[1] && m[1].toLowerCase() !== this.tagName) return false;
    for (const c of (m[2] ?? '').split('.').filter(Boolean)) if (!this._classes.has(c)) return false;
    for (const a of (m[3] ?? '').match(/\[[^\]]+\]/g) ?? []) {
      const kv = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(a);
      if (!kv) return false;
      if (kv[2] === undefined ? !(kv[1]! in this.attrs) : this.attrs[kv[1]!] !== kv[2]) return false;
    }
    return true;
  }
  matches(sel: string): boolean { return sel.split(',').some((s) => this._one(s)); }
  closest(sel: string): SNode | null {
    for (let n: SNode | null = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): SNode[] {
    const out: SNode[] = [];
    const walk = (n: SNode): void => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string): SNode | null { return this.querySelectorAll(sel)[0] ?? null; }

  addEventListener(type: string, fn: Listener): void { this._listeners.set(type, [...(this._listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Listener): void { this._listeners.set(type, (this._listeners.get(type) ?? []).filter((f) => f !== fn)); }
  fire(type: string, ev: unknown = {}): void { for (const fn of this._listeners.get(type) ?? []) fn(ev); }
  click(): void { if (!this.disabled) this.fire('click', { target: this }); }
  focus(): void {}
}

/** A document: `createElement`, a connected body, and listener bookkeeping. */
export class SDoc {
  readonly body = new SNode('body');
  /** Every anchor a download appended to the body, in order. */
  readonly downloads: SNode[] = [];
  private readonly _listeners = new Map<string, Listener[]>();
  constructor() {
    this.body.isRoot = true;
    const append = this.body.appendChild.bind(this.body);
    this.body.appendChild = (k: SNode): SNode => {
      if (k.tagName === 'a' && k.download) this.downloads.push(k);
      return append(k);
    };
  }
  createElement(tag: string): SNode { return new SNode(tag); }
  addEventListener(type: string, fn: Listener): void { this._listeners.set(type, [...(this._listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Listener): void { this._listeners.set(type, (this._listeners.get(type) ?? []).filter((f) => f !== fn)); }
  listenerCount(type: string): number { return (this._listeners.get(type) ?? []).length; }
  dispatchEvent(ev: Event): boolean { this.fire(ev.type, ev); return true; }
  fire(type: string, ev: unknown): void { for (const fn of this._listeners.get(type) ?? []) fn(ev); }
}

/** A MutationObserver whose callback the test fires by hand. */
export class SMutationObserver {
  static live: SMutationObserver[] = [];
  readonly targets: Array<{ target: SNode; opts: MutationObserverInit }> = [];
  private readonly cb: (records: Array<{ target: SNode }>) => void;
  constructor(cb: (records: Array<{ target: SNode }>) => void) { this.cb = cb; SMutationObserver.live.push(this); }
  observe(target: SNode, opts: MutationObserverInit): void { this.targets.push({ target, opts }); }
  disconnect(): void {
    this.targets.length = 0;
    SMutationObserver.live = SMutationObserver.live.filter((o) => o !== this);
  }
  /** Fire every observer watching `target` (or one of its ancestors with `subtree`). */
  static touch(target: SNode): void {
    for (const o of [...SMutationObserver.live]) {
      const hit = o.targets.some(({ target: t, opts }) => t === target || (opts.subtree && isAncestor(t, target)));
      if (hit) o.cb([{ target }]);
    }
  }
  /** Every node any live observer watches. */
  static watched(): SNode[] { return SMutationObserver.live.flatMap((o) => o.targets.map((t) => t.target)); }
}

function isAncestor(a: SNode, b: SNode): boolean {
  for (let n: SNode | null = b.parent; n; n = n.parent) if (n === a) return true;
  return false;
}

/** Install `doc` as the global document and the stub observer as MutationObserver. */
export function installSessionLogDom(): SDoc {
  const doc = new SDoc();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = doc;
  g.MutationObserver = SMutationObserver;
  SMutationObserver.live = [];
  return doc;
}

export function uninstallSessionLogDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.MutationObserver;
  SMutationObserver.live = [];
}
