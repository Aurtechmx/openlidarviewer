/**
 * tests/helpers/busyScanDom.ts
 *
 * A small recording DOM for the busy scan and the load toast: class sets kept
 * in step with the `class` attribute, a style object with `setProperty`,
 * class-selector `querySelector`, and listeners a test can fire.
 */

export class Node0 {
  readonly children: Node0[] = [];
  readonly attrs: Record<string, string> = {};
  readonly cls = new Set<string>();
  readonly listeners: Record<string, Array<() => void>> = {};
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(
    {} as Record<string, string>,
    {
      setProperty(this: Record<string, string>, k: string, v: string): void {
        this[k] = v;
      },
    },
  );
  private _text = '';
  /** Setting it drops every child, as in the DOM. */
  set textContent(v: string) {
    this._text = v;
    this.children.length = 0;
  }
  get textContent(): string {
    return this._text;
  }
  type = '';
  title = '';
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.cls.delete(x)),
    toggle: (c: string, on?: boolean) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)),
    contains: (c: string) => this.cls.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set className(v: string) {
    this.cls.clear();
    v.split(/\s+/).filter(Boolean).forEach((c) => this.cls.add(c));
  }
  get className(): string {
    return [...this.cls].join(' ');
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'class') this.className = v;
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return this.attrs[k] ?? null;
  }
  append(...kids: (Node0 | string)[]): void {
    for (const k of kids) {
      if (typeof k === 'string') {
        const t = new Node0('#text');
        t._text = k;
        this.children.push(t);
      } else this.children.push(k);
    }
  }
  replaceChildren(...kids: (Node0 | string)[]): void {
    this._text = '';
    this.children.length = 0;
    this.append(...kids);
  }
  /** Own text and every descendant's, in order. */
  get text(): string {
    return [this._text, ...this.children.map((c) => c.text)].filter(Boolean).join(' ');
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  fire(type: string): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn();
  }
  find(c: string): Node0[] {
    return [...(this.cls.has(c) ? [this as Node0] : []), ...this.children.flatMap((k) => k.find(c))];
  }
  querySelector(sel: string): Node0 | null {
    return sel.startsWith('.') ? (this.find(sel.slice(1))[0] ?? null) : null;
  }
}

/** Install the stub `document`. */
export function installBusyScanDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (t: string) => new Node0(t),
    createElementNS: (_ns: string, t: string) => new Node0(t),
  };
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
}
