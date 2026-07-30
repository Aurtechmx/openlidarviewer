/**
 * Opening a second scan used to destroy the first scan's saved viewpoints and
 * annotations while keeping its geometry on screen.
 *
 * `handleFile` states 62 lines earlier that static layers are additive and that
 * prior clouds are deliberately retained. Then it cleared the bookmark store and
 * the annotation store unconditionally. Saved viewpoints have no history, so they
 * were gone with no undo. Annotations were recoverable by exactly one Ctrl+Z,
 * which nothing told the user about. Measurements were untouched by the same
 * load, so one additive open kept some work and discarded the rest.
 *
 * The root cause is ownership: an `Annotation` records a position in the scan's
 * render frame and no layer id, so "a new scan" and "an additional layer" look
 * identical at the point of the clear. Until annotations carry a layer, the
 * honest rule is to reset only when there is nothing to preserve.
 *
 * Two assertions here. The first models the rule, so a reader can see what it
 * decides. The second reads main.ts, because that is where the rule lives and
 * the file cannot be imported in Node.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The decision the load path makes, with nothing else attached. */
function resetsSavedWork(cloudCountAfterAdd: number): boolean {
  return cloudCountAfterAdd <= 1;
}

describe('an additive open keeps saved work', () => {
  it('resets on the first scan, when there is nothing to keep', () => {
    expect(resetsSavedWork(1)).toBe(true);
  });

  it('keeps saved work when a second scan joins the first', () => {
    expect(resetsSavedWork(2)).toBe(false);
  });

  it('keeps saved work for every further layer', () => {
    for (const count of [3, 4, 12]) {
      expect(resetsSavedWork(count)).toBe(false);
    }
  });

  it('still resets when a close left no clouds behind', () => {
    // The close path clears everything itself, so reaching the load path with
    // zero clouds means a genuinely empty project rather than a retained layer.
    expect(resetsSavedWork(0)).toBe(true);
  });
});

describe('the load path applies that rule', () => {
  const mainSource = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');

  it('gates the bookmark and annotation reset on the cloud count', () => {
    // Matching the guard rather than the bare calls: an unguarded
    // `bookmarks.clear()` on this path is the defect, so the test has to see
    // the condition, not just the presence of a clear.
    const guarded =
      /if \(viewer\.clouds\(\)\.length <= 1\) \{[^}]*bookmarks\.clear\(\);[^}]*viewer\.annotate\.clear\(\);[^}]*\}/;
    expect(
      guarded.test(mainSource),
      'The reset must stay gated on there being at most one cloud. An ' +
        'unconditional clear here destroys saved viewpoints for a layer that ' +
        'is still on screen, with no undo.',
    ).toBe(true);
  });

  it('leaves measurements alone on this path, as it always did', () => {
    // Recorded so the inconsistency cannot be "fixed" by clearing measurements
    // too. The additive load should discard nothing.
    // Anchored forward from the additive marker: `refreshAnnotationPanel();`
    // also appears earlier in the file, so an unanchored indexOf produced an
    // empty slice and the assertion below passed against nothing.
    const start = mainSource.indexOf('static layers are ADDITIVE');
    const end = mainSource.indexOf('refreshAnnotationPanel();', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const loadPath = mainSource.slice(start, end);
    expect(loadPath).not.toContain('clearMeasurements');
  });
});
