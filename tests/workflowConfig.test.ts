import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKFLOW_CONFIG,
  parseWorkflowConfig,
  chordFromEvent,
  matchesShortcut,
  formatShortcutLabel,
  type ChordEventLike,
} from '../src/render/workflow/workflowConfig';

function ev(p: Partial<ChordEventLike> & { key: string }): ChordEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

describe('chordFromEvent', () => {
  it('builds a normalised chord with modifiers in a fixed order', () => {
    expect(chordFromEvent(ev({ key: 'U', metaKey: true, shiftKey: true }))).toBe('mod+shift+u');
    expect(chordFromEvent(ev({ key: 'r', ctrlKey: true, altKey: true }))).toBe('mod+alt+r');
  });

  it('rejects a bare or shift-only key (would collide with tool shortcuts)', () => {
    expect(chordFromEvent(ev({ key: 'r' }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'R', shiftKey: true }))).toBeNull();
  });

  it('rejects a lone modifier key', () => {
    expect(chordFromEvent(ev({ key: 'Shift', shiftKey: true, metaKey: true }))).toBeNull();
  });
});

describe('matchesShortcut', () => {
  const chord = 'mod+shift+u';
  it('matches the exact modifier + key combination', () => {
    expect(matchesShortcut(ev({ key: 'u', metaKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchesShortcut(ev({ key: 'u', ctrlKey: true, shiftKey: true }), chord)).toBe(true);
  });

  it('does not match a partial or different combination', () => {
    expect(matchesShortcut(ev({ key: 'u', metaKey: true }), chord)).toBe(false); // no shift
    expect(matchesShortcut(ev({ key: 'i', metaKey: true, shiftKey: true }), chord)).toBe(false);
    expect(matchesShortcut(ev({ key: 'u', metaKey: true, shiftKey: true, altKey: true }), chord)).toBe(false);
  });

  it('an empty chord never matches', () => {
    expect(matchesShortcut(ev({ key: 'u', metaKey: true }), '')).toBe(false);
  });
});

describe('formatShortcutLabel', () => {
  it('uses mac glyphs on mac and words elsewhere', () => {
    expect(formatShortcutLabel('mod+shift+u', true)).toBe('⌘⇧U');
    expect(formatShortcutLabel('mod+shift+u', false)).toBe('Ctrl+Shift+U');
  });
  it('renders an empty chord as Off', () => {
    expect(formatShortcutLabel('', true)).toBe('Off');
  });
});

describe('parseWorkflowConfig', () => {
  it('returns the defaults for missing or junk input', () => {
    expect(parseWorkflowConfig(null)).toEqual(DEFAULT_WORKFLOW_CONFIG);
    expect(parseWorkflowConfig('nope')).toEqual(DEFAULT_WORKFLOW_CONFIG);
  });

  it('keeps valid fields and repairs invalid ones', () => {
    const cfg = parseWorkflowConfig({
      format: 'compact',
      saveMode: 'picker',
      shortcut: 'mod+alt+w',
      replaySpeed: 2,
      countdownSeconds: 3,
      loop: true,
      capture: { camera: false, theme: true, tools: 'yes' },
    });
    expect(cfg.format).toBe('compact');
    expect(cfg.saveMode).toBe('picker');
    expect(cfg.replaySpeed).toBe(2);
    expect(cfg.countdownSeconds).toBe(3);
    expect(cfg.loop).toBe(true);
    expect(cfg.capture).toEqual({ camera: false, theme: true, tools: true }); // 'yes' → default true
  });

  it('rejects an out-of-set replay speed', () => {
    expect(parseWorkflowConfig({ replaySpeed: 99 }).replaySpeed).toBe(1);
  });
});
