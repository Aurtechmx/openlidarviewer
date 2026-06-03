/**
 * shortcutSheet.test.ts
 *
 * Pure-data tests for the `formatShortcutKeys` helper. The DOM
 * component (`ShortcutSheet`) itself depends on the action registry
 * + DOM and is exercised in the e2e suite; the helper is the part
 * that needs to be platform-aware.
 */

import { describe, it, expect, vi } from 'vitest';
import { formatShortcutKeys } from '../src/ui/ShortcutSheet';

describe('formatShortcutKeys — display formatting', () => {
  it('returns an empty string for undefined input', () => {
    expect(formatShortcutKeys(undefined)).toBe('');
  });

  it('returns the verbatim key for a single character', () => {
    expect(formatShortcutKeys('L')).toBe('L');
    expect(formatShortcutKeys('?')).toBe('?');
    expect(formatShortcutKeys('Esc')).toBe('Esc');
  });

  it('replaces Shift with the ⇧ symbol', () => {
    expect(formatShortcutKeys('Shift-Enter')).toContain('⇧');
  });

  it('replaces Alt with the ⌥ symbol', () => {
    expect(formatShortcutKeys('Alt-A')).toContain('⌥');
  });

  it('replaces dashes with spaces for readability', () => {
    expect(formatShortcutKeys('Shift-Enter')).not.toContain('-');
  });

  it('renders Cmd as Ctrl on a non-Mac platform', () => {
    const orig = (globalThis as { navigator?: unknown }).navigator;
    vi.stubGlobal('navigator', { platform: 'Win32' });
    try {
      expect(formatShortcutKeys('Cmd-K')).toContain('Ctrl');
    } finally {
      vi.stubGlobal('navigator', orig);
    }
  });

  it('renders Cmd as ⌘ on macOS', () => {
    const orig = (globalThis as { navigator?: unknown }).navigator;
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    try {
      expect(formatShortcutKeys('Cmd-K')).toContain('⌘');
    } finally {
      vi.stubGlobal('navigator', orig);
    }
  });

  it('composes multiple modifiers in one chord', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    try {
      const out = formatShortcutKeys('Cmd-Shift-R');
      expect(out).toContain('⌘');
      expect(out).toContain('⇧');
      expect(out).toContain('R');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
