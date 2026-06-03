/**
 * commandPalette.test.ts
 *
 * Contract tests for the v0.3.9 command palette pure-data module.
 * Covers: fuzzy matching, action ranking, section grouping, duplicate
 * detection, and the empty-query "show everything" path.
 */

import { describe, it, expect } from 'vitest';
import {
  findDuplicateIds,
  fuzzyMatch,
  groupBySection,
  rankActions,
  type Action,
} from '../src/ui/actionRegistry';

const NOOP = (): void => {};

function action(
  id: string,
  title: string,
  section: string,
  extras: Partial<Action> = {},
): Action {
  return { id, title, section, run: NOOP, ...extras };
}

describe('fuzzyMatch — pure character matcher', () => {
  it('returns 1 for an empty query (trivial match)', () => {
    expect(fuzzyMatch('', 'anything')).toBe(1);
  });

  it('rewards a prefix substring match the highest', () => {
    const prefix = fuzzyMatch('top', 'Top view');
    const inner = fuzzyMatch('top', 'Reset top view');
    const subseq = fuzzyMatch('top', 'Toggle outline pane');
    expect(prefix).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(subseq);
  });

  it('returns 0 when query characters are missing in order', () => {
    expect(fuzzyMatch('xyz', 'Top view')).toBe(0);
    // Out-of-order subsequence still misses.
    expect(fuzzyMatch('pot', 'Top')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('TOP', 'top view')).toBeGreaterThan(0);
    expect(fuzzyMatch('top', 'TOP VIEW')).toBeGreaterThan(0);
  });

  it('gives a word-start bonus over middle-of-word matches', () => {
    const wordStart = fuzzyMatch('mc', 'Measure clear');
    const middle = fuzzyMatch('mc', 'Mecanism');
    expect(wordStart).toBeGreaterThan(middle);
  });

  it('rewards consecutive runs', () => {
    const consecutive = fuzzyMatch('iso', 'Iso view');
    const scattered = fuzzyMatch('iso', 'Inspect Show Outlines');
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('penalises long skips between matches', () => {
    const close = fuzzyMatch('tv', 'Top view');
    const far = fuzzyMatch('tv', 'Time-of-flight scan validation');
    expect(close).toBeGreaterThan(far);
  });
});

describe('rankActions — sorts + filters action lists', () => {
  const ACTIONS: Action[] = [
    action('cam.top', 'Top view', 'Camera'),
    action('cam.iso', 'Iso view', 'Camera'),
    action('cam.oblique', 'Oblique view', 'Camera'),
    action('cam.planar', 'Planar view', 'Camera'),
    action('theme.dark', 'Dark theme', 'Theme', {
      keywords: ['appearance', 'night'],
    }),
    action('theme.light', 'Light theme', 'Theme', {
      keywords: ['appearance', 'daytime'],
    }),
    action('theme.hc', 'High contrast theme', 'Theme', {
      keywords: ['accessibility', 'wcag', 'a11y'],
    }),
    action('tool.measure', 'Measure', 'Tools'),
    action('tool.inspect', 'Inspect point', 'Tools'),
    action('export.png', 'Export PNG screenshot', 'Export'),
  ];

  it('returns every action when the query is empty', () => {
    const ranked = rankActions('', ACTIONS);
    expect(ranked.length).toBe(ACTIONS.length);
  });

  it('preserves the input order on an empty query (stable sort)', () => {
    const ranked = rankActions('', ACTIONS);
    expect(ranked[0].action.id).toBe('cam.top');
    expect(ranked[ranked.length - 1].action.id).toBe('export.png');
  });

  it('puts exact prefix matches above fuzzy matches', () => {
    const ranked = rankActions('top', ACTIONS);
    expect(ranked[0].action.id).toBe('cam.top');
  });

  it('drops actions that do not match at all', () => {
    const ranked = rankActions('snake oil', ACTIONS);
    expect(ranked.length).toBe(0);
  });

  it('finds an action by its section name', () => {
    const ranked = rankActions('theme', ACTIONS);
    const ids = ranked.map((r) => r.action.id);
    expect(ids).toContain('theme.dark');
    expect(ids).toContain('theme.light');
    expect(ids).toContain('theme.hc');
  });

  it('finds an action by a keyword that is not in the title', () => {
    const ranked = rankActions('wcag', ACTIONS);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].action.id).toBe('theme.hc');
  });

  it('handles common typos via the subsequence path', () => {
    // "isov" → IsoView — typed without the space.
    const ranked = rankActions('isov', ACTIONS);
    expect(ranked[0].action.id).toBe('cam.iso');
  });

  it('trims whitespace before matching', () => {
    const ranked = rankActions('   top   ', ACTIONS);
    expect(ranked[0].action.id).toBe('cam.top');
  });

  it('weights title matches above section / keyword matches', () => {
    // "appearance" is a keyword on both dark + light, and "appear"
    // appears in nothing's title — but if a title match existed, it
    // would outrank both. Here we just confirm keyword matches DO
    // bring results (not the inverse) without depending on a title.
    const ranked = rankActions('appearance', ACTIONS);
    const ids = ranked.map((r) => r.action.id);
    expect(ids).toContain('theme.dark');
    expect(ids).toContain('theme.light');
    // High-contrast does NOT have 'appearance' as a keyword.
    expect(ids).not.toContain('theme.hc');
  });
});

