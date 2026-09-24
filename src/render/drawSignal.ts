/**
 * One-shot draw notifications. A callback passed to {@link onNextDraw} runs
 * once, right after the next frame the render loop actually submits; skipped
 * (throttled) frames do not fire it. With none pending, {@link noteDrawn} is a
 * length check.
 */

let pending: (() => void)[] = [];

/** Run `cb` once, after the next frame the renderer draws. */
export function onNextDraw(cb: () => void): void {
  pending.push(cb);
}

/** Called by the render loop after a frame drew. */
export function noteDrawn(): void {
  if (pending.length === 0) return;
  const run = pending;
  pending = [];
  for (const cb of run) cb();
}

/**
 * Milliseconds from `startedAt` to the first frame the browser shows after
 * the next draw: one animation frame after {@link noteDrawn}, so the drawn
 * frame has been presented.
 */
export function timeToNextDraw(startedAt: number): Promise<number> {
  return new Promise((done) => onNextDraw(() => requestAnimationFrame(() => done(performance.now() - startedAt))));
}
