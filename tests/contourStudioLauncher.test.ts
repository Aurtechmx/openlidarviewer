/**
 * contourStudioLauncher.test.ts
 *
 * DOM coverage for the Terrain Products launcher surface, using the same
 * node-environment recording DOM stub the other Analyse-panel builder tests use
 * (no jsdom dependency). Verifies: nothing renders before analysis; a disabled
 * action with reasons when unavailable; an enabled exploratory action; the full
 * deliverable action when available; and that the action fires only when enabled.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { renderContourStudioLauncher } from '../src/ui/contourStudioLauncher';
import type { ContourStudioLaunchState } from '../src/terrain/contourStudio/contourStudioLaunchState';

/** Minimal recording element: enough for the launcher builder + assertions. */
class FakeEl {
  readonly tagName: string;
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  readonly children: FakeEl[] = [];
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
    if (this.disabled) return; // mirror the browser: disabled buttons don't fire click
    for (const fn of this.listeners.get('click') ?? []) fn();
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
  /** First descendant with the given tag. */
  firstTag(tag: string): FakeEl | undefined {
    const want = tag.toUpperCase();
    const stack = [...this.children];
    while (stack.length) {
      const n = stack.shift()!;
      if (n.tagName === want) return n;
      stack.unshift(...n.children);
    }
    return undefined;
  }
  /** Concatenated text of self + descendants. */
  allText(): string {
    let t = this.textContent;
    for (const c of this.children) t += ' ' + c.allText();
    return t;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

const NOT_ANALYZED: ContourStudioLaunchState = {
  status: 'not-analyzed',
  title: 'Analyze scan first',
  message: 'Run scan analysis to create terrain-derived contours.',
  visible: false,
};
const UNAVAILABLE: ContourStudioLaunchState = {
  status: 'unavailable',
  title: 'Contours unavailable',
  message: 'This scan cannot produce a contour deliverable yet.',
  reasons: ['No terrain surface has been computed.'],
  visible: true,
  actionEnabled: false,
};
const EXPLORATORY: ContourStudioLaunchState = {
  status: 'exploratory',
  title: 'Exploratory contours available',
  message: 'Contours can be created for inspection.',
  reasons: ['Vertical units are unknown; metric-supported contour intervals cannot be claimed.'],
  visible: true,
  actionEnabled: true,
  actionLabel: 'Create Exploratory Contours',
};
const AVAILABLE: ContourStudioLaunchState = {
  status: 'available',
  title: 'Contour deliverable available',
  message: 'Ready to export.',
  visible: true,
  actionEnabled: true,
  actionLabel: 'Create Contour Deliverable',
};

describe('renderContourStudioLauncher', () => {
  it('renders nothing before analysis', () => {
    expect(renderContourStudioLauncher(NOT_ANALYZED)).toBeNull();
  });

  it('renders a disabled action with reasons when unavailable', () => {
    const card = renderContourStudioLauncher(UNAVAILABLE) as unknown as FakeEl;
    expect(card).not.toBeNull();
    expect(card.classList.contains('is-unavailable')).toBe(true);
    const button = card.firstTag('button')!;
    expect(button.disabled).toBe(true);
    expect(card.byClass('olv-contour-launcher-reasons')[0]?.children.length).toBe(1);
    expect(card.allText()).toContain('No terrain surface has been computed.');
  });

  it('does not fire onLaunch for the disabled (unavailable) action', () => {
    const onLaunch = vi.fn();
    const card = renderContourStudioLauncher(UNAVAILABLE, { onLaunch }) as unknown as FakeEl;
    card.firstTag('button')!.click();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('renders an enabled exploratory action with its label + reasons', () => {
    const card = renderContourStudioLauncher(EXPLORATORY) as unknown as FakeEl;
    expect(card.classList.contains('is-exploratory')).toBe(true);
    const button = card.firstTag('button')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Create Exploratory Contours');
    expect(card.allText()).toContain('Vertical units are unknown');
  });

  it('renders the full deliverable action when available and fires onLaunch', () => {
    const onLaunch = vi.fn();
    const card = renderContourStudioLauncher(AVAILABLE, { onLaunch }) as unknown as FakeEl;
    expect(card.classList.contains('is-available')).toBe(true);
    const button = card.firstTag('button')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Create Contour Deliverable');
    button.click();
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it('the available state carries no reasons list', () => {
    const card = renderContourStudioLauncher(AVAILABLE) as unknown as FakeEl;
    expect(card.byClass('olv-contour-launcher-reasons').length).toBe(0);
  });
});
