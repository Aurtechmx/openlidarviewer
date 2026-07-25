/**
 * memory.ts
 *
 * Peak process RSS across a stage.
 *
 * Peak, not final: a decode that allocates a 900 MB scratch buffer and frees it
 * before the stage ends looks like it used nothing if you only read RSS at the
 * end, and "it fits in 8 GB" is exactly the claim a reader takes from this
 * column. So the sampler keeps the largest reading it has seen.
 *
 * Where RSS cannot be read at all — a browser has no equivalent, and a locked
 * sandbox can refuse the call — the stage reports an unavailable metric with the
 * reason. It never reports 0, which would read as "this stage used no memory".
 *
 * Sampling caveat worth knowing before quoting a figure: a fully SYNCHRONOUS
 * stage blocks the event loop, so the background interval cannot fire and the
 * peak is only as good as the start/`sample()`/stop readings. Long synchronous
 * stages should call `sample()` at their own allocation high-water marks.
 */

import { measured, unavailable, type Metric } from './types';

export const MEMORY_UNAVAILABLE_REASON =
  'peak RSS not readable: process.memoryUsage() is not available in this runtime';

/** Default background sampling period. Cheap enough to be invisible in a timing. */
const DEFAULT_INTERVAL_MS = 25;

export interface MemorySamplerOptions {
  /** Injectable RSS reader in bytes; returns null when the runtime has none. */
  readonly readRss?: () => number | null;
  /** Background sampling period in ms. 0 disables the timer entirely. */
  readonly intervalMs?: number;
}

export interface MemorySampler {
  /** Take a reading now — call at a known allocation high-water mark. */
  sample(): void;
  /** Stop sampling and return the peak, or an unavailable metric. */
  stop(): Metric;
}

/** Read process RSS in bytes, or null if this runtime does not expose it. */
export function readProcessRss(): number | null {
  const p = (globalThis as {
    process?: { memoryUsage?: (() => { rss: number }) & { rss?: () => number } };
  }).process;
  const usage = p?.memoryUsage;
  if (typeof usage !== 'function') return null;
  // `process.memoryUsage.rss()` (Node 15.6+) skips building the full usage
  // object, so sampling on an interval does not itself perturb the measurement.
  if (typeof usage.rss === 'function') return usage.rss();
  return usage.call(p).rss;
}

/**
 * Begin sampling peak RSS. The first reading is taken immediately, so a stage
 * that fails before its first `sample()` still reports the baseline it started
 * from rather than nothing.
 */
export function startMemorySampler(options: MemorySamplerOptions = {}): MemorySampler {
  const read = options.readRss ?? readProcessRss;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let peak: number | null = null;

  const take = (): void => {
    let value: number | null;
    try {
      value = read();
    } catch {
      // A reader that throws is a runtime that cannot supply the number. Swallow
      // it here and let the metric say "unavailable" — a benchmark stage must
      // not fail because its instrumentation could not read a counter.
      return;
    }
    if (value === null || !Number.isFinite(value)) return;
    if (peak === null || value > peak) peak = value;
  };

  take();

  const timer = intervalMs > 0 ? setInterval(take, intervalMs) : null;
  // Node's Timeout keeps the event loop alive; unref so a suite that forgets to
  // stop a sampler cannot hang the process after its assertions have passed.
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    sample: take,
    stop(): Metric {
      take();
      if (timer !== null) clearInterval(timer);
      if (peak === null) {
        return unavailable(MEMORY_UNAVAILABLE_REASON, { runtime: 'node', deterministic: false });
      }
      // RSS depends on GC timing and OS paging, so it never repeats exactly.
      return measured(peak, 'bytes', { runtime: 'node', deterministic: false });
    },
  };
}
