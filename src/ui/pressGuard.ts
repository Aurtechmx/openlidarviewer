/**
 * pressGuard.ts: a list rebuilt between mouse down and mouse up swallows the
 * click, because the pressed node is gone. This holds a rebuild back while a
 * press that began in the list is down and runs the latest one after release.
 * It waits a task past pointerup, since the click fires after pointerup.
 */
export interface PressGuard {
  /** Run now, or after the press ends. A later call replaces a held one. */
  run(rebuild: () => void): void;
  /** Drop a held rebuild; a rebuild the caller ran itself made it stale. */
  cancel(): void;
}

export function createPressGuard(target: EventTarget): PressGuard {
  let pressed = false;
  let held: (() => void) | null = null;
  const release = (): void => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    pressed = false;
    window.setTimeout(() => {
      const run = held;
      held = null;
      run?.();
    }, 0);
  };
  target.addEventListener('pointerdown', () => {
    if (pressed) return;
    pressed = true;
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  });
  return {
    run(rebuild) {
      if (pressed) { held = rebuild; return; }
      held = null;
      rebuild();
    },
    cancel() { held = null; },
  };
}
