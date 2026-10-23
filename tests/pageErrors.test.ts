/**
 * pageErrors.test.ts — the benign-browser-error allowlist stays tight.
 * A real app error must never be filtered; the known-benign ResizeObserver
 * notification and WebKit's report for its own <select> control must be.
 */

import { describe, it, expect } from 'vitest';
import { isBenignPageError } from './e2e/pageErrors';

describe('isBenignPageError', () => {
  it('filters the benign ResizeObserver notifications (both spellings)', () => {
    expect(isBenignPageError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignPageError('ResizeObserver loop limit exceeded')).toBe(true);
  });

  it("filters WebKit's report for its own <select> control, and only WebKit's wording", () => {
    expect(isBenignPageError(
      "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
    )).toBe(true);
    for (const other of [
      // Chromium and Firefox word an inline-style block differently; those still fail.
      "Refused to apply inline style because it violates the following Content Security Policy directive: \"style-src 'self'\".",
      'Content-Security-Policy: The page’s settings blocked an inline style (style-src-attr) from being applied because it violates the following directive: “style-src \'self\'”',
      // Other WebKit CSP reports are not covered.
      "Refused to load http://example.test/x.css because it does not appear in the style-src directive of the Content Security Policy.",
      "Refused to execute a script because its hash, its nonce, or 'unsafe-inline' does not appear in the script-src directive of the Content Security Policy.",
    ]) {
      expect(isBenignPageError(other)).toBe(false);
    }
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