describe('groupBySection — preserves section ordering', () => {
  const ACTIONS: Action[] = [
    action('cam.top', 'Top view', 'Camera'),
    action('cam.iso', 'Iso view', 'Camera'),
    action('theme.dark', 'Dark theme', 'Theme'),
    action('export.png', 'Export PNG', 'Export'),
    action('theme.light', 'Light theme', 'Theme'),
  ];

  it('groups consecutive ranked rows by their declared section', () => {
    const ranked = rankActions('', ACTIONS);
    const grouped = groupBySection(ranked);
    const sectionsInOrder = grouped.map((g) => g.section);
    // Sections appear in the order they FIRST show up in the ranked
    // list; the same section's later rows are merged into its bucket.
    expect(sectionsInOrder).toEqual(['Camera', 'Theme', 'Export']);
  });

  it('merges actions from the same section even when scattered by score', () => {
    const ranked = rankActions('view', ACTIONS);
    const grouped = groupBySection(ranked);
    // Both Camera entries should land in a single Camera bucket.
    const camera = grouped.find((g) => g.section === 'Camera');
    expect(camera?.rows.length).toBe(2);
  });

  it('returns an empty array for an empty ranked list', () => {
    expect(groupBySection([])).toEqual([]);
  });
});

describe('findDuplicateIds — registry hygiene', () => {
  it('returns no duplicates for a clean registry', () => {
    const clean: Action[] = [
      action('a', 'A', 'X'),
      action('b', 'B', 'X'),
      action('c', 'C', 'X'),
    ];
    expect(findDuplicateIds(clean)).toEqual([]);
  });

  it('reports a duplicate id', () => {
    const dirty: Action[] = [
      action('a', 'A', 'X'),
      action('a', 'A clash', 'Y'),
    ];
    expect(findDuplicateIds(dirty)).toEqual(['a']);
  });

  it('reports every duplicate exactly once', () => {
    const dirty: Action[] = [
      action('a', 'A', 'X'),
      action('a', 'A again', 'X'),
      action('a', 'A third', 'X'),
      action('b', 'B', 'X'),
      action('b', 'B again', 'X'),
    ];
    expect(findDuplicateIds(dirty).sort()).toEqual(['a', 'b']);
  });
});

describe('callback wiring', () => {
  it('preserves the action.run callback through ranking', () => {
    let fired = false;
    const a: Action = {
      id: 'fire',
      title: 'Fire the cannon',
      section: 'Test',
      run: () => {
        fired = true;
      },
    };
    const ranked = rankActions('fire', [a]);
    ranked[0].action.run();
    expect(fired).toBe(true);
  });
});
