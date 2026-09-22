/**
 * visualMutationOwnership.test.ts: every public mutation that moves pixels
 * says so.
 *
 * The render loop is request-driven, so a setter that changes the picture and
 * tells nobody leaves the screen as it was until the heartbeat comes round. An
 * idle frame arrives every 250 ms and still has to clear the gate's idle
 * count, so the wait can pass a second. Eighteen of these had no redraw owner
 * at all, and the ones that did reached for `input()`, which pretends a user
 * touched the canvas.
 *
 * This reads Viewer.ts rather than calling it. Constructing a Viewer wants a
 * GPU, and the property worth guarding is structural: a new public setter that
 * forgets to invalidate should be hard to add quietly. The list below is the
 * inventory, derived against the source so a setter missing from it is as much
 * a gap as one that does not invalidate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALL_INVALIDATION_REASONS, type RenderInvalidationReason } from '../src/render/renderInvalidation';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render', 'Viewer.ts'),
  'utf8',
);

/** Control keywords that look like methods at two-space indent. */
const RESERVED = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else']);

/** The text of a Viewer method, ending at its closing brace. */
function bodyOf(name: string): string {
  const at = source.search(new RegExp(`\\n  (?:async )?${name}\\s*\\(`));
  expect(at, `${name} is not a method on Viewer`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('\n  }\n', at));
}

/**
 * The mutation surface, and the reason each one owns.
 *
 * `style` is appearance: colour, size, lighting, sky, filters, whether a layer
 * is drawn. `scene-geometry` is a layer entering or leaving, which is a change
 * to what exists rather than to how it looks. `tool-overlay` is the selection
 * highlight, and is the reason a future simulation overlay would use.
 */
const OWNERS: ReadonlyArray<readonly [string, RenderInvalidationReason | 'input']> = [
  ['addCloud', 'scene-geometry'],
  ['removeCloud', 'scene-geometry'],
  ['setCloudVisible', 'style'],
  ['setHeightPercentileTrim', 'style'],
  ['setProjectSharedElevation', 'style'],
  ['setRgbAppearance', 'style'],
  ['applyRgbAppearancePreset', 'style'],
  ['setSky', 'style'],
  ['setSplatMode', 'style'],
  ['setPointSize', 'style'],
  ['setPointSizeMode', 'style'],
  ['setEdlEnabled', 'style'],
  ['setEdlStrength', 'style'],
  ['setAntialiasing', 'style'],
  ['setSelectionHighlight', 'tool-overlay'],
  ['clearSelectionHighlight', 'tool-overlay'],
  // Wired before the reasons became a draw authority. They work because
  // `input()` both wakes the loop and arms the gate; they are the call sites
  // to narrow next.
  ['setColorMode', 'input'],
  ['applyClassVisibility', 'filter'],
  ['setElevationFilter', 'filter'],
  ['setIntensityFilter', 'input'],
  ['setCoverageGrid', 'style'],
  ['setStreamingColorMode', 'input'],
  ['setStreamingQuality', 'input'],
  ['resumeStreaming', 'input'],
  ['clearStreamingCache', 'input'],
  // Found by the derived check below rather than by reading the surface, which
  // is the point of deriving it: these three were absent from the inventory
  // this file started from.
  ['setClip', 'clip'],
  ['applyDerivedClassification', 'input'],
  ['requestFrame', 'input'],
];

describe('every visual mutation has a redraw owner', () => {
  it.each(OWNERS)('%s invalidates with %s', (name, owner) => {
    const expected = owner === 'input' ? '_demand.input()' : `_demand.changed('${owner}')`;
    expect(bodyOf(name)).toContain(expected);
  });

  it('names a reason the table declares', () => {
    for (const [, owner] of OWNERS) {
      if (owner === 'input') continue;
      expect(ALL_INVALIDATION_REASONS).toContain(owner);
    }
  });

  it('lists every public method that invalidates, so none drifts off the inventory', () => {
    // Derived from the source rather than counted by hand: a new public setter
    // that invalidates has to be added here, and one that stops invalidating
    // fails its own case above. Private methods are excluded because the
    // listener wiring invalidates too and is not a mutation surface.
    const invalidating = new Set<string>();
    for (const m of source.matchAll(/\n  (?:async )?([a-zA-Z][\w]*)\s*\(/g)) {
      const name = m[1];
      // `if`, `for` and friends sit at the same indent inside a method body.
      if (name.startsWith('_') || RESERVED.has(name)) continue;
      if (/_demand\.(input|changed|cameraMoved)\(/.test(bodyOf(name))) invalidating.add(name);
    }
    const listed = new Set(OWNERS.map(([name]) => name));
    expect([...invalidating].filter((n) => !listed.has(n)), 'invalidates but is unlisted').toEqual([]);
    expect([...listed].filter((n) => !invalidating.has(n)), 'listed but does not invalidate').toEqual([]);
  });
});

describe('the two that deliberately do not', () => {
  it('pauseStreaming does not, because stopping work needs no frame', () => {
    expect(bodyOf('pauseStreaming')).not.toContain('_demand.');
  });

  it('setEdlPreset does not, because both its paths delegate to setters that do', () => {
    const body = bodyOf('setEdlPreset');
    expect(body).not.toContain('_demand.');
    // The null path turns EDL off; the preset path sets strength. Each of
    // those invalidates, so a second call here would be a duplicate rather
    // than a guarantee.
    expect(body).toContain('this.setEdlEnabled(false)');
    expect(body).toContain('this.setEdlStrength(preset.strength)');
    expect(bodyOf('setEdlEnabled')).toContain("_demand.changed('style')");
    expect(bodyOf('setEdlStrength')).toContain("_demand.changed('style')");
  });
});
