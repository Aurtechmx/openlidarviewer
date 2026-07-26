/**
 * stage.ts
 *
 * Run one stage of a suite and record it.
 *
 * This is the only place the clock and the memory sampler are composed, so that
 * three suites cannot each grow their own answer to "what do we write down when
 * a stage throws". The answer here: the stage is marked failed, its message is
 * kept, and its duration and peak RSS are recorded anyway. A decode that died
 * after 40 s and 6 GB tells a reader something real; a blank row does not, and a
 * row of zeros actively misleads.
 *
 * Only the error MESSAGE is stored, never the stack: a stack embeds absolute
 * paths from the machine that ran the suite, which is precisely what
 * `artifacts.ts` then has to strip back out of every hashed artifact.
 */

import { startStageClock } from './clock';
import { startMemorySampler, type MemorySamplerOptions } from './memory';
import type { StageResult } from './types';

export interface StageOutcome<T> {
  readonly stage: StageResult;
  /**
   * The body's return value, absent when the stage failed.
   *
   * Do not read `value === undefined` as "it failed" — a body that legitimately
   * returns undefined is indistinguishable that way. `stage.status` is the
   * discriminant, and it narrows `stage.error` with it.
   */
  readonly value?: T;
}

export interface RunStageOptions {
  /** Passed through to the memory sampler — mainly for injecting a reader. */
  readonly memory?: MemorySamplerOptions;
}

/**
 * Normalise a thrown value to a single line a report can carry.
 *
 * `Error.message` is routinely multi-line (a parser quoting its input, an
 * aggregate error listing causes), and a raw newline breaks the Markdown table
 * apart mid-row: the remainder of the message becomes a paragraph and the
 * following stages shift into a second, headerless table. Collapsing the runs
 * to `; ` keeps every word and costs only the line breaks.
 */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s*[\r\n]+\s*/g, '; ').trim();
}

/** Time and measure a synchronous stage. Never rethrows. */
export function runStage<T>(
  name: string,
  body: () => T,
  options: RunStageOptions = {},
): StageOutcome<T> {
  const memory = startMemorySampler(options.memory);
  const stopClock = startStageClock();
  try {
    const value = body();
    return { stage: close(name, stopClock, memory, undefined), value };
  } catch (err) {
    return { stage: close(name, stopClock, memory, messageOf(err)) };
  }
}

/** Time and measure an asynchronous stage. Never rejects. */
export async function runStageAsync<T>(
  name: string,
  body: () => Promise<T>,
  options: RunStageOptions = {},
): Promise<StageOutcome<T>> {
  const memory = startMemorySampler(options.memory);
  const stopClock = startStageClock();
  try {
    const value = await body();
    return { stage: close(name, stopClock, memory, undefined), value };
  } catch (err) {
    return { stage: close(name, stopClock, memory, messageOf(err)) };
  }
}

/**
 * Close both instruments and assemble the result.
 *
 * The clock is read BEFORE the sampler is stopped so the recorded duration
 * excludes the sampler's own teardown — small, but it is the difference between
 * a timing that measures the stage and one that measures the harness.
 */
function close(
  name: string,
  stopClock: () => StageResult['duration'],
  memory: { stop: () => StageResult['peakMemory'] },
  error: string | undefined,
): StageResult {
  const duration = stopClock();
  const peakMemory = memory.stop();
  const base = { name, duration, peakMemory } as const;
  return error === undefined
    ? { ...base, status: 'ok' }
    : { ...base, status: 'failed', error };
}
