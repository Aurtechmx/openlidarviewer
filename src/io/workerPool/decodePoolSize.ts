/**
 * decodePoolSize.ts
 *
 * How many decode workers a device should run — the one place that decides,
 * so no concurrency number is hard-coded at a call site.
 *
 * The shape of the answer is set by what the machine actually has to do while
 * decoding: the main thread is still running the app, and the renderer still
 * needs a core to draw the frames the decoded points land in. So the policy
 * never claims the whole machine. The bands below come from that reasoning:
 *
 *     cores    workers   left for main thread + rendering + system
 *     1-2      1         0-1
 *     3-4      2         1-2
 *     5-8      3         2-5
 *     9+       4         5+
 *
 * At 4 cores and up the two reserved core-equivalents are genuinely free. Below
 * that the floor of one worker wins: decoding has to happen off the main thread
 * at all, and a decode is bursty rather than a pinned core, so a dual-core
 * machine running one decode worker is still better off than one decoding
 * inline. That floor is the only point where the reserve is notional.
 *
 * The hard cap of 4 is not a core-count question. Past four concurrent decodes
 * the wins stop: the streaming scheduler admits at most 4 concurrent decodes
 * (2 on mobile — see `streamingBudgets` in render/streaming/streamingBudget.ts),
 * so a fifth worker would sit idle while still holding its own laz-perf WASM
 * heap. Each pooled worker instantiates one, which is the real per-worker cost.
 *
 * Pure — no DOM, no three.js — so every band is unit-tested in Node.
 * {@link readDecodePoolEnvironment} is the single impure seam and is kept
 * apart from the policy for exactly that reason.
 */

import { deviceTier, type DeviceSignals } from '../../render/deviceProfile';

/** Which decode client is asking. */
export type DecodeFormat = 'copc' | 'ept' | 'laz';

/** Ceiling on pooled decode workers, whatever the device or the override says. */
export const DECODE_POOL_HARD_CAP = 4;

/**
 * Ceiling on phone-class devices. Matches the scheduler's mobile
 * `maxConcurrentDecodes` of 2: a third worker could never be given work, and
 * would cost a third WASM heap on the device least able to afford one.
 */
export const DECODE_POOL_MOBILE_CAP = 2;

/**
 * What to assume when `navigator.hardwareConcurrency` is unreadable. Two on a
 * desktop (the 3-4 core band — the common floor for a machine that can run this
 * app at all), one on mobile. Assuming less than the truth costs throughput;
 * assuming more costs memory on a device that may not have it.
 */
const UNKNOWN_CORES_DESKTOP = 2;
const UNKNOWN_CORES_MOBILE = 1;

/** Everything the policy reads about the device and the session. */
export interface DecodePoolSizeInput extends DeviceSignals {
  /** Which client is asking. */
  readonly format: DecodeFormat;
  /**
   * An explicit worker count from `?decodeWorkers=N` or a constructor option.
   * Clamped to `[1, DECODE_POOL_HARD_CAP]`; null/undefined means "use the
   * device policy". A maintainer's deliberate override outranks the device
   * bands, but never the hard cap.
   */
  readonly requested?: number | null;
  /** `?decodePool=off` — collapse to the single-worker path. */
  readonly poolDisabled?: boolean;
}

/** The core-count band, before any device or cap adjustment. */
function bandForCores(cores: number): number {
  if (cores <= 2) return 1;
  if (cores <= 4) return 2;
  if (cores <= 8) return 3;
  return DECODE_POOL_HARD_CAP;
}

/**
 * `navigator.hardwareConcurrency` is optional and, on some browsers, a lie
 * (frozen at 2, or absent entirely). Anything that is not a finite integer of
 * at least 1 is treated as unknown rather than coerced.
 */
function usableCores(reported: number | undefined): number | undefined {
  if (typeof reported !== 'number') return undefined;
  if (!Number.isFinite(reported)) return undefined;
  const cores = Math.floor(reported);
  return cores >= 1 ? cores : undefined;
}

/**
 * How many decode workers to run. Pure: the same input always gives the same
 * answer, and the answer is always within `[1, DECODE_POOL_HARD_CAP]`.
 *
 * `format` is part of the input because the two decode paths have different
 * unit costs (a COPC chunk is a node body; an EPT laszip tile is a whole LAZ
 * file with its own header) and may want to diverge. They do not today, and
 * the policy deliberately contains no branch pretending otherwise — the
 * parameter is here so a future divergence changes this module and nothing
 * else.
 */
