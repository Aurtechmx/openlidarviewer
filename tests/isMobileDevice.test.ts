import { describe, it, expect } from 'vitest';
import { classifyMobile } from '../src/ui/isMobileDevice';

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
