/**
 * contourStudioWorkspace.test.ts
 *
 * Controller store behavior + the workspace shell render (spec §5.3/§6/§7),
 * using the node-environment recording DOM stub. Verifies purpose selection
 * dispatches + re-renders, the evidence ladder is tied to the launch state, and
 * a blocked launch disables exports.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createContourStudioController } from '../src/terrain/contourStudio/contourStudioController';
import { renderContourStudioWorkspace } from '../src/ui/contourStudioWorkspace';
import type { ContourStudioLaunchState } from '../src/terrain/contourStudio/contourStudioLaunchState';

class FakeEl {
  readonly tagName: string;
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  readonly children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = { contains: (c: string): boolean => this.className.split(/\s+/).includes(c) };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  append(...kids: FakeEl[]): void { for (const k of kids) this.children.push(k); }
  replaceChildren(): void { this.children.length = 0; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  addEventListener(t: string, fn: () => void): void {
    const a = this.listeners.get(t) ?? []; a.push(fn); this.listeners.set(t, a);
  }
  click(): void { if (!this.disabled) for (const fn of this.listeners.get('click') ?? []) fn(); }
  byClass(c: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => { if (n.classList.contains(c)) out.push(n); n.children.forEach(walk); };
    walk(this); return out;
  }
  allText(): string { return this.children.reduce((t, c) => t + ' ' + c.allText(), this.textContent); }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

const AVAILABLE: ContourStudioLaunchState = {
  status: 'available', title: 't', message: 'm', visible: true, actionEnabled: true, actionLabel: 'Create Contour Deliverable',
};
const UNAVAILABLE: ContourStudioLaunchState = {
  status: 'unavailable', title: 't', message: 'm', reasons: ['no surface'], visible: true, actionEnabled: false,
};

describe('createContourStudioController', () => {
  it('dispatches through the reducer and notifies subscribers', () => {
    const c = createContourStudioController();
    const seen = vi.fn();
    c.subscribe(seen);
    c.dispatch({ type: 'set-purpose', purpose: 'engineering-plan' });
    expect(c.getState().purpose).toBe('engineering-plan');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const c = createContourStudioController();
    const seen = vi.fn();
    const off = c.subscribe(seen);
    off();
    c.dispatch({ type: 'set-purpose', purpose: 'survey-review' });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('renderContourStudioWorkspace', () => {
  it('renders purpose cards; clicking one dispatches set-purpose and re-renders', () => {
    const c = createContourStudioController();
    const root = renderContourStudioWorkspace({ controller: c, launch: AVAILABLE }) as unknown as FakeEl;
    const cards = root.byClass('olv-cs-purpose-card');
    expect(cards.length).toBe(5);
    // The Survey Review card is the 2nd in order.
    const survey = cards[1];
    survey.click();
    expect(c.getState().purpose).toBe('survey-review');
    // After re-render, survey is now the selected card.
    const selected = root.byClass('is-selected');
    expect(selected.length).toBe(1);
  });

  it('evidence ladder claim reflects the launch state', () => {
    const c = createContourStudioController();
    const avail = renderContourStudioWorkspace({ controller: c, launch: AVAILABLE }) as unknown as FakeEl;
    expect(avail.allText()).toContain('Supported');
    const c2 = createContourStudioController();
    const blocked = renderContourStudioWorkspace({ controller: c2, launch: UNAVAILABLE }) as unknown as FakeEl;
    expect(blocked.allText()).toContain('Blocked');
  });

  it('a blocked launch marks the evidence claim Blocked and every check failed', () => {
    const c = createContourStudioController();
    const root = renderContourStudioWorkspace({ controller: c, launch: UNAVAILABLE }) as unknown as FakeEl;
    // The workspace no longer renders its own (unwired) export buttons — the
    // single working export surface lives in the panel. A blocked launch is
    // conveyed by the evidence claim line and blocked check rows.
    expect(root.byClass('olv-cs-export-btn').length).toBe(0);
    const claim = root.byClass('olv-cs-ladder-claim');
    expect(claim.length).toBe(1);
    expect(claim[0].allText()).toContain('Blocked');
    expect(root.byClass('is-blocked').length).toBeGreaterThan(0);
  });

  it('renders the review bar rows when a review summary is provided', () => {
    const c = createContourStudioController();
    const review = {
      rows: [
        { key: 'grid' as const, label: 'Grid', value: '0.25 m · recommended', rationale: ['because spacing'], confidence: 'high' as const },
        { key: 'evidence' as const, label: 'Evidence', value: 'Supported', rationale: [], confidence: 'high' as const },
      ],
    };
    const root = renderContourStudioWorkspace({ controller: c, launch: AVAILABLE, review }) as unknown as FakeEl;
    expect(root.byClass('olv-cs-review').length).toBe(1);
    expect(root.allText()).toContain('0.25 m · recommended');
  });

  it('the settings summary reflects the current purpose', () => {
    const c = createContourStudioController();
    const root = renderContourStudioWorkspace({ controller: c, launch: AVAILABLE }) as unknown as FakeEl;
    c.dispatch({ type: 'set-purpose', purpose: 'survey-review' });
    // survey-review forbids exploratory output — the summary should say so.
    expect(root.allText()).toContain('not for this purpose');
  });
});
