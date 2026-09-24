/**
 * tests/helpers/analysePanelDom.ts
 *
 * Recording node stub the AnalysePanel tests mount against. Covers only the
 * DOM surface `src/ui/AnalysePanel.ts` touches: a flat class string, string
 * `textContent`, children and a handful of finder helpers each suite reads
 * its assertions through.
 *
 * `installAnalysePanelDom()` puts the stub on `globalThis` and is safe to
 * call from several suites in one worker.
 */

export class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  width = 0;
  height = 0;
  href = '';
  download = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add(): void {
      /* no-op */
    },
    remove(): void {
      /* no-op */
    },
    toggle(): void {
      /* no-op */
    },
  };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(): void {
    /* no-op */
  }
  removeAttribute(): void {
    /* no-op */
  }
  /** Canvas 2D context is unavailable in the stub — the tile path is null-safe. */
  getContext(): null {
    return null;
  }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** This node's OWN text, ignoring descendants. */
  get ownText(): string {
    return this._text;
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids.filter(Boolean));
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  addEventListener(): void {
    /* no-op */
  }
  blur(): void {
    /* no-op */
  }
  click(): void {
    /* no-op */
  }
  /** Recursively collect every descendant whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
  /** Recursively collect every descendant whose own text CONTAINS `sub`. */
  findContaining(sub: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text.includes(sub)) out.push(this);
    for (const c of this.children) out.push(...c.findContaining(sub));
    return out;
  }
  /** Every `title` attribute in the tree — the panel's hover hints. */
  hints(): string[] {
    const out: string[] = this.title === '' ? [] : [this.title];
    for (const c of this.children) out.push(...c.hints());
    return out;
  }
  /** Every descendant (incl. self) carrying `cls` as a WHOLE class token. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
  /** Every descendant (incl. self) whose className CONTAINS `cls` as a substring. */
  findByClassSubstring(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClassSubstring(cls));
    return out;
  }
}

export interface AnalysePanelDomOptions {
  /** `document.createElementNS`, for suites that mount SVG. */
  ns?: boolean;
  /** Force `globalThis.requestAnimationFrame` to `undefined` — some panels
   * branch on it being unavailable. */
  noRaf?: boolean;
}

/** Install the stub `document` (and optional `requestAnimationFrame`) the
 * AnalysePanel suites read at construction time. */
export function installAnalysePanelDom(options: AnalysePanelDomOptions = {}): void {
  const doc: Record<string, unknown> = { createElement: (tag: string) => new FakeEl(tag) };
  if (options.ns) doc.createElementNS = (_ns: string, tag: string) => new FakeEl(tag);
  (globalThis as unknown as { document: unknown }).document = doc;
  if (options.noRaf) {
    (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
  }
}
