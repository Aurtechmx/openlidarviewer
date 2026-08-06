import { describe, it, expect } from 'vitest';
import {
  classifyMobile,
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
