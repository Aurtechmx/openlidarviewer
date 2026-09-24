/**
 * tests/helpers/canvasKeyboardDomFake.ts
 *
 * The recording DOM stub shared by tests/analyseSurfaceTilesKeyboard.test.ts
 * and tests/rangeWorkbenchKeyboard.test.ts: both pin a canvas-based widget's
 * keyboard equivalent to its click-to-sample mouse path, against a `document`
 * stub with no real canvas 2D context (the widgets under test are null-safe
 * against that, same convention as tests/analysePanelCoverageTile.test.ts).
 */

export type Handler = (e: unknown) => void;

export class FakeEl {
  readonly tagName: string;
  className = '';
  title = '';
  tabIndex = -1;
  width = 0;
  height = 0;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();
  private _classes = new Set<string>();
  /**
   * Fixed rect to report from `getBoundingClientRect`, for a caller that
   * needs an exact ratio (e.g. a 4x2 acquisition grid) rather than the
   * element's own `.width`/`.height`. Null falls back to `width || 1` /
   * `height || 1`, which tracks a canvas resized to match its data.
   */
  boundingRect: { width: number; height: number } | null = null;

  constructor(tag: string) {
    this.tagName = tag;
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => {
        classes.add(c);
      },
      remove: (c: string): void => {
        classes.delete(c);
      },
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
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
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
  dispatchEvent(evt: { type: string }): boolean {
    for (const fn of this.handlers.get(evt.type) ?? []) fn(evt);
    return true;
  }
  /** Canvas 2D context is unavailable in the stub; callers guard every use. */
  getContext(): null {
    return null;
  }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    const r = this.boundingRect ?? {
      width: this.width === 0 ? 1 : this.width,
      height: this.height === 0 ? 1 : this.height,
    };
    return { ...r, left: 0, top: 0 };
  }
}
