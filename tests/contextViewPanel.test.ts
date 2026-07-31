/**
 * contextViewPanel.test.ts
 *
 * DOM coverage for the Context View panel shell, using the same
 * node-environment recording DOM stub the other panel builder tests use (no
 * jsdom dependency). Pins the privacy contract: ineligible states show only
 * refusal reasons; the consent gate precedes any basemap; denied stays quiet;
 * granted shows attribution while tiles remain STAGED — and no element in ANY
 * state carries a `src`/`href`, because this build performs zero network I/O.
 * Also pins the pure equirectangular projection math in `projectToCanvas`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  renderContextViewPanel,
  type ContextViewPanelOptions,
  type ContextViewPanelState,
} from '../src/ui/contextView/ContextViewPanel';
import {
  projectToCanvas,
  drawFootprints,
  footprintBounds,
} from '../src/ui/contextView/footprintCanvas';
import { CONTEXT_STATUS, OSM_PROVIDER, type ContextFootprint } from '../src/geo/context/index';

/** Recording 2d-context stub: enough for the footprint renderer + assertions. */
class FakeCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  readonly ops: string[] = [];
  clearRect(): void {
    this.ops.push('clearRect');
  }
  beginPath(): void {
    this.ops.push('beginPath');
  }
  moveTo(): void {
    this.ops.push('moveTo');
  }
  lineTo(): void {
    this.ops.push('lineTo');
  }
  closePath(): void {
    this.ops.push('closePath');
  }
  stroke(): void {
    this.ops.push('stroke');
  }
  arc(): void {
    this.ops.push('arc');
  }
  fill(): void {
    this.ops.push('fill');
  }
}

/** Minimal recording element: enough for the panel builder + assertions. */
class FakeEl {
  readonly tagName: string;
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  width = 0;
  height = 0;
  readonly children: FakeEl[] = [];
  readonly ctx = new FakeCtx();
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(child: FakeEl): void {
    this.children.push(child);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  getContext(kind: string): FakeCtx | null {
    return kind === '2d' ? this.ctx : null;
  }
  /** Supports comma lists of `tag` and `[attr]` selectors — all this suite needs. */
  querySelectorAll(selector: string): FakeEl[] {
    const parts = selector.split(',').map((s) => s.trim());
    const out: FakeEl[] = [];
    const matches = (n: FakeEl): boolean =>
      parts.some((p) =>
        p.startsWith('[') && p.endsWith(']')
          ? n.getAttribute(p.slice(1, -1)) !== null
          : n.tagName === p.toUpperCase(),
      );
    const walk = (n: FakeEl): void => {
      if (matches(n)) out.push(n);
      n.children.forEach(walk);
    };
    this.children.forEach(walk);
    return out;
  }
  /** Depth-first descendants (including self) matching a class. */
  byClass(c: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      if (n.classList.contains(c)) out.push(n);
      n.children.forEach(walk);
    };
    walk(this);
    return out;
  }
  /** Concatenated text of self + descendants. */
  allText(): string {
    let t = this.textContent;
    for (const c of this.children) t += ' ' + c.allText();
    return t;
  }
}

const fetchSpy = vi.fn(() => {
  throw new Error('Context View must not touch the network');
});

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  // A tripwire, not a mock: if any code path under test ever reached for the
  // network, this throws and the render test fails loudly.
  (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
});

const FOOTPRINTS: readonly ContextFootprint[] = [
  {
    layerId: 'scan-a',
    name: 'Scan A',
    ringLonLat: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  },
];

const INELIGIBLE: ContextViewPanelState = {
  consent: 'unasked',
  eligible: false,
  reasons: [
    'This scan uses local or unreferenced coordinates that do not correspond to any place on Earth.',
    'No transform to WGS84 longitude/latitude is available for this scan, so it cannot be projected onto the map.',
  ],
  footprints: [],
};
const UNASKED: ContextViewPanelState = {
  consent: 'unasked',
  eligible: true,
  reasons: [],
  footprints: FOOTPRINTS,
};
const DENIED: ContextViewPanelState = { ...UNASKED, consent: 'denied' };
const GRANTED: ContextViewPanelState = { ...UNASKED, consent: 'granted' };

const render = (state: ContextViewPanelState, opts: ContextViewPanelOptions = {}): FakeEl =>
  renderContextViewPanel(state, opts) as unknown as FakeEl;

describe('renderContextViewPanel — ineligible', () => {
  it('renders the refusal reasons as a <ul> with one <li> each', () => {
    const panel = render(INELIGIBLE);
    const list = panel.byClass('olv-context-reasons')[0];
    expect(list?.tagName).toBe('UL');
    expect(list?.children.length).toBe(2);
    expect(list?.children.every((li) => li.tagName === 'LI')).toBe(true);
    expect(panel.allText()).toContain('local or unreferenced coordinates');
  });

  it('shows NO consent buttons and NO canvas when ineligible', () => {
    const panel = render(INELIGIBLE);
    expect(panel.querySelectorAll('button').length).toBe(0);
    expect(panel.querySelectorAll('canvas').length).toBe(0);
  });
});

describe('renderContextViewPanel — empty (no layers)', () => {
  const EMPTY: ContextViewPanelState = {
    consent: 'unasked',
    eligible: false,
    empty: true,
    reasons: [],
    footprints: [],
  };

  it('says nothing is loaded, and makes no claim about CRS, datum, or a transform', () => {
    const panel = render(EMPTY);
    const text = panel.allText();
    expect(text).toContain('No scan is loaded');
    expect(text).not.toContain(CONTEXT_STATUS.transformUnavailable);
    expect(text).not.toContain(CONTEXT_STATUS.boundsNotFinite);
    expect(text).not.toContain(CONTEXT_STATUS.crsUnknown);
    expect(text).not.toContain(CONTEXT_STATUS.datumUnknown);
    expect(text).not.toContain('This scan cannot be shown on a world map.');
  });

  it('shows no refusal list, no consent buttons, and no canvas', () => {
    const panel = render(EMPTY);
    expect(panel.byClass('olv-context-reasons').length).toBe(0);
    expect(panel.querySelectorAll('button').length).toBe(0);
    expect(panel.querySelectorAll('canvas').length).toBe(0);
  });
});

