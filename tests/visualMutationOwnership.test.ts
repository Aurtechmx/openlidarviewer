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
 * `input()` is not an owner. It records a holdover reason and extends the
 * 350 ms activity window, and a frame the browser runs after that window finds
 * nothing asking and skips the paint. The change has already happened, so
 * nothing raises it again. A mutation owns a `once` reason instead, which is
 * held until a frame serves it; `input()` belongs to the gesture listeners.
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

import { ALL_INVALIDATION_REASONS, KIND, type RenderInvalidationReason } from '../src/render/renderInvalidation';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render', 'Viewer.ts'),
  'utf8',
);

/** Control keywords that look like methods at two-space indent. */
const RESERVED = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else']);

/** The text of a Viewer method, ending at its closing brace. */
function bodyOf(name: string): string {
  const at = source.search(new RegExp(`\\n  (?:private )?(?:async )?${name}\\s*\\(`));
  expect(at, `${name} is not a method on Viewer`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('\n  }\n', at));
}

/** Every public method name on Viewer, in source order. */
function publicMethods(): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/\n  (?:async )?([a-zA-Z][\w]*)\s*\(/g)) {
    // `if`, `for` and friends sit at the same indent inside a method body.
    if (!RESERVED.has(m[1])) names.push(m[1]);
  }
  return names;
}

const INPUT_CALL = '_demand.input()';

/**
 * The mutation surface, and the reason each one owns.
 *
 * `style` is appearance: colour, size, lighting, sky, whether a layer is
 * drawn. `filter` is a class, elevation or intensity window deciding which
 * points show. `scene-geometry` is a layer entering or leaving, which is a
 * change to what exists rather than to how it looks. `tool-overlay` is the
 * selection highlight. `streaming-schedule` is a budget or pause change whose
 * effect lands on the scheduler's next tick. `redraw-request` is the public
 * `requestFrame`, whose callers each changed something the Viewer cannot name.
 */
const OWNERS: ReadonlyArray<readonly [string, RenderInvalidationReason]> = [
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
  ['setColorMode', 'style'],
  ['applyClassVisibility', 'filter'],
  ['setElevationFilter', 'filter'],
  ['setIntensityFilter', 'filter'],
  ['setCoverageGrid', 'style'],
  ['setStreamingColorMode', 'style'],
  ['setStreamingQuality', 'streaming-schedule'],
  ['resumeStreaming', 'streaming-schedule'],
  // Found by the derived check below rather than by reading the surface, which
  // is the point of deriving it: these three were absent from the inventory
  // this file started from.
  ['setClip', 'clip'],
  ['applyDerivedClassification', 'filter'],
  ['requestFrame', 'redraw-request'],
];

describe('every visual mutation has a redraw owner', () => {
  it.each(OWNERS)('%s invalidates with %s', (name, owner) => {
    expect(bodyOf(name)).toContain(`_demand.changed('${owner}')`);
  });

  it('names a once reason the table declares, so a late frame cannot drop it', () => {
    for (const [name, owner] of OWNERS) {
      expect(ALL_INVALIDATION_REASONS).toContain(owner);
      expect(KIND[owner], `${name} owns ${owner}, which a frame does not hold for`).toBe('once');
    }
  });

  it('lists every public method that invalidates, so none drifts off the inventory', () => {
    // Derived from the source rather than counted by hand: a new public setter
    // that invalidates has to be added here, and one that stops invalidating
    // fails its own case above. Private methods are excluded because the
    // listener wiring invalidates too and is not a mutation surface.
    const invalidating = new Set<string>();
    for (const name of publicMethods()) {
      if (/_demand\.(input|changed|cameraMoved)\(/.test(bodyOf(name))) invalidating.add(name);
    }
    const listed = new Set(OWNERS.map(([name]) => name));
    expect([...invalidating].filter((n) => !listed.has(n)), 'invalidates but is unlisted').toEqual([]);
    expect([...listed].filter((n) => !invalidating.has(n)), 'listed but does not invalidate').toEqual([]);
  });

  it('has no public method asking through input()', () => {
    // A public method is called by code, not by a hand on the canvas. Whatever
    // it changed needs a frame that a late browser cannot skip.
    const offenders = publicMethods().filter((name) => bodyOf(name).includes(INPUT_CALL));
    expect(offenders, 'reaches for input() instead of owning a reason').toEqual([]);
  });
});

/**
 * The listeners that keep `input()`, and why each is input.
 *
 * Pointer and key events arrive in a stream whose last member looks like a
 * pause, which is what a holdover reason is for. The visibility handler runs
 * when the user brings the tab back, and warms the loop for the input that
 * follows; anything that changed while the tab was hidden recorded its own
 * reason, which a stopped scheduler keeps for the restart.
 */
const GESTURE_LISTENERS = [
  '_onCanvasPointerMove',
  '_onCanvasPointerDown',
  '_onWindowKeyDown',
  '_onVisibilityChange',
] as const;

/** The text of a listener assigned in the constructor, to its closing brace. */
function listenerBody(name: string): string {
  const at = source.indexOf(`this.${name} = `);
  expect(at, `${name} is not assigned in the constructor`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('\n    };\n', at));
}

describe('input() is for gestures only', () => {
  it.each(GESTURE_LISTENERS)('%s records input', (name) => {
    expect(listenerBody(name)).toContain(INPUT_CALL);
  });

  it('appears nowhere else in Viewer.ts', () => {
    // Counted over the whole file, private methods and the constructor
    // included, so a new call anywhere outside the listeners is visible here.
    const everywhere = source.split(INPUT_CALL).length - 1;
    const inListeners = GESTURE_LISTENERS.reduce((n, name) => n + listenerBody(name).split(INPUT_CALL).length - 1, 0);
    expect(everywhere).toBe(inListeners);
  });

  it('a key that leaves a tool also owns the overlay change', () => {
    // Escape drops the measurement draft and cursor, which the overlay shows
    // until a rendered frame reprojects it. The key is input; the overlay
    // change is a once reason, recorded where every tool switch passes.
    expect(listenerBody('_onWindowKeyDown')).toContain("this._setToolMode('none')");
    expect(bodyOf('_setToolMode')).toContain("_demand.changed('tool-overlay')");
  });
});

describe('the ones that deliberately do not', () => {
  it('pauseStreaming does not, because stopping work needs no frame', () => {
    expect(bodyOf('pauseStreaming')).not.toContain('_demand.');
  });

  it('clearStreamingCache does not, because the cache holds compressed bytes, not drawn nodes', () => {
    // `CompressedChunkCache` keeps chunks for re-decoding an evicted node. The
    // resident meshes are the renderer's, bounded by the point budget, so
    // dropping the cache leaves every drawn point where it was.
    const body = bodyOf('clearStreamingCache');
    expect(body).toContain('scheduler.clearCache()');
    expect(body).not.toContain('_demand.');
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
