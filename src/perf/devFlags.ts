/**
 * devFlags.ts
 *
 * Development/audit-only URL feature flags for the v0.5.5 program
 * (docs/_audit/v0.5.5-program.md §5 P0). Each flag lets a maintainer disable
 * one new v0.5.5 controller — or select the legacy implementation — for A/B
 * comparison against the v0.5.4 baseline:
 *
 *   ?streamingScore=legacy   pixel-space scoring (P4) → v0.5.4 scoring
 *   ?wheelDolly=legacy       wheel dolly controller (P2) → OrbitControls wheel
 *   ?handPan=off             hand tool (P1) unavailable
 *   ?refinementPhase=off     refinement phases (P6) off
 *   ?adaptiveDpr=off         adaptive DPR (P5) off
 *   ?uploadQueue=off         GPU upload queue (P7) off
 *   ?angularPrediction=off   angular-velocity motion model (P3) off
 *
 * P0 state: the flags are parsed and surfaced (debug overlay, metrics JSON)
 * but nothing consumes them yet — the controllers they gate land in later
 * PRs. Defaults therefore equal current (v0.5.4) behavior by construction.
 *
 * Pure — no DOM at module scope, no three.js — fully unit-tested in Node.
 * NOT part of the index chunk: only lazy modules (DebugOverlay today, the
 * P1–P7 controllers later) may import it. The chunk-isolation guard keeps
 * those importers out of the shell, and this module rides along with them.
 */

/** Two-way implementation selector: the new default vs the v0.5.4 legacy. */
export type ImplFlag = 'default' | 'legacy';

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
  /** P7 time-budgeted GPU upload queue active. */
  uploadQueue: boolean;
  /** P3 angular-velocity prediction active. */
  angularPrediction: boolean;
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
});

/** `legacy` (any case) selects the legacy implementation; all else = default. */
function parseImpl(value: string | null): ImplFlag {
  return value !== null && value.trim().toLowerCase() === 'legacy'
    ? 'legacy'
    : 'default';
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
