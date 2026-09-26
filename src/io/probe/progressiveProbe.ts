/**
 * progressiveProbe.ts
 *
 * Widen the probe window only while nothing is decisive: 16 KiB, then 64 KiB,
 * 256 KiB and at most {@link MAX_PROBE_BYTES}. Most files settle on the first
 * window (every signature sits in the first few hundred bytes); the wider
 * windows exist for text formats whose structure starts after a long header,
 * and to give the failure report a fair sample.
 *
 * The reader is injected, so the same loop runs over a `File` slice in the
 * probe worker, over an in-memory buffer in tests, and over any other bounded
 * byte source. It never asks for more than the cap.
 *
 * Pure apart from the injected reader.
 */
import { chooseFormat, extensionOf, isDecisive, type ProbeDecision } from './formatProbes';

/** Hard bound: the most bytes a probe ever reads from one file. */
export const MAX_PROBE_BYTES = 1024 * 1024;

/** Hard bound: the longest the probe worker may run before the probe gives up. */
export const PROBE_WORKER_TIME_CAP_MS = 3000;

/** Window sizes, smallest first. The last one is {@link MAX_PROBE_BYTES}. */
export const PROBE_WINDOWS = [16 * 1024, 64 * 1024, 256 * 1024, MAX_PROBE_BYTES] as const;

/** Reads bytes [0, length) of the source. */
export type HeadReader = (length: number) => Promise<Uint8Array>;

/** Why a probe stopped without a decision, when a bound was the reason. */
export type ProbeBound = 'max-bytes' | 'time-cap' | 'read-failed';

export interface ProgressiveProbeResult {
  readonly decision: ProbeDecision;
  /** The window the decision was taken on (also the report's sample). */
  readonly sample: Uint8Array;
  /** Every window length read, in order. */
  readonly windows: number[];
  /** Set when the probe hit a bound before it could decide. */
  readonly bound?: ProbeBound;
}

/** One decision over a window already in hand. */
export function decideWindow(sample: Uint8Array, size: number, name: string): ProbeDecision {
  return chooseFormat({ bytes: sample, complete: sample.length >= size, ext: extensionOf(name) });
}

/**
 * Probe `size` bytes named `name`, starting from `first` when the caller
 * already holds the head, and widening through {@link PROBE_WINDOWS}. Never
 * throws: a failed read ends the probe on the last window, with the bound set.
 */
export async function probeProgressively(
  read: HeadReader,
  size: number,
  name: string,
  first?: Uint8Array,
  signal?: AbortSignal,
): Promise<ProgressiveProbeResult> {
  const windows: number[] = [];
  let sample = first ? first.subarray(0, Math.min(first.length, MAX_PROBE_BYTES)) : new Uint8Array(0);
  let decision: ProbeDecision | null = first ? decideWindow(sample, size, name) : null;
  if (first) windows.push(sample.length);
  let bound: ProbeBound | undefined;
  for (const w of PROBE_WINDOWS) {
    if (decision && isDecisive(decision.level)) break;
    if (signal?.aborted) break;
    const want = Math.min(w, size);
    if (want <= sample.length) continue;
    try {
      sample = (await read(want)).subarray(0, want);
    } catch {
      bound = 'read-failed';
      break;
    }
    windows.push(sample.length);
    decision = decideWindow(sample, size, name);
  }
  decision ??= decideWindow(sample, size, name);
  if (!bound && !decision.decoderId && decision.level === 'OPAQUE' && size > sample.length) bound = 'max-bytes';
  return bound ? { decision, sample, windows, bound } : { decision, sample, windows };
}
