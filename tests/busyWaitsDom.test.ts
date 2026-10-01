/**
 * busyWaitsDom.test.ts: `showBusyWaits` against a small fake DOM. It writes
 * the elapsed time (and the estimate, read back from a progress trail) beside
 * an indicator whose host has text of its own, never inside a button or an
 * empty slot, removes it when the task hides or ends, keeps the clock across
 * a hide, and speaks once every 30 s with a usable label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBusyWaits, collectBusyTasks, showBusyWaits, BUSY_WAIT_CLASS } from '../src/app/stateStrip/busyTasks';
import { liveTasks, resetTaskActivityForTests } from '../src/process/taskActivity';
import { trailLength } from '../src/ui/busyScan';

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeNode | null = null;
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
}

class FakeNode {
  readonly nodeType = 1;
  readonly childNodes: (FakeNode | FakeText)[] = [];
  parentElement: FakeNode | null = null;
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  private readonly cls = new Set<string>();
  private readonly props: Record<string, string> = {};
  readonly style = { getPropertyValue: (k: string) => this.props[k] ?? '', setProperty: (k: string, v: string) => { this.props[k] = v; } };
  readonly classList = {
    contains: (c: string) => this.cls.has(c),
    add: (c: string) => { this.cls.add(c); },
    remove: (c: string) => { this.cls.delete(c); },
  };
  /** Upper case for HTML elements, as the DOM reports it; SVG keeps its case. */
  readonly tagName: string;
  constructor(tag: string, isRoot = false) {
    this.tagName = tag === 'svg' ? tag : tag.toUpperCase();
    this.isRoot = isRoot;
  }
  private readonly isRoot: boolean;
  set className(v: string) {
    this.cls.clear();
    v.split(/\s+/).filter(Boolean).forEach((c) => this.cls.add(c));
  }
  get className(): string {
    return [...this.cls].join(' ');
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes.length = 0;
    if (v) this.append(v);
  }
  append(...kids: (FakeNode | string)[]): void {
    for (const k of kids) {
      const node = typeof k === 'string' ? new FakeText(k) : k;
      if (node instanceof FakeNode) node.remove();
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  remove(): void {
    const p = this.parentElement;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentElement = null;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n.parentElement) n = n.parentElement;
    return n.isRoot;
  }
  contains(other: unknown): boolean {
    for (let n = other as FakeNode | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  closest(): FakeNode | null {
    for (let n: FakeNode | null = this; n; n = n.parentElement) if (n.classList.contains('olv-hidden')) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeNode[] {
    const c = sel.replace(/^\./, '');
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      for (const k of n.childNodes) {
        if (!(k instanceof FakeNode)) continue;
        if (k.classList.contains(c)) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out;
  }
}

let body: FakeNode;

function indicator(fraction: number | null): FakeNode {
  const svg = new FakeNode('svg');
  svg.className = 'olv-busy-scan';
  if (fraction !== null) svg.style.setProperty('--olv-bs-len', trailLength(fraction).toFixed(2));
  return svg;
}

function host(tag: string, ...kids: (FakeNode | string)[]): FakeNode {
  const h = new FakeNode(tag);
  h.append(...kids);
  body.append(h);
  return h;
}

const waitOf = (h: FakeNode): FakeNode | undefined =>
  h.childNodes.find((c): c is FakeNode => c instanceof FakeNode && c.classList.contains(BUSY_WAIT_CLASS));

/** One strip poll at `now`. */
function tick(now: number, announce = vi.fn()): ReturnType<typeof vi.fn> {
  collectBusyTasks(body as unknown as ParentNode);
  showBusyWaits(liveTasks(now), announce);
  return announce;
}

beforeEach(() => {
  resetTaskActivityForTests();
  clearBusyWaits();
  body = new FakeNode('body', true);
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeNode(tag) };
  g.Element = FakeNode;
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.Element;
});

describe('showBusyWaits', () => {
  it('writes nothing in the first second, then the elapsed time, hidden from assistive technology', () => {
    const h = host('p', indicator(null), 'Analysing…');
    tick(0);
    expect(waitOf(h)).toBeUndefined();
    tick(1000);
    expect(waitOf(h)?.textContent).toBe('1 s elapsed');
    expect(waitOf(h)?.getAttribute('aria-hidden')).toBe('true');
    tick(12_000);
    expect(waitOf(h)?.textContent).toBe('12 s elapsed');
    expect(h.childNodes.filter((c) => c instanceof FakeNode && c.classList.contains(BUSY_WAIT_CLASS))).toHaveLength(1);
  });

  it('reads progress back from the trail and shows the time left', () => {
    const svg = indicator(0.05);
    const h = host('p', svg, 'Exporting');
    tick(0);
    svg.style.setProperty('--olv-bs-len', trailLength(0.25).toFixed(2));
    tick(4000);
    // 20% in 4 s, 75% to go: 15 s at a steady rate.
    expect(waitOf(h)?.textContent).toBe('4 s elapsed, about 15 s left');
    expect(waitOf(h)?.textContent).not.toMatch(/NaN|Infinity|-\d/);
  });

  it('writes nothing inside a button host or beside an indicator with no text', () => {
    const button = host('button', indicator(null), '…');
    const card = host('div', indicator(null));
    tick(0);
    tick(5000);
    expect(waitOf(button)).toBeUndefined();
    expect(waitOf(card)).toBeUndefined();
  });

  it('removes the text while the task is hidden and keeps counting through it', () => {
    const h = host('p', indicator(null), 'Analysing…');
    tick(0);
    tick(5000);
    h.classList.add('olv-hidden');
    tick(6000);
    expect(waitOf(h)).toBeUndefined();
    h.classList.remove('olv-hidden');
    tick(9000);
    expect(waitOf(h)?.textContent).toBe('9 s elapsed');
  });

  it('removes the text when the indicator goes, and clearBusyWaits removes all of it', () => {
    const svg = indicator(null);
    const h = host('p', svg, 'Analysing…');
    tick(0);
    tick(3000);
    svg.remove();
    tick(4000);
    expect(waitOf(h)).toBeUndefined();
    const other = host('p', indicator(null), 'Exporting');
    tick(5000);
    tick(7000);
    expect(waitOf(other)).toBeDefined();
    clearBusyWaits();
    expect(waitOf(other)).toBeUndefined();
  });

  it('speaks once every 30 s, naming the task, and says "Working" for a label with no words', () => {
    host('p', indicator(null), 'Analysing…');
    host('button', indicator(null), '…');
    const announce = vi.fn();
    for (let t = 0; t <= 61_000; t += 1000) tick(t, announce);
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      'Analysing…: 30 s elapsed.',
      'Working: 30 s elapsed.',
      'Analysing…: 1 min 0 s elapsed.',
      'Working: 1 min 0 s elapsed.',
    ]);
  });

  it('starts the clock and the spoken updates again when an indicator is reused for a new task', () => {
    const svg = indicator(null);
    host('p', svg, 'Opening');
    const announce = vi.fn();
    for (let t = 0; t <= 31_000; t += 1000) tick(t, announce);
    expect(announce).toHaveBeenCalledTimes(1);
    // reset() between runs bumps the run number; no poll sees a settled mark.
    svg.dataset.run = '1';
    for (let t = 33_000; t <= 63_000; t += 1000) tick(t, announce);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce.mock.calls[1][0]).toBe('Opening: 30 s elapsed.');
  });

  // The load toast reuses one indicator. A run ends with complete() (the
  // settled mark lives 250 ms, between polls) or a cancel or error (no mark),
  // then reset() bumps the run number and the toast hides.
  for (const ending of ['complete', 'cancel', 'error'] as const) {
    it(`starts the next run near zero after a ${ending} ending the poll never saw settle`, () => {
      const svg = indicator(null);
      const toast = host('div', svg, 'Preparing display…');
      svg.dataset.run = '1';
      const announce = vi.fn();
      for (let t = 0; t <= 82_000; t += 1000) tick(t, announce);
      expect(announce).toHaveBeenCalledTimes(2);
      if (ending === 'complete') svg.classList.add('is-settled');
      svg.classList.remove('is-settled');
      svg.dataset.run = '2';
      toast.classList.add('olv-hidden');
      tick(83_000, announce);
      toast.classList.remove('olv-hidden');
      tick(90_000, announce);
      tick(93_000, announce);
      expect(waitOf(toast)?.textContent).toBe('3 s elapsed');
      expect(announce).toHaveBeenCalledTimes(2);
    });
  }
});
