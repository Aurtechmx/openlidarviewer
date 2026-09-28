/**
 * The shared exit pieces (spec CE-1, CE-EXIT-01 and CE-EXIT-04): a dialog's
 * close glyph becomes a Back that names where it returns, read from the
 * location bar, and opening one transient closes the others.
 */
import { describe, expect, it } from 'vitest';
import { backDestination, closeTransients, labelModalBack } from '../src/ui/exitConvention';

/** Just enough of an element for these helpers. */
class FakeEl {
  textContent = '×';
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = { add: (c: string) => this.classes.add(c) };
  clicks = 0;
  readonly id: string;
  readonly inside: FakeEl | null;
  constructor(id: string, inside: FakeEl | null = null) {
    this.id = id;
    this.inside = inside;
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  click(): void { this.clicks += 1; }
  contains(o: FakeEl): boolean { return o === this || o.inside === this; }
}

const docWith = (sel: Record<string, unknown>) =>
  ({
    querySelector: (q: string) => sel[q] ?? null,
    querySelectorAll: (q: string) => (sel.all as (q: string) => FakeEl[])?.(q) ?? [],
  }) as unknown as Document;

describe('labelModalBack', () => {
  it('names the current location, drops the old description and keeps the control', () => {
    const x = new FakeEl('x');
    x.setAttribute('aria-describedby', 'tip');
    const root = { querySelector: (q: string) => (q === '.olv-modal-x' ? x : null) } as unknown as HTMLElement;
    const doc = docWith({ '.olv-loc[data-here]': { dataset: { here: 'Measure' } } });
    labelModalBack(root, doc);
    expect(x.textContent).toBe('← Measure');
    expect(x.getAttribute('aria-label')).toBe('Back to Measure');
    expect(x.getAttribute('aria-describedby')).toBeNull();
    expect(x.classes.has('olv-modal-back')).toBe(true);
    expect(x.getAttribute('data-tip')).toBe('Close this and go back to Measure.');
  });

  it('falls back to the scan when no location is known', () => {
    expect(backDestination(docWith({}))).toBe('scan');
  });
});

describe('closeTransients', () => {
  it('asks for open popovers and result focus, and spares the surface being opened', () => {
    const keep = new FakeEl('keep');
    const more = new FakeEl('more');
    const focus = new FakeEl('focus');
    const inner = new FakeEl('inner', keep);
    let query = '';
    const doc = docWith({ all: (q: string) => { query = q; return [more, focus, inner]; } });
    closeTransients(keep as unknown as Element, doc);
    expect(query).toContain('[aria-expanded="true"]');
    expect(query).toContain('.olv-result-focus');
    expect([more.clicks, focus.clicks, inner.clicks]).toEqual([1, 1, 0]);
  });
});