describe('renderContextViewPanel — consent gate (unasked)', () => {
  it('renders the consent prompt, both buttons, and the offline canvas', () => {
    const panel = render(UNASKED);
    expect(panel.allText()).toContain(CONTEXT_STATUS.consentUnasked);
    const buttons = panel.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    expect(panel.querySelectorAll('canvas').length).toBe(1);
    expect(panel.allText()).toContain(CONTEXT_STATUS.offlineMode);
  });

  it('fires onGrant from the grant button only', () => {
    const onGrant = vi.fn();
    const onDeny = vi.fn();
    const panel = render(UNASKED, { onGrant, onDeny });
    panel.byClass('olv-context-grant')[0]!.click();
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('fires onDeny from the deny button only', () => {
    const onGrant = vi.fn();
    const onDeny = vi.fn();
    const panel = render(UNASKED, { onGrant, onDeny });
    panel.byClass('olv-context-deny')[0]!.click();
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onGrant).not.toHaveBeenCalled();
  });
});

describe('renderContextViewPanel — denied', () => {
  it('shows the quiet denied line and the offline canvas, without the prompt', () => {
    const panel = render(DENIED);
    expect(panel.allText()).toContain(CONTEXT_STATUS.consentDenied);
    expect(panel.allText()).not.toContain(CONTEXT_STATUS.consentUnasked);
    expect(panel.querySelectorAll('canvas').length).toBe(1);
    // No re-prompt pair; only the single small change affordance remains.
    expect(panel.byClass('olv-context-grant').length).toBe(0);
    expect(panel.byClass('olv-context-deny').length).toBe(0);
    expect(panel.byClass('olv-context-change').length).toBe(1);
  });
});

describe('renderContextViewPanel — granted', () => {
  it('shows the provider attribution and the staged-tiles note', () => {
    const panel = render(GRANTED);
    expect(panel.allText()).toContain(OSM_PROVIDER.attribution);
    expect(panel.byClass('olv-context-staged')[0]?.textContent).toContain('staged');
    expect(panel.querySelectorAll('canvas').length).toBe(1);
  });
});

describe('renderContextViewPanel — no-network-DOM invariant', () => {
  it('no element in ANY state carries a src or href, and fetch is never touched', () => {
    for (const state of [INELIGIBLE, UNASKED, DENIED, GRANTED]) {
      const panel = render(state);
      expect(panel.querySelectorAll('[src],[href]').length).toBe(0);
    }
    // Module import + all four renders completed without a single network call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('renderContextViewPanel — accessibility contract', () => {
  it('the panel is a labelled region', () => {
    const panel = render(UNASKED);
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-label')).toBe('World context');
  });

  it('the canvas is an img with a footprint-count label', () => {
    const canvas = render(UNASKED).querySelectorAll('canvas')[0]!;
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toContain('1 scan footprint');
  });
});

describe('drawFootprints — offline guard', () => {
  it('an empty footprint list draws nothing and returns false', () => {
    const canvas = new FakeEl('canvas');
    expect(drawFootprints(canvas as unknown as HTMLCanvasElement, [])).toBe(false);
    expect(canvas.ctx.ops.length).toBe(0);
  });

  it('a footprint list strokes outlines (and a heading marker when given)', () => {
    const canvas = new FakeEl('canvas');
    canvas.width = 120;
    canvas.height = 120;
    const drew = drawFootprints(canvas as unknown as HTMLCanvasElement, FOOTPRINTS, {
      position: [5, 5],
      headingDeg: 90,
    });
    expect(drew).toBe(true);
    expect(canvas.ctx.ops).toContain('stroke');
    expect(canvas.ctx.ops).toContain('arc'); // camera marker
  });
});

describe('projectToCanvas — pure equirectangular math', () => {
  const bounds = { minLon: 0, maxLon: 10, minLat: 0, maxLat: 10 };
  const size = { width: 120, height: 120 };

  it('maps the bound corners with 10% padding inset (north up)', () => {
    // Padded frame: [-1, 11] on both axes over 120px → min corner 10px in.
    expect(projectToCanvas(bounds, size, [0, 0])).toEqual([10, 110]);
    expect(projectToCanvas(bounds, size, [10, 10])).toEqual([110, 10]);
    expect(projectToCanvas(bounds, size, [5, 5])).toEqual([60, 60]);
  });

  it('keeps every bound point inside the canvas (the padding is real)', () => {
    const [x, y] = projectToCanvas(bounds, size, [0, 10]);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeLessThan(size.width);
    expect(y).toBeLessThan(size.height);
  });

  it('degenerate single-point bounds project to the centre without NaN', () => {
    const point = { minLon: 3, maxLon: 3, minLat: 7, maxLat: 7 };
    const [x, y] = projectToCanvas(point, size, [3, 7]);
    expect(x).toBe(60);
    expect(y).toBe(60);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('footprintBounds combines rings and refuses an all-empty set', () => {
    expect(footprintBounds(FOOTPRINTS)).toEqual({
      minLon: 0,
      maxLon: 10,
      minLat: 0,
      maxLat: 10,
    });
    expect(footprintBounds([])).toBeNull();
  });
});
