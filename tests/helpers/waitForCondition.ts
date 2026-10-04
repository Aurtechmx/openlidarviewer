/**
 * Wait for a condition on wall-clock time rather than a count of event-loop
 * ticks. Lazy chunks and async pipelines take longer on a loaded machine, so a
 * fixed tick budget can expire before the work lands. Fails loudly on timeout.
 */
import { vi } from 'vitest';

export async function waitForCondition(
  done: () => boolean,
  describe: () => string = () => 'condition not met',
  timeout = 10_000,
): Promise<void> {
  await vi.waitFor(() => { if (!done()) throw new Error(describe()); }, { timeout, interval: 2 });
}
