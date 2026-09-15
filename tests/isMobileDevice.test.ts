import { describe, it, expect } from 'vitest';
import {
  classifyMobile,
  isTouchFirstDevice,
  matchesMobileLayout,
  MOBILE_LAYOUT_QUERY,
} from '../src/ui/isMobileDevice';

describe('classifyMobile', () => {
  it('narrow window is mobile even with a mouse', () => {
    expect(classifyMobile(true, false)).toBe(true);
  });
  it('wide landscape phone (coarse, no hover) is still mobile', () => {
    expect(classifyMobile(false, true)).toBe(true);
  });
  it('wide desktop with a mouse is not mobile', () => {
    expect(classifyMobile(false, false)).toBe(false);
  });
});

describe('matchesMobileLayout (orientation-independent layout gate)', () => {
  it('portrait phone (narrow) uses the mobile layout', () => {
    expect(matchesMobileLayout(390, 844, true)).toBe(true);
  });
  it('LANDSCAPE phone (wide + short + coarse) uses the mobile layout', () => {
    // The regression: rotated to landscape the width exceeds 767px, but the
    // viewport is short and the pointer is coarse, so it must stay mobile.
    expect(matchesMobileLayout(844, 390, true)).toBe(true);
  });
  it('a real desktop (wide + tall + fine pointer) is NOT mobile', () => {
    expect(matchesMobileLayout(1440, 900, false)).toBe(false);
  });
  it('a short desktop window with a mouse is NOT captured by the landscape arm', () => {
    // Wide + short but fine pointer → the coarse arm does not fire.
    expect(matchesMobileLayout(1440, 480, false)).toBe(false);
  });
  it('a narrow desktop window keeps today\'s width-only behaviour', () => {
    expect(matchesMobileLayout(700, 900, false)).toBe(true);
  });
});

describe('MOBILE_LAYOUT_QUERY', () => {
  it('is an OR of the width breakpoint and the short-coarse landscape arm', () => {
    expect(MOBILE_LAYOUT_QUERY).toContain('(max-width: 767px)');
    expect(MOBILE_LAYOUT_QUERY).toContain('(max-height: 500px) and (pointer: coarse)');
    // The comma is the media-query OR the CSS layout blocks mirror.
    expect(MOBILE_LAYOUT_QUERY).toContain(',');
  });
});

describe('isTouchFirstDevice (the device half alone)', () => {
  const g = globalThis as unknown as { window?: unknown };
  const withMatchMedia = (matches: (q: string) => boolean, run: () => void): void => {
    const saved = g.window;
    g.window = { matchMedia: (q: string) => ({ matches: matches(q) }) };
    try { run(); } finally { g.window = saved; }
  };

  it('is true for a coarse pointer with no hover, whatever the window size', () => {
    withMatchMedia((q) => q.includes('pointer: coarse') && q.includes('hover: none'), () => {
      expect(isTouchFirstDevice()).toBe(true);
    });
  });

  it('is false for a narrow window driven by a mouse', () => {
    withMatchMedia((q) => q.includes('max-width'), () => {
      expect(isTouchFirstDevice()).toBe(false);
    });
  });

  it('is false without a window', () => {
    const saved = g.window;
    g.window = undefined;
    try { expect(isTouchFirstDevice()).toBe(false); } finally { g.window = saved; }
  });
});
