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

  // These three asserted Apple glyphs without stating a platform, so they read
  // the host's real navigator: green on a Mac, and on a Linux runner they were
  // asserting that a non-Apple platform renders Apple notation. The platform is
  // now named in each case.
  const onMac = <T>(fn: () => T): T => {
    const orig = (globalThis as { navigator?: unknown }).navigator;
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    try {
      return fn();
    } finally {
      vi.stubGlobal('navigator', orig);
    }
  };
  const onWindows = <T>(fn: () => T): T => {
    const orig = (globalThis as { navigator?: unknown }).navigator;
    vi.stubGlobal('navigator', { platform: 'Win32' });
    try {
      return fn();
    } finally {
      vi.stubGlobal('navigator', orig);
    }
  };

  it('renders Apple modifier glyphs on macOS', () => {
    expect(onMac(() => formatShortcutKeys('Shift-Enter'))).toContain('⇧');
    expect(onMac(() => formatShortcutKeys('Alt-A'))).toContain('⌥');
  });

  it('renders written modifiers on Windows, not Apple glyphs', () => {
    const chord = onWindows(() => formatShortcutKeys('Cmd-Shift-U'));
    expect(chord).toBe('Ctrl+Shift+U');
    expect(chord).not.toContain('⇧');
    expect(chord).not.toContain('⌥');
    expect(chord).not.toContain('⌘');
  });

  it('separates macOS chords with spaces rather than dashes', () => {
    expect(onMac(() => formatShortcutKeys('Shift-Enter'))).not.toContain('-');
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
      const out = formatShortcutKeys('Cmd-Shift-U');
      expect(out).toContain('⌘');
      expect(out).toContain('⇧');
      expect(out).toContain('U');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
