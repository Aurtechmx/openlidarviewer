/**
 * tests/helpers/manualTimerDom.ts
 *
 * The `document`/`window.setTimeout` stub shared by projectCardAnnounce.test.ts
 * and projectCardLane.test.ts: both need ProjectCard's own dismiss timer
 * driven by hand rather than by real (or vitest fake) time, so its multi-step
 * fade/hand-off sequence (see ProjectCard.ts's `_dismiss`) can be advanced one
 * queued callback at a time instead of costing a real multi-second wait.
 */

import { FakeEl } from '../support/measurePanelDom';

/** Install the stub `document`/`window` ProjectCard reads at construction
 * time, with `setTimeout`/`clearTimeout` recorded rather than scheduled.
 * Returns `runTimers`, which fires every timer queued so far (as if its full
 * delay had passed) and clears the queue. */
export function installManualTimerDom(): { runTimers: () => void } {
  const pending = new Map<number, () => void>();
  let nextTimer = 1;
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.window = {
    setTimeout: (fn: () => void) => {
      pending.set(nextTimer, fn);
      return nextTimer++;
    },
    clearTimeout: (id: number) => {
      pending.delete(id);
    },
  };
  g.clearTimeout = (id: number) => {
    pending.delete(id);
  };
  return {
    runTimers(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
  };
}
