/**
 * pageErrors.test.ts — the benign-browser-error allowlist stays tight.
 * A real app error must never be filtered; the known-benign ResizeObserver
 * notification must be.
 */

import { describe, it, expect } from 'vitest';
import { isBenignPageError } from './e2e/pageErrors';

describe('isBenignPageError', () => {
  it('filters the benign ResizeObserver notifications (both spellings)', () => {
    expect(isBenignPageError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignPageError('ResizeObserver loop limit exceeded')).toBe(true);
  });

  it('never filters a real application error', () => {
    for (const real of [
      'TypeError: Cannot read properties of undefined (reading \'x\')',
      'WebGL: INVALID_OPERATION',
      'Uncaught Error: boom',
      'ReferenceError: viewer is not defined',
      '', // empty message is not benign
    ]) {
      expect(isBenignPageError(real)).toBe(false);
    }
  });
});
