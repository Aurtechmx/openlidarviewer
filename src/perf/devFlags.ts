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
 *
 * Consumer status, kept honest — a flag with no consumer changes nothing:
 *   - Live: `handPan` (NavController pan mode, the G/Digit4 bindings, the
 *     middle-mouse temporary grab, and the NavBar Pan surfaces via
 *     `Viewer.handPanEnabled`); `wheelDolly` (NavController's wheel handler);
 *     `adaptiveDpr` and `refinementPhase` (the Viewer's resolution/refinement
 *     loop).
 *   - Staged: `streamingScore`, `uploadQueue`, and `angularPrediction` have
 *     tested cores but are not wired into the live render/stream path yet, so
 *     their flags are parse-only. The metrics export lists these under
 *     `stagedControllers`, never as active flags.
 * Defaults equal the new-behavior-ON path; `off` / `legacy` restores v0.5.4.
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
