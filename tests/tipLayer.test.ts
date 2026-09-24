/**
 * tipLayer.test.ts — the single top-level `[data-tip]` glass tooltip layer
 * (src/ui/tipLayer.ts) that replaced a per-control `::after` pseudo-element
 * (see that file's header comment for why: z-index can't win a stacking
 * fight against a sibling context, only a shared one).
 *
 * Two halves:
 *   - `computeTipPosition` (tipPositioning.ts) is pure geometry — placement,
 *     flipping, and viewport clamping (checked down to 320px) — tested with
 *     no DOM at all.
 *   - `installTipLayer` wires the show/hide events. It gets a minimal fake
 *     document/window built here (not the shared `liveFakeDom`/`recordingDom`
 *     stubs, which don't model `getBoundingClientRect`, `closest`, `matches`,
 *     or `instanceof HTMLElement`, all of which this module needs).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeTipPosition,
  TIP_VIEWPORT_MARGIN,
  TIP_ANCHOR_GAP,
  type Rect,
} from '../src/ui/tipPositioning';

function rect(over: Partial<Rect>): Rect {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...over };
}

describe('computeTipPosition', () => {
  it('centers below the anchor by default', () => {
    const anchor = rect({ top: 100, bottom: 120, left: 50, right: 150, width: 100 });
    const pos = computeTipPosition(anchor, { width: 60, height: 20 }, { width: 1280, height: 860 });
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(120 + TIP_ANCHOR_GAP);
    expect(pos.left).toBe(100 - 30); // anchor center (100) minus half the tip width (30)
  });

  it('flips above the anchor when there is no room below', () => {
    const anchor = rect({ top: 830, bottom: 850, left: 600, right: 700, width: 100 });
    const pos = computeTipPosition(anchor, { width: 60, height: 20 }, { width: 1280, height: 860 });
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(830 - 20 - TIP_ANCHOR_GAP);
  });

  it('clamps the right edge instead of overflowing a 320px viewport', () => {
    // A header control near the right edge, at 320px wide — the case the
    // theme toggle hit under `.olv-right-rail`.
    const anchor = rect({ top: 10, bottom: 38, left: 270, right: 298, width: 28 });
    const pos = computeTipPosition(anchor, { width: 260, height: 40 }, { width: 320, height: 700 });
    expect(pos.left + 260).toBeLessThanOrEqual(320 - TIP_VIEWPORT_MARGIN);
    expect(pos.left).toBeGreaterThanOrEqual(TIP_VIEWPORT_MARGIN);
  });

  it('clamps the left edge for an anchor near the left viewport edge', () => {
    const anchor = rect({ top: 10, bottom: 38, left: 2, right: 30, width: 28 });
    const pos = computeTipPosition(anchor, { width: 260, height: 40 }, { width: 320, height: 700 });
    expect(pos.left).toBeGreaterThanOrEqual(TIP_VIEWPORT_MARGIN);
    expect(pos.left + 260).toBeLessThanOrEqual(320 - TIP_VIEWPORT_MARGIN + 0.001);
  });

  it('never places the box outside the viewport on either axis at 320px', () => {
    for (const anchorLeft of [0, 50, 150, 250, 300, 320]) {
      const anchor = rect({ top: 400, bottom: 428, left: anchorLeft, right: anchorLeft + 28, width: 28 });
      const pos = computeTipPosition(anchor, { width: 260, height: 40 }, { width: 320, height: 700 });
      expect(pos.left).toBeGreaterThanOrEqual(0);
      expect(pos.left + 260).toBeLessThanOrEqual(320);
    }
  });

  it('keeps the connector pointing at the anchor even once the box is clamped', () => {
    const anchor = rect({ top: 10, bottom: 38, left: 270, right: 298, width: 28 });
    const pos = computeTipPosition(anchor, { width: 260, height: 40 }, { width: 320, height: 700 });
    // The connector's absolute viewport position (box left + its offset)
    // should still land under the anchor's own center.
    const anchorCenter = anchor.left + anchor.width / 2;
    expect(pos.left + pos.connectorX).toBeCloseTo(anchorCenter, 0);
  });
});

// ── installTipLayer: show/hide wiring ──────────────────────────────────────

class FakeElement {
  readonly tagName: string;
  dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly style: { [key: string]: unknown; setProperty: (k: string, v: string) => void } = {
    setProperty(k: string, v: string) {
      this[k] = v;
    },
  };
  private _classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this._classes.add(c),
    remove: (c: string) => this._classes.delete(c),
    contains: (c: string) => this._classes.has(c),
  };
  parent: FakeElement | null = null;
  textContent = '';
  rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  focusVisible = false;

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  hasClass(c: string): boolean {
    return this._classes.has(c);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  appendChild(child: FakeElement): void {
    child.parent = this;
  }
  contains(node: unknown): boolean {
    let n = node as FakeElement | null;
    while (n) {
      if (n === (this as unknown)) return true;
      n = n.parent;
    }
    return false;
  }
  /** Only ever asked for `[data-tip]` in this module — walk up for it. */
  closest(selector: string): FakeElement | null {
    if (selector !== '[data-tip]') return null;
    let n: FakeElement | null = this;
    while (n) {
      if (n.dataset.tip) return n;
      n = n.parent;
    }
    return null;
  }
  matches(selector: string): boolean {
    if (selector === ':focus-visible') return this.focusVisible;
    return false;
  }
  getBoundingClientRect() {
    return this.rect;
  }
}

