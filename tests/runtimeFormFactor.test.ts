import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyFormFactor, LARGE_TOUCH_MIN_SHORT_SIDE, runtimeFormFactor } from '../src/platform/runtimeFormFactor';

describe('classifyFormFactor', () => {
  it.each([
    [false, 1920, 1080, 'desktop'],
    [false, 390, 844, 'desktop'],
    [true, 390, 844, 'phone'],
    [true, 844, 390, 'phone'],
    [true, 800, 1280, 'large-touch'],
    [true, 1280, 800, 'large-touch'],
    [true, LARGE_TOUCH_MIN_SHORT_SIDE, 1000, 'large-touch'],
    [true, LARGE_TOUCH_MIN_SHORT_SIDE - 1, 1000, 'phone'],
  ] as const)('touchFirst=%s %ix%i -> %s', (touchFirst, w, h, want) => {
    expect(classifyFormFactor({ touchFirst, viewportWidth: w, viewportHeight: h })).toBe(want);
  });

  it('never returns embedded-field from static signals', () => {
    for (const touchFirst of [true, false]) for (const w of [320, 800, 2560]) {
      expect(classifyFormFactor({ touchFirst, viewportWidth: w, viewportHeight: w })).not.toBe('embedded-field');
    }
  });
});

describe('runtimeFormFactor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the touch-first query and re-reads the viewport after a resize', () => {
    const win = { innerWidth: 1280, innerHeight: 800, matchMedia: (q: string) => ({ matches: q === '(pointer: coarse) and (hover: none)' }) };
    vi.stubGlobal('window', win);
    expect(runtimeFormFactor()).toBe('large-touch');
    win.innerWidth = 500;
    win.innerHeight = 900;
    expect(runtimeFormFactor()).toBe('phone');
    win.matchMedia = () => ({ matches: false });
    expect(runtimeFormFactor()).toBe('desktop');
  });
});
