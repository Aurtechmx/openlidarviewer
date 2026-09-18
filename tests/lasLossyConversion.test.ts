/**
 * lasLossyConversion.test.ts — writing a modern classification into the legacy
 * 5-bit field does not fail loudly, it lands on another valid class. These
 * tests pin what the writer must detect before it agrees to do that.
 */

import { describe, it, expect } from 'vitest';
import {
  canRepresentInLegacy,
  inspectLegacyConversion,
  isLossy,
  describeLoss,
  LEGACY_MAX_CLASS,
} from '../src/lasSemantics';

describe('which codes the legacy field can hold', () => {
  it('accepts 0 through 31', () => {
    expect(canRepresentInLegacy(0)).toBe(true);
    expect(canRepresentInLegacy(LEGACY_MAX_CLASS)).toBe(true);
  });

  it('rejects anything above 31', () => {
    expect(canRepresentInLegacy(32)).toBe(false);
    expect(canRepresentInLegacy(64)).toBe(false);
    expect(canRepresentInLegacy(255)).toBe(false);
  });
});

describe('inspecting a conversion', () => {
  it('reports nothing to lose for an ordinary legacy set', () => {
    const c = inspectLegacyConversion([0, 1, 2, 5, 6, 9, 12]);
    expect(c.wrappingCodes).toEqual([]);
    expect(isLossy(c)).toBe(false);
  });

  it('collects the codes that would wrap', () => {
    const c = inspectLegacyConversion([2, 64, 20, 200]);
    expect(c.wrappingCodes).toEqual([64, 200]);
    expect(isLossy(c)).toBe(true);
  });

  it('counts a repeated code once', () => {
    expect(inspectLegacyConversion([64, 64, 64]).wrappingCodes).toEqual([64]);
  });

  it('treats a lost overlap flag as lossy on its own', () => {
    const c = inspectLegacyConversion([2], true);
    expect(c.wrappingCodes).toEqual([]);
    expect(isLossy(c)).toBe(true);
  });

  it('keeps codes 19 to 22 representable, since they fit the field', () => {
    const c = inspectLegacyConversion([19, 20, 21, 22]);
    expect(c.wrappingCodes).toEqual([]);
  });
});

describe('the wrap is silent, which is the danger', () => {
  it('lands a user class on a defined legacy class', () => {
    expect(64 & 0x1f).toBe(0);
    expect(96 & 0x1f).toBe(0);
    expect(66 & 0x1f).toBe(2);
  });

  it('names what would be lost', () => {
    const text = describeLoss(inspectLegacyConversion([64], true), 6);
    expect(text).toContain('64');
    expect(text).toContain('User Definable');
    expect(text).toContain('overlap flag');
  });
});
