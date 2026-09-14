/**
 * navBarDom.ts — the DOM stub the NavBar unit tests build the panel against.
 *
 * The suite runs in Node with no jsdom, so `el()` needs a `document` that makes
 * elements, `localStorage` for the panel's persisted choices, and the two
 * element constructors `el()` narrows against. Every NavBar test needs the same
 * stub; holding it here keeps one copy of the element shape rather than one per
 * test file.
 *
 * `window` is installed only when a test asks for it. NavBar registers its
 * pointer listeners on `window` when one exists, so a test that is not about
 * those listeners keeps the quieter environment where the branch is skipped.
 */

export class FakeClassList {
  private readonly set = new Set<string>();
  constructor(initial: string) {
    for (const c of initial.split(/\s+/).filter(Boolean)) this.set.add(c);
  }
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

export class FakeEl {
  private _className = '';
  classList = new FakeClassList('');
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className(): string { return this._className; }
  set className(v: string) { this._className = v; this.classList = new FakeClassList(v); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  get ownText(): string { return this._text; }
  append(...kids: (FakeEl | null)[]): void {
    for (const k of kids) if (k) this.children.push(k);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0; this.children.push(...kids);
  }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  focus(): void { /* no-op */ }
  remove(): void { /* no-op */ }
  closest(): null { return null; }
  /** Every descendant (and self) carrying `cls`. */
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
  /** Is `node` inside a subtree that carries `cls`? */
  hasAncestorWithClass(node: FakeEl, cls: string): boolean {
    for (const host of this.byClass(cls)) {
      if (host === node) continue;
      const stack = [...host.children];
      while (stack.length) {
        const n = stack.pop() as FakeEl;
        if (n === node) return true;
        stack.push(...n.children);
      }
    }
    return false;
  }
  /** All text in this subtree, joined. */
  allText(): string {
    return [this._text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' ');
  }
}

/** The listener traffic a stubbed `window` saw, by event type in call order. */
export interface WindowEventLog {
  readonly added: string[];
  readonly removed: string[];
}

export interface NavBarDom {
  /** Backing store for the stubbed `localStorage`; clear it between tests. */
  readonly store: Map<string, string>;
  /** Present only when installed with `{ window: true }`. */
  readonly windowEvents: WindowEventLog;
}

/**
 * Install the stub on `globalThis`. Call from `beforeAll`; the returned store
 * is the one the stubbed `localStorage` reads and writes.
 */
export function installNavBarDom(opts: { window?: boolean } = {}): NavBarDom {
  const store = new Map<string, string>();
  const windowEvents: WindowEventLog = { added: [], removed: [] };

  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  // `el()` narrows with `instanceof` before assigning href / type. The stub is
  // not a real element, so these only have to exist for the check to answer no.
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLAnchorElement ??= class {};
  g.HTMLInputElement ??= class {};
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };

  if (opts.window === true) {
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: (t: string) => { windowEvents.added.push(t); },
      removeEventListener: (t: string) => { windowEvents.removed.push(t); },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    };
  }

  return { store, windowEvents };
}