interface FakeDoc {
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  createElement: (tag: string) => FakeElement;
  body: FakeElement;
  defaultView: FakeWindow;
}
interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  HTMLElement: typeof FakeElement;
  matchMedia: (q: string) => { matches: boolean };
  addEventListener: (type: string, fn: (ev?: unknown) => void) => void;
}

function makeFakeEnv(hoverNone = false) {
  const docHandlers = new Map<string, ((ev: unknown) => void)[]>();
  const winHandlers = new Map<string, ((ev?: unknown) => void)[]>();
  const body = new FakeElement('body');
  const win: FakeWindow = {
    innerWidth: 1280,
    innerHeight: 860,
    HTMLElement: FakeElement,
    matchMedia: (q: string) => ({ matches: hoverNone && q === '(hover: none)' }),
    addEventListener: (type, fn) => {
      (winHandlers.get(type) ?? winHandlers.set(type, []).get(type)!).push(fn);
    },
  };
  const created: FakeElement[] = [];
  const doc: FakeDoc = {
    addEventListener: (type, fn) => {
      (docHandlers.get(type) ?? docHandlers.set(type, []).get(type)!).push(fn);
    },
    createElement: (tag) => {
      const el = new FakeElement(tag);
      created.push(el);
      return el;
    },
    body,
    defaultView: win,
  };
  const fire = (type: string, ev: unknown = {}): void => {
    for (const fn of docHandlers.get(type) ?? []) fn(ev);
  };
  const fireWin = (type: string): void => {
    for (const fn of winHandlers.get(type) ?? []) fn();
  };
  /** The tip layer element itself — the one thing this module creates via
   *  `doc.createElement`, so the first (and only) entry is always it. */
  const layer = (): FakeElement => created[0];
  return { doc, win, fire, fireWin, created, layer };
}

