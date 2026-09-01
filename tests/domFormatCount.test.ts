/**
 * formatCount — the compact point-count formatter, pinned at its three-band
 * boundaries. Below 1_000 the raw integer is emitted verbatim; 1_000 and up
 * switches to one-decimal "K"; 1_000_000 and up to one-decimal "M". The
 * threshold cases (999 vs 1000, and the 1M crossover) are the ones a refactor
 * would most easily shift. Imported from `ui/dom`, whose module top level is
 * DOM-free, so no DOM shim is needed.
 */
import { describe, it, expect } from 'vitest';
import { formatCount } from '../src/ui/dom';

describe('formatCount', () => {
  it('emits values below 1000 verbatim', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('switches to one-decimal K at 1000', () => {
    expect(formatCount(1000)).toBe('1.0K');
    expect(formatCount(1500)).toBe('1.5K');
  });

  it('switches to one-decimal M at 1_000_000', () => {
    expect(formatCount(1_000_000)).toBe('1.0M');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });
});
