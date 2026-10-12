/**
 * The disposal work this suite guards is currently unreachable, and that is the
 * honest status rather than a gap left open.
 *
 * FullscreenToggle.dispose() and the wireRailToggle disposers exist and are
 * covered. Nothing calls Stage.dispose(), so in the running application those
 * listeners are never detached. That is not a leak today: Stage is constructed
 * exactly once at module scope and there is no code path that replaces or tears
 * it down, so the listeners live as long as the document and end with the page.
 *
 * The leak becomes real the moment someone constructs a second Stage or adds a
 * teardown path, and at that point it would be silent. So this freezes the
 * precondition instead of the symptom: one construction site. Add another and
 * this test fails and tells you to call dispose().
 *
 * Adding the dispose() call now was not free. main.ts is under a ratchet that
 * refuses one extra line, and rebanking the baseline to fit a call that nothing
 * needs yet would spend the ratchet on a hypothetical.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');

describe('Stage lifecycle', () => {
  it('is constructed exactly once, so nothing needs to dispose it yet', () => {
    const constructions = mainSource.match(/new Stage\(/g) ?? [];
    expect(
      constructions.length,
      'A second Stage makes the undetached listeners a real leak. Call ' +
        'stage.dispose() on the path that replaces it, and update this test.',
    ).toBe(1);
  });

  it('registers its rail-toggle disposers, so a teardown path would work', () => {
    // The disposers are wired even though nothing drains them, which is what
    // makes adding a teardown path a one-line change rather than an audit.
    // The rail wiring lives in the workspace shell, which main.ts hands its
    // stage teardown to.
    const shellSource = readFileSync(join(__dirname, '../src/app/workspace/workspaceShell.ts'), 'utf8');
    expect(mainSource).toMatch(/addTeardown: \(fn\) => stage\.addTeardown\(fn\)/);
    // Each rail toggle is held (Focus mode drives it) and its handle, which is
    // the disposer, is registered.
    const held = [...shellSource.matchAll(/const (\w+) = wireRailToggle\(/g)].map((m) => m[1]);
    expect(held.length).toBe(2);
    for (const name of held) expect(shellSource).toContain(`d.addTeardown(${name});`);
  });
});
