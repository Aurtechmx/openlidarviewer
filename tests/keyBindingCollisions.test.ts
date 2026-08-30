/**
 * keyBindingCollisions.test.ts
 *
 * A lint-as-test guard on the declarative shortcut table (brief §8). It builds
 * the REAL table via `buildViewerKeyBindings`, runs `findKeyCollisions`, and
 * asserts the table has no key clash beyond a small, documented allowlist of
 * intentional ordered overrides. If someone later adds a binding that fights an
 * existing one over the same key in the same scope, the first test fails.
 *
 * A collision is: two bindings that could fire on one key event (shared key
 * token + jointly-satisfiable modifiers) whose context scopes are non-disjoint.
 * `reservedOnly` (component-owned) keys count as occupied slots, so a dispatched
 * binding placed on one in a shared scope is caught too.
 */
import { describe, it, expect } from 'vitest';
import {
  buildViewerKeyBindings,
  findKeyCollisions,
  type KeyBinding,
  type KeyBindingDeps,
} from '../src/ui/keyBindings';

/** No-op deps — `findKeyCollisions` reads only ids/matches/tags, never runs. */
function stubDeps(): KeyBindingDeps {
  return {
    isToolActive: () => false,
    setToolPaused: () => {},
    isMeasureMode: () => false,
    isDrafting: () => false,
    measureFinish: () => {},
    measureUndoPoint: () => {},
    onEscape: () => {},
    toggleLasso: () => {},
    setCameraPreset: () => undefined,
    toast: () => {},
    openCommandPalette: () => {},
    toggleShortcutSheet: () => {},
    workflowRecorderEnabled: false,
    matchesWorkflowShortcut: () => false,
    toggleWorkflowRecord: () => {},
    globalActions: () => null,
  };
}

/**
 * ALLOWLIST — the only benign ordered overrides in the table. Each pair shares
 * a key in a non-disjoint scope on purpose; precedence (lower priority wins
 * first) makes the outcome deterministic. Anything NOT listed here is a bug.
 */
const ALLOWED_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  // `?` shortcut sheet (priority 400) intentionally shadows the `?` help
  // overlay (614): the higher-priority binding in the same 'global' scope wins,
  // which is the exact regression the priority scheme was built to lock in.
  ['shortcut-sheet', 'help-overlay'],
  // Measure-mode Backspace (priority 110, 'measure' scope while drafting)
  // intentionally precedes the global delete (615): narrower mode + higher
  // priority pop a vertex instead of deleting the selection.
  ['measure-polygon-keys', 'delete-selection'],
  // Measure-mode ⌘Z (priority 110) intentionally precedes global undo (600) for
  // the same reason; a chord with nothing drafted falls through to undo.
  ['measure-polygon-keys', 'undo-redo-z'],
];

const pairKey = (a: string, b: string): string => [a, b].sort().join(' | ');
const allowed = new Set(ALLOWED_OVERRIDES.map(([a, b]) => pairKey(a, b)));

describe('keyBindings collision lint', () => {
  const collisions = findKeyCollisions(buildViewerKeyBindings(stubDeps()));

  it('has no collisions beyond the documented allowlist', () => {
    const unexpected = collisions.filter((c) => !allowed.has(pairKey(c.a, c.b)));
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });

  it('keeps the allowlist honest — every listed override still occurs', () => {
    const found = new Set(collisions.map((c) => pairKey(c.a, c.b)));
    for (const pair of allowed) {
      expect(found.has(pair), `allowlisted pair no longer collides: ${pair}`).toBe(true);
    }
  });

  it('flags a genuinely conflicting new binding', () => {
    // A second bare-M binding in the same 'global' scope as tool-measure.
    const synthetic: KeyBinding<KeyBindingDeps> = {
      id: 'synthetic-clash',
      match: { key: ['m', 'M'], bareOnly: true },
      priority: 999,
      contextTag: 'global',
      displayKeys: 'M',
      run: () => true,
    };
    const found = findKeyCollisions([...buildViewerKeyBindings(stubDeps()), synthetic]);
    const hit = found.find((c) => c.a === 'synthetic-clash' || c.b === 'synthetic-clash');
    expect(hit, 'a same-key same-scope binding must be flagged').toBeTruthy();
    expect([hit!.a, hit!.b]).toContain('tool-measure');
  });

  it('does not flag a new binding whose scope is disjoint', () => {
    // Same key, but a component-owned scope that never shares the global surface.
    const isolated: KeyBinding<KeyBindingDeps> = {
      id: 'synthetic-isolated',
      match: { key: ['m', 'M'], bareOnly: true },
      priority: 999,
      contextTag: 'lasso-draw',
      displayKeys: 'M',
      run: () => true,
    };
    const found = findKeyCollisions([...buildViewerKeyBindings(stubDeps()), isolated]);
    expect(
      found.some((c) => c.a === 'synthetic-isolated' || c.b === 'synthetic-isolated'),
    ).toBe(false);
  });
});