describe('installTipLayer', () => {
  let env: ReturnType<typeof makeFakeEnv>;
  let installTipLayer: typeof import('../src/ui/tipLayer').installTipLayer;
  let hideTip: typeof import('../src/ui/tipLayer').hideTip;

  beforeEach(async () => {
    // Fresh module state per test — the layer/anchor are module-level.
    const mod = await import('../src/ui/tipLayer');
    installTipLayer = mod.installTipLayer;
    hideTip = mod.hideTip;
    hideTip();
    env = makeFakeEnv();
    installTipLayer(env.doc as unknown as Document);
  });

  function anchorWithTip(tip: string): FakeElement {
    const el = new FakeElement('button');
    el.dataset.tip = tip;
    el.rect = { top: 100, left: 100, right: 150, bottom: 120, width: 50, height: 20 };
    return el;
  }

  it('shows the layer on a mouse pointerover of a [data-tip] control', () => {
    const anchor = anchorWithTip('Runs the thing.');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    expect(layer).toBeTruthy();
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(true);
    expect(layer.parent).toBe(env.doc.body); // appended to body, the root stacking context
  });

  it('positions the layer below the anchor from its bounding rect', () => {
    const anchor = anchorWithTip('Explains itself.');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    // The fake layer's own rect defaults to zero size, so with the anchor at
    // top:100/bottom:120/left:100/width:50 the box should land at
    // (bottom + gap, center - 0) = (128, 125).
    expect(layer.style.top).toBe('128px');
    expect(layer.style.left).toBe('125px');
    expect(layer.dataset.placement).toBe('below');
  });

  it('ignores a touch pointerover (no hover tip on touch)', () => {
    const anchor = anchorWithTip('x');
    let created = 0;
    const doc = env.doc;
    const originalCreate = doc.createElement;
    doc.createElement = (tag) => {
      created++;
      return originalCreate(tag);
    };
    env.fire('pointerover', { target: anchor, pointerType: 'touch' });
    expect(created).toBe(0);
  });

  it('never shows from pointer hover when the device reports (hover: none)', () => {
    const noHoverEnv = makeFakeEnv(true);
    installTipLayer(noHoverEnv.doc as unknown as Document);
    const anchor = anchorWithTip('x');
    let created = 0;
    const originalCreate = noHoverEnv.doc.createElement;
    noHoverEnv.doc.createElement = (tag) => {
      created++;
      return originalCreate(tag);
    };
    noHoverEnv.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    expect(created).toBe(0);
  });

  it('shows on keyboard focus (:focus-visible) but not a mouse-driven focus', () => {
    const anchor = anchorWithTip('Explains itself.');
    anchor.focusVisible = false;
    let created = 0;
    const originalCreate = env.doc.createElement;
    env.doc.createElement = (tag) => {
      created++;
      return originalCreate(tag);
    };
    env.fire('focusin', { target: anchor });
    expect(created).toBe(0);

    anchor.focusVisible = true;
    env.fire('focusin', { target: anchor });
    expect(created).toBe(1);
  });

  it('hides on Escape', () => {
    const anchor = anchorWithTip('x');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(true);
    env.fire('keydown', { key: 'Escape' });
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(false);
  });

  it('ignores a non-Escape key', () => {
    const anchor = anchorWithTip('x');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    env.fire('keydown', { key: 'a' });
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(true);
  });

  it('hides on pointerout past the anchor', () => {
    const anchor = anchorWithTip('x');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    env.fire('pointerout', { target: anchor, relatedTarget: null });
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(false);
  });

  it('stays visible when pointerout moves to a child of the anchor', () => {
    const anchor = anchorWithTip('x');
    const child = new FakeElement('span');
    child.parent = anchor;
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    env.fire('pointerout', { target: anchor, relatedTarget: child });
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(true);
  });

  it('hides on focusout of the anchor', () => {
    const anchor = anchorWithTip('x');
    anchor.focusVisible = true;
    env.fire('focusin', { target: anchor });
    const layer = env.layer();
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(true);
    env.fire('focusout', { target: anchor });
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(false);
  });

  it('hides on window scroll', () => {
    const anchor = anchorWithTip('x');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    env.fireWin('scroll');
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(false);
  });

  it('hides on window resize', () => {
    const anchor = anchorWithTip('x');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    env.fireWin('resize');
    expect(layer.hasClass('olv-tip-layer--visible')).toBe(false);
  });

  it('sets the layer text to the anchor’s data-tip', () => {
    const anchor = anchorWithTip('Download the flow rasters as a ZIP.');
    env.fire('pointerover', { target: anchor, pointerType: 'mouse' });
    const layer = env.layer();
    expect(layer.textContent).toBe('Download the flow rasters as a ZIP.');
  });
});
