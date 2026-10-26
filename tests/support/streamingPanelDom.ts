/**
 * A recording DOM stub for the StreamingPanel tests, which run in the node
 * environment. It keeps the render tree, own text, class list and click
 * listeners, so a test can assert on what the panel drew and dispatch the
 * click a user would make.
 */

export class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = {
    _set: new Set<string>(),
    add(c: string): void { this._set.add(c); },
    remove(c: string): void { this._set.delete(c); },
    toggle(c: string, on?: boolean): void {
      const want = on ?? !this._set.has(c);
      if (want) this._set.add(c); else this._set.delete(c);
    },
    contains(c: string): boolean { return this._set.has(c); },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  get ownText(): string { return this._text; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids.filter(Boolean)); }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  blur(): void { /* no-op */ }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn(); }
  /** Recursively collect every descendant whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
  /** First descendant whose own text contains `substr`, or undefined. */
  findContaining(substr: string): FakeEl | undefined {
    if (this._text.includes(substr)) return this;
    for (const c of this.children) {
      const hit = c.findContaining(substr);
      if (hit) return hit;
    }
    return undefined;
  }
  /** Every descendant carrying the chip class, in row order. */
  chips(): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(' ').includes('olv-chip')) out.push(this);
    for (const c of this.children) out.push(...c.chips());
    return out;
  }
}

/**
 * Install the `document` and constructor stand-ins the panel needs. Call from
 * `beforeAll`. `el()` narrows with `node instanceof HTMLInputElement /
 * HTMLAnchorElement` before applying `type` / `href`; those constructors do
 * not exist in the node test environment, and a FakeEl is never an instance,
 * so the narrowing simply skips.
 */
export function installPanelDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
}

/** StreamingPanel callbacks that do nothing, for tests that drive the panel directly. */
export function noopPanelCallbacks() {
  return {
    onColorMode() {}, onQuality() {}, onPauseToggle() {}, onClearCache() {},
    onGradeFullCloud() {}, onCancelGrade() {},
  };
}