export function decodeWorkerPoolSize(input: DecodePoolSizeInput): number {
  if (input.poolDisabled) return 1;

  const requested = input.requested;
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return clamp(Math.floor(requested), 1, DECODE_POOL_HARD_CAP);
  }

  const cores = usableCores(input.hardwareConcurrency);
  let workers: number;
  if (cores !== undefined) {
    workers = bandForCores(cores);
  } else if (input.isMobile) {
    workers = UNKNOWN_CORES_MOBILE;
  } else {
    workers = UNKNOWN_CORES_DESKTOP;
  }

  if (input.isMobile) workers = Math.min(workers, DECODE_POOL_MOBILE_CAP);

  // A memory-starved machine (`low` tier: ≤2 GB reported, or a phone) pays for
  // every extra WASM heap out of the same budget the point cloud itself needs.
  // This only ever REDUCES the band, so it can never push the pool past a cap.
  if (deviceTier(input) === 'low') workers = Math.min(workers, 1);

  return clamp(workers, 1, DECODE_POOL_HARD_CAP);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The URL-flag half of the decision, shaped structurally so `src/io` needs no
 *  import from `src/perf` (the flags module owns parsing, not policy). */
export interface DecodePoolFlags {
  /** `?decodePool=on` — pooled decoding requested. */
  readonly decodePool: boolean;
  /** `?decodeWorkers=N` — an explicit count, or null when unspecified. */
  readonly decodeWorkers: number | null;
}

/**
 * The size a decode client should build, from the live environment and the
 * session's flags. The single place the OPT-IN rule lives, so the two clients
 * cannot drift on it.
 *
 * Pooled decoding is off unless something asks for it. Three things can ask:
 * `?decodePool=on`, `?decodeWorkers=N` (asking for N workers and silently
 * getting one would be a flag that lies), or an explicit constructor size —
 * which is how the tests pin a pool without touching global flags. Absent all
 * three the answer is 1, which is the historical single-worker client.
 */
export function resolveDecodePoolSize(
  format: DecodeFormat,
  flags: DecodePoolFlags,
  explicitSize?: number,
): number {
  const requested = explicitSize ?? flags.decodeWorkers;
  return decodeWorkerPoolSize({
    ...readDecodePoolEnvironment(),
    format,
    requested,
    poolDisabled: !decodePoolOptedIn(flags, explicitSize),
  });
}

/**
 * Whether pooled decoding is opted in for this session. Three switches can ask:
 * an explicit constructor size, `?decodePool=on`, or `?decodeWorkers=N`. Absent
 * all three the answer is false and the historical single-worker path stands —
 * the whole-file LAZ path reads this to decide whether to engage the worker
 * pool at all, rather than moving every `.laz` open off the main thread before
 * a browser run has measured the trade.
 */
export function decodePoolOptedIn(flags: DecodePoolFlags, explicitSize?: number): boolean {
  return explicitSize !== undefined || flags.decodePool || flags.decodeWorkers !== null;
}

/** The device signals the policy needs, as read from the live environment. */
export interface DecodePoolEnvironment {
  readonly deviceMemoryGB?: number;
  readonly hardwareConcurrency?: number;
  readonly isMobile: boolean;
}

/**
 * Read the device signals from the browser. The single impure function in this
 * module; everything it produces feeds {@link decodeWorkerPoolSize}, which stays
 * testable in Node.
 *
 * The mobile test is the touch-first half of `ui/isMobileDevice` rather than an
 * import of it: `src/io` must not depend on the UI layer for a decision this
 * small. The consequence of the two drifting is bounded — a phone misread as a
 * desktop gets at most one extra worker, and the hard cap still applies.
 *
 * Never throws: a DOM-free environment (Node tests, a worker) reports no cores
 * and not-mobile, which lands on the conservative desktop default.
 */
export function readDecodePoolEnvironment(): DecodePoolEnvironment {
  let hardwareConcurrency: number | undefined;
  let deviceMemoryGB: number | undefined;
  try {
    const nav = (
      globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }
    ).navigator;
    hardwareConcurrency = nav?.hardwareConcurrency;
    // Chromium only. Feeds the `low`-tier clamp; absence means the tier falls
    // back to core count, exactly as `deviceTier` documents.
    const mem = nav?.deviceMemory;
    deviceMemoryGB = typeof mem === 'number' && mem > 0 ? mem : undefined;
  } catch {
    /* no navigator — the policy's unknown-cores default covers it */
  }
  let isMobile = false;
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    if (typeof mm === 'function') {
      isMobile = mm.call(globalThis, '(pointer: coarse) and (hover: none)').matches;
    }
  } catch {
    /* matchMedia unavailable or threw — treat as desktop, capped anyway */
  }
  return { deviceMemoryGB, hardwareConcurrency, isMobile };
}
