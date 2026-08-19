/**
 * devFlags.ts
 *
 * Development/audit-only URL feature flags. Each flag lets a maintainer disable
 * one v0.5.5 controller — or select the legacy implementation — for A/B
 * comparison against the v0.5.4 baseline:
 *
 *   ?wheelDolly=legacy       wheel/trackpad dolly → OrbitControls wheel
 *   ?handPan=off             hand (Pan) tool unavailable
 *   ?adaptiveDpr=off         motion-adaptive device-pixel-ratio off
 *   ?refinementPhase=off     post-motion refinement phases off
 *   ?streamingScore=legacy   parse-only, see Staged below
 *   ?uploadQueue=off         parse-only, see Staged below
 *   ?angularPrediction=off   parse-only, see Staged below
 *   ?decodePool=on           OPT-IN: pooled COPC/EPT decode workers
 *   ?decodeWorkers=N         OPT-IN: pooled decode with exactly N (1-4) workers
 *
 * `decodePool` runs the other way round from the flags above: it is OFF by
 * default and can only be turned ON. Both decode clients ship on the historical
 * single-worker path until a browser measurement on a real COPC/EPT dataset
 * shows pooled decoding behaving under a fast camera sweep — throughput and the
 * memory cost of one laz-perf WASM heap per worker. Either flag enables it:
 * `?decodePool=on` uses the device-aware size policy, `?decodeWorkers=N` pins
 * the count and implies the pool is on.
 *
 * Consumer status, kept honest — a flag with no consumer changes nothing:
 *   - Live: `handPan` (NavController pan mode, the G/Digit4 bindings, the
 *     middle-mouse temporary grab, and the NavBar Pan surfaces via
 *     `Viewer.handPanEnabled`); `wheelDolly` (NavController's wheel handler);
 *     `adaptiveDpr` and `refinementPhase` (the Viewer's resolution/refinement
 *     loop); `decodePool` and `decodeWorkers` (both decode worker clients,
 *     read once when the client is constructed).
 *   - Staged: `streamingScore`, `uploadQueue`, and `angularPrediction` have
 *     tested cores but are not wired into the live render/stream path yet, so
 *     their flags are parse-only. The metrics export lists these under
 *     `stagedControllers`, never as active flags.
 * Defaults equal the new-behavior-ON path; `off` / `legacy` restores v0.5.4.
 * The one exception is the `decodePool` pair described above, which defaults to
 * the OLD path and must be opted into.
 *
 * Pure — no DOM at module scope, no three.js — fully unit-tested in Node.
 * NOT part of the index chunk: only lazy modules may import it, and the
 * chunk-isolation guard keeps those importers out of the shell.
 */

/** Two-way implementation selector: the new default vs the v0.5.4 legacy. */
export type ImplFlag = 'default' | 'legacy';

/**
 * Streaming node-commit path. `immediate` marks a decoded node resident in the
 * same turn it decoded (the historical, byte-for-byte default); `metered`
 * routes commits through the P7 GpuUploadQueue so a burst of decodes spreads
 * over several frames. Opt-in and unverified until browser measurement, so the
 * default stays `immediate`. Consumed live by the Viewer's streaming path.
 */
export type StreamingCommitMode = 'immediate' | 'metered';

/** The parsed development flags — one field per URL flag. */
export interface DevFlags {
  /** P4 node scoring: 'legacy' = v0.5.4 depth-first scoring. */
  streamingScore: ImplFlag;
  /** P2 wheel/trackpad dolly: 'legacy' = OrbitControls built-in wheel. */
  wheelDolly: ImplFlag;
  /** P1 hand tool available. */
  handPan: boolean;
  /** P6 refinement phases active. */
  refinementPhase: boolean;
  /** P5 adaptive DPR active. */
  adaptiveDpr: boolean;
  /**
   * P7 time-budgeted GPU upload queue active. Parsed and reported, never read
   * by a controller: the Viewer constructs no upload queue. Reading `true`
   * here does not mean a queue is running.
   */
  uploadQueue: boolean;
  /** P3 angular-velocity prediction active. */
  angularPrediction: boolean;
  /**
   * P7 streaming commit path. `metered` wires the upload queue into the live
   * scheduler; `immediate` (default) keeps the direct commit. Unlike
   * `uploadQueue` above, this flag is READ by the Viewer — it is the switch
   * that actually stands the queue up.
   */
  streamingCommitMode: StreamingCommitMode;
  /**
   * Pooled COPC/EPT decode workers requested. OFF by default: absent the flag,
   * both decode clients run the historical single-worker path. `?decodePool=on`
   * opts in and the device policy picks the size. This is the inverse of the
   * flags above — it can only ever turn something ON, so a stray or malformed
   * value can never move a session off the shipping default.
   */
  decodePool: boolean;
  /**
   * Resident-stickiness in the budget selection. OFF by default: absent the
   * flag, selection is the plain greedy fill it has always been. `?stickiness=on`
   * gives an already-resident, non-refining node a small score bonus so
   * budget-boundary noise cannot bump it out and force an evict → re-decode →
   * re-fade cycle. Like `decodePool`, this can only ever turn something ON, so a
   * stray value can never move a session off the shipping default.
   */
  residentStickiness: boolean;
  /**
   * Explicit decode worker count, or null for "not specified". Only 1-4 are
   * accepted; anything else, including garbage and out-of-range values, reads
   * as null. A value here also opts INTO the pool — asking for N workers and
   * getting one would be a flag that lies.
   */
  decodeWorkers: number | null;
}

