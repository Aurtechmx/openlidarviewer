/**
 * tests/helpers/annotationDomFake.ts
 *
 * The recording DOM node shared by tests/annotationIssuePanel.test.ts and
 * tests/annotationEditorGuards.test.ts — both drive the annotation editor
 * and panel views through the same minimal element surface (class lists,
 * children, string textContent/innerHTML, attributes, datasets and event
 * handlers). Holding one copy here keeps the two suites from drifting.
 */

export type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface these views touch. */
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
  disabled = false;
  tabIndex = -1;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
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
  set textContent(v: string) {
    this._text = v;
  }
  /** Aggregated, so a strip built from spans can be read as one string. */
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) {
    /* icon markup — not parsed by this stub */
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
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {
    /* not exercised */
  }
  /** Fire a listener the view registered — how these tests click. Carries
   * no-op stopPropagation/preventDefault so a handler that calls either (the
   * collapse toggle does) does not throw against this stub. */
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
  focus(): void {}
  blur(): void {}
  select(): void {}

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
