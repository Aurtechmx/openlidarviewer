/**
 * tests/helpers/exportPanelPillDomFake.ts
 *
 * The recording DOM node exportPanelCrs.test.ts and exportPanelPillsAria.test.ts
 * both build ExportPanel against. `addEventListener` is a no-op here — most
 * of ExportPanel's assertions read the rendered tree, not a click outcome —
 * so exportPanelPillsAria.test.ts (which DOES need to drive a pill click and
 * observe the re-render) subclasses this with a working
 * `addEventListener`/`click()` pair instead of re-declaring the rest.
 */

export class FakeEl {
  className = '';
  title = '';
  type = '';
  href = '';
  value = '';
  placeholder = '';
  inputMode = '';
  checked = false;
  disabled = false;
  readonly style: Record<string, string> = {};
  protected _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly classList = {
    _set: new Set<string>(),
    add: (c: string): void => {
      this.classList._set.add(c);
    },
    remove: (c: string): void => {
      this.classList._set.delete(c);
    },
    // The two-argument `force` form is part of the real DOM contract and the
    // panel uses it to drive the Products disclosure; a stub that ignored it
    // toggled the section shut on the very render meant to open it.
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c);
      else this.classList._set.delete(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) {
    /* unused */
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  addEventListener(_type?: string, _handler?: () => void): void {
    /* no-op */
  }
  /** Every descendant whose own (direct) text equals `label`. */
  findOwnText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findOwnText(label));
    return out;
  }
  /** Every descendant with the given class. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
}
