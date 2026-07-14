/**
 * colorbarOverlay.test.ts
 *
 * DOM behaviour of the live colorbar legend overlay, in the node environment
 * via the same recording DOM stub the other panel tests use (no jsdom).
 * Pins the lifecycle that matters:
 *
 *   - hidden until a continuous scalar mode produces a spec; hidden again
 *     when the mode goes categorical (update(null));
 *   - renders the generator's SVG plus an explicit min–max range line
 *     (with the unit only when known) and the honesty note;
 *   - identical specs do NOT re-render (the streaming path refreshes on every
 *     node-ready, so the overlay must be cheap under a no-change poll);
 *   - dismissal sticks for the active mode — a streaming range refinement
 *     must not resurrect a legend the user closed — but a NEW mode re-arms it.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildActiveColorbarSpec, type ActiveColorbar } from '../src/render/activeColorbar';

class FakeEl {
  readonly tagName: string;
  className = '';
  title = '';
  type = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  private _text = '';
  private _html = '';
  /** How many times innerHTML was assigned — the re-render counter. */
  htmlSets = 0;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  readonly classList = {
    add: (c: string): void => {
      if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((x) => x !== c)
        .join(' ');
    },
    toggle: (c: string, force?: boolean): void => {
      const want = force ?? !this.classList.contains(c);
      if (want) this.classList.add(c);
      else this.classList.remove(c);
    },
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };

  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(v: string) {
    this._html = v;
    this.htmlSets++;
  }
  get innerHTML(): string {
    return this._html;
  }
  /** Own + descendant innerHTML — the SVG rides an el()-built child div. */
  get deepHtml(): string {
    return [this._html, ...this.children.map((c) => c.deepHtml)].join('');
  }
  /** How many times replaceChildren ran — the host-level re-render counter. */
  replaceCalls = 0;
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
    this.replaceCalls++;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...kids: Array<FakeEl | string>): void {
    for (const k of kids) if (k instanceof FakeEl) this.children.push(k);
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  /** Every descendant (incl. self) whose className contains `cls`. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

// Imported lazily AFTER the document stub is installed — module evaluation
// itself is side-effect free, but keeping the import dynamic mirrors how the
// real app loads the overlay chunk on demand.
async function makeOverlay() {
  const { ColorbarOverlay } = await import('../src/ui/ColorbarOverlay');
  return new ColorbarOverlay();
}

function elevationBar(min = 2.4, max = 18.7, unit: string | null = 'm'): ActiveColorbar {
  const bar = buildActiveColorbarSpec({
    mode: 'elevation',
    range: { min, max },
    trimPercent: 5,
    elevationUnit: unit,
  });
  if (!bar) throw new Error('test setup: expected an elevation colorbar');
  return bar;
}

function intensityBar(): ActiveColorbar {
  const bar = buildActiveColorbarSpec({
    mode: 'intensity',
    range: { min: 0, max: 65535 },
  });
  if (!bar) throw new Error('test setup: expected an intensity colorbar');
  return bar;
}

describe('ColorbarOverlay', () => {
  let root: FakeEl;

  beforeEach(() => {
    root = null as unknown as FakeEl;
  });

  it('starts hidden and stays hidden on update(null)', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    expect(root.classList.contains('olv-hidden')).toBe(true);
    overlay.update(null);
    expect(root.classList.contains('olv-hidden')).toBe(true);
  });

  it('shows the generator SVG, the min–max range line and the note', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar());
    expect(root.classList.contains('olv-hidden')).toBe(false);
    const svgHost = root.findByClass('olv-colorbar-svg')[0];
    expect(svgHost.deepHtml).toContain('<svg');
    expect(svgHost.deepHtml).toContain('linearGradient');
    const range = root.findByClass('olv-colorbar-range')[0];
    expect(range.textContent).toContain('2.4');
    expect(range.textContent).toContain('18.7');
    expect(range.textContent).toContain('m');
    const note = root.findByClass('olv-colorbar-note')[0];
    expect(note.textContent).toContain('p5–p95');
  });

  it('omits the unit from the range line when the unit is unknown', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar(2.4, 18.7, null));
    const range = root.findByClass('olv-colorbar-range')[0];
    expect(range.textContent).toContain('2.4 – 18.7');
    expect(range.textContent).not.toContain('m');
  });

  it('does not re-render for an identical spec (cheap under streaming polls)', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar());
    const svgHost = root.findByClass('olv-colorbar-svg')[0];
    const rendersAfterFirst = svgHost.replaceCalls;
    overlay.update(elevationBar());
    overlay.update(elevationBar());
    expect(svgHost.replaceCalls).toBe(rendersAfterFirst);
  });

  it('re-renders when the range refines (streaming reseed)', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar(0, 100));
    const svgHost = root.findByClass('olv-colorbar-svg')[0];
    const rendersAfterFirst = svgHost.replaceCalls;
    overlay.update(elevationBar(5, 95));
    expect(svgHost.replaceCalls).toBeGreaterThan(rendersAfterFirst);
  });

  it('hides again when the mode stops producing a colorbar', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar());
    overlay.update(null);
    expect(root.classList.contains('olv-hidden')).toBe(true);
    // And re-shows on the next continuous mode.
    overlay.update(elevationBar());
    expect(root.classList.contains('olv-hidden')).toBe(false);
  });

  it('dismissal sticks for the active mode, even as its range refines', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar(0, 100));
    const close = root.findByClass('olv-colorbar-close')[0];
    close.click();
    expect(root.classList.contains('olv-hidden')).toBe(true);
    // A refined range in the SAME mode must not resurrect the legend the
    // user explicitly closed.
    overlay.update(elevationBar(5, 95));
    expect(root.classList.contains('olv-hidden')).toBe(true);
  });

  it('a NEW colour mode re-arms a dismissed legend', async () => {
    const overlay = await makeOverlay();
    root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar());
    root.findByClass('olv-colorbar-close')[0].click();
    expect(root.classList.contains('olv-hidden')).toBe(true);
    overlay.update(intensityBar());
    expect(root.classList.contains('olv-hidden')).toBe(false);
    // …and switching back to the previously dismissed mode shows it again
    // (dismissal is per selection, not a permanent per-mode preference).
    overlay.update(elevationBar());
    expect(root.classList.contains('olv-hidden')).toBe(false);
  });
});

describe('ColorbarOverlay — dismissal scope ends when the mode leaves', () => {
  it('a detour through a no-legend mode re-arms a dismissed legend', async () => {
    const { ColorbarOverlay } = await import('../src/ui/ColorbarOverlay');
    const overlay = new ColorbarOverlay();
    const root = overlay.element as unknown as FakeEl;
    overlay.update(elevationBar());
    root.findByClass('olv-colorbar-close')[0].click();
    expect(root.classList.contains('olv-hidden')).toBe(true);
    // User switches to a categorical mode (density/rgb → no legend at all),
    // then back to Height. That is a fresh selection of the elevation
    // legend — it must show again (live-app verified regression).
    overlay.update(null);
    overlay.update(elevationBar());
    expect(root.classList.contains('olv-hidden')).toBe(false);
  });
});