/**
 * The defaults when a flag is absent or unparseable. All "new behavior ON /
 * default implementation" — which, while the gated controllers do not exist
 * yet (P0), is identical to v0.5.4 behavior.
 */
export const DEV_FLAG_DEFAULTS: Readonly<DevFlags> = Object.freeze({
  streamingScore: 'default',
  wheelDolly: 'default',
  handPan: true,
  refinementPhase: true,
  adaptiveDpr: true,
  uploadQueue: true,
  angularPrediction: true,
  streamingCommitMode: 'immediate',
  // Pooled decoding is the one flag whose default is the OLD path. It stays
  // opt-in until a browser run on a real dataset measures it; shipping an
  // unverified change on the default decode path is the mistake the multi-layer
  // mount already made once.
  decodePool: false,
  decodeWorkers: null,
  // Stickiness changes what stays on screen at the budget boundary, and flicker
  // is not observable from Node, so it stays opt-in until a browser run on a
  // real streamed cloud shows it settling the pulsing WITHOUT stalling refinement.
  residentStickiness: false,
});

/** `legacy` (any case) selects the legacy implementation; all else = default. */
function parseImpl(value: string | null): ImplFlag {
  return value !== null && value.trim().toLowerCase() === 'legacy'
    ? 'legacy'
    : 'default';
}

/**
 * Opt-in switch, the mirror of {@link parseOnOff}: only `metered` (any case)
 * selects the new path; absence, empty, and garbage all keep the safe default.
 * A flag can only opt INTO metering, never leave it on by accident.
 */
function parseCommitMode(value: string | null): StreamingCommitMode {
  return value !== null && value.trim().toLowerCase() === 'metered'
    ? 'metered'
    : 'immediate';
}

/**
 * On/off flag: `off`, `0`, and `false` (any case) disable; everything else —
 * including absence, empty string, and garbage — keeps the default (on).
 * A flag can never *enable more* than the default; it only opts out.
 */
function parseOnOff(value: string | null): boolean {
  if (value === null) return true;
  const v = value.trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/**
 * Opt-IN switch, the mirror of {@link parseOnOff}: only `on`, `1` or `true`
 * (any case) enables; absence, empty, `off` and garbage all keep the shipping
 * default. Used where the default is the OLD behaviour and the flag exists to
 * request the new one, so no malformed URL can move a user off the safe path.
 */
function parseOptIn(value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

/**
 * Decode worker count. Only a whole number in `[1, 4]` counts; absence, a
 * fraction, a negative, a huge value and outright garbage all read as null so
 * the device policy decides. The upper bound mirrors
 * `DECODE_POOL_HARD_CAP` — kept as a literal here because devFlags is pure
 * parsing and importing an io module for one number would invert the layering.
 * The pool clamps to the same cap regardless, so the two cannot disagree in a
 * way that matters.
 */
function parseWorkerCount(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

/**
 * Parse the development flags from a query string or URLSearchParams.
 * Never throws — malformed input degrades to the defaults, field by field.
 */
export function parseDevFlags(search: string | URLSearchParams): DevFlags {
  let params: URLSearchParams;
  try {
    params = typeof search === 'string' ? new URLSearchParams(search) : search;
  } catch {
    return { ...DEV_FLAG_DEFAULTS };
  }
  return {
    streamingScore: parseImpl(params.get('streamingScore')),
    wheelDolly: parseImpl(params.get('wheelDolly')),
    handPan: parseOnOff(params.get('handPan')),
    refinementPhase: parseOnOff(params.get('refinementPhase')),
    adaptiveDpr: parseOnOff(params.get('adaptiveDpr')),
    uploadQueue: parseOnOff(params.get('uploadQueue')),
    angularPrediction: parseOnOff(params.get('angularPrediction')),
    streamingCommitMode: parseCommitMode(params.get('streamingCommitMode')),
    decodePool: parseOptIn(params.get('decodePool')),
    residentStickiness: parseOptIn(params.get('stickiness')),
    decodeWorkers: parseWorkerCount(params.get('decodeWorkers')),
  };
}

/** Memoized result of {@link readDevFlags} — parsed once per session. */
let cached: DevFlags | null = null;

/**
 * The session's development flags, parsed once from
 * `window.location.search`. Safe anywhere: in a DOM-free environment (unit
 * tests, workers) it returns the defaults.
 */
export function readDevFlags(): DevFlags {
  if (cached) return cached;
  const search =
    typeof window !== 'undefined' && typeof window.location !== 'undefined'
      ? window.location.search
      : '';
  cached = parseDevFlags(search);
  return cached;
}

/** Test hook — drop the memoized flags so a new search string re-parses. */
export function resetDevFlagsForTest(): void {
  cached = null;
}
