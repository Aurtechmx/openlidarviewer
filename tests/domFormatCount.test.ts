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

  it('never rounds a K up to 1000.0K', () => {
    expect(formatCount(999_949)).toBe('999.9K');
    expect(formatCount(999_950)).toBe('1.0M');
    expect(formatCount(999_999)).toBe('1.0M');
  });

  it('has no band above M, so a large count stays in M', () => {
    expect(formatCount(999_949_999)).toBe('999.9M');
    expect(formatCount(999_950_000)).toBe('1000.0M');
    expect(formatCount(1_500_000_000)).toBe('1500.0M');
  });
});
