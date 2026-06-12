/**
 * scanRoute.ts
 *
 * The MANUAL scan-type override and the tiny pure helper that resolves it.
 *
 * Auto-detection (`classifyScanShape`) occasionally misreads a scan — e.g. a
 * real 360 house showing the Object report instead of Interior. The override is
 * the safety net: the user can FORCE the type, and a non-auto choice WINS over
 * the detected verdict so any misdetection is one click to fix.
 *
 * This module is deliberately UI- and DOM-free so the routing decision can be
 * unit-tested in isolation and reused by `applyScanRoute` in `src/main.ts`.
 */

import type { SpaceKind } from './scanShape';

/**
 * The per-session manual override. `'auto'` defers to detection (today's
 * behaviour); the other three force the corresponding route, mapping 1:1 onto
 * {@link SpaceKind}.
 */
export type ScanTypeOverride = 'auto' | 'terrain' | 'object' | 'interior';

/**
 * Decide the EFFECTIVE route from the detected verdict and the manual override.
 *
 *   - `override === 'auto'` → the detected verdict wins (unchanged behaviour).
 *   - any other override    → it wins outright, regardless of what was detected.
 *
 * Pure and total: the non-auto override values are exactly the {@link SpaceKind}
 * members, so the forced value is returned directly.
 */
export function resolveScanRoute(
  detected: SpaceKind,
  override: ScanTypeOverride,
): SpaceKind {
  if (override === 'auto') return detected;
  return override;
}

/** Inputs to {@link planScanRoute} — the host's routing state, flattened. */
export interface ScanRouteInput {
  /** What the shape classifier said, or null when it had nothing to say. */
  readonly detected: SpaceKind | null;
  /** The per-session manual "Treat as" override. */
  readonly override: ScanTypeOverride;
  /**
   * True for the open-time / explicit-override call; false for a streaming
   * re-evaluation (growth-gated node-ready re-route or the settle one-shot).
   */
  readonly initial: boolean;
  /** The effective route last applied, or null before the first application. */
  readonly lastVerdict: SpaceKind | null;
  /** True once the user pinned the routing via the dock's Analyse toggle. */
  readonly pinned: boolean;
  /**
   * True when this evaluation runs on SETTLED geometry — the open-time call
   * for a static (fully loaded) file, or the one-shot re-evaluation fired
   * when a streaming cloud reaches "Streaming ready". A settled verdict is
   * the one the "Treat as" control soft-commits to (see `commitDetected`);
   * sparse mid-stream frames (false) only ever route, never commit.
   */
  readonly settled?: boolean;
}

/** The full routing decision — what the host applies to the panels. */
export interface ScanRoutePlan {
  /** False ⇒ leave everything untouched (the call is a guarded no-op). */
  readonly apply: boolean;
  /** The effective route (override resolved over detection); null = unknown. */
  readonly effective: SpaceKind | null;
  /** Show the Object/Space panel (non-terrain routes). */
  readonly showObjectPanel: boolean;
  /** Show the terrain Analyse panel (terrain route or nothing detected yet). */
  readonly showAnalysePanel: boolean;
  /**
   * Expand the Analyse panel AND kick the terrain pipeline. ONLY ever true for
   * an explicit user override ('terrain' via the "Run terrain contours anyway"
   * hatch or the Treat-as control) — auto-detection NEVER starts an analysis.
   */
  readonly runTerrain: boolean;
  /**
   * Non-null ⇒ the "Treat as" control should SOFT-COMMIT its displayed
   * selection to this detected type (aria-pressed moves from Auto onto the
   * detected pill, which keeps its "detected" accent dot). Set ONLY on a
   * SETTLED auto-mode verdict — the static-load detection or the streaming
   * settle one-shot — and ONLY when that verdict matches the route actually
   * standing (a settled terrain read against a standing interior route never
   * commits: the routing guard refused it, so the pill must not claim it).
   * Detection-sourced, NOT a user override: it must not pin routing, must
   * reset to Auto on a new scan, and Auto stays one click away.
   */
  readonly commitDetected: SpaceKind | null;
}

const NO_APPLY: ScanRoutePlan = {
  apply: false,
  effective: null,
  showObjectPanel: false,
  showAnalysePanel: false,
  runTerrain: false,
  commitDetected: null,
};

/**
 * Decide the complete panel routing for one `applyScanRoute` call. Pure — the
 * whole route matrix is unit-testable without the DOM host:
 *
 *   - A non-initial (streaming re-evaluation) call no-ops when the routing is
 *     pinned, manually overridden, undecidable, or unchanged — as before.
 *   - NEW (v0.4.5 fix): a non-initial call may only re-route TOWARD the
 *     Object/Space panel (object / interior). It must NEVER flip the session
 *     to terrain: the streaming re-evaluation exists to rescue interiors
 *     misread as terrain/object on a sparse early frame, and a mid-fill frame
 *     that momentarily reads as terrain was exactly how the terrain
 *     Surface-Quality/Analyse panel "opened on its own" on a scan whose
 *     settled verdict is interior. Terrain analysis is reachable mid-session
 *     only via the explicit hatch / manual Terrain override.
 *   - `runTerrain` is true ONLY when the user explicitly forced terrain; a
 *     detected-terrain route shows the (collapsed) Analyse panel but never
 *     starts the pipeline by itself.
 */
export function planScanRoute(input: ScanRouteInput): ScanRoutePlan {
  const { detected, override, initial, lastVerdict, pinned } = input;
  const settled = input.settled === true;
  // The settled soft-commit (see ScanRoutePlan.commitDetected): an auto-mode
  // verdict on settled geometry commits the control's pill to the detected
  // type — but only when that verdict matches the route that will actually
  // stand after this call (`detected === lastVerdict` covers the no-op
  // "verdict unchanged" path; an applied route's effective IS the detected
  // value under auto). A pin keeps the commit off exactly like it freezes
  // routing.
  const commitFor = (applies: boolean): SpaceKind | null =>
    settled &&
    !pinned &&
    override === 'auto' &&
    detected !== null &&
    (applies || detected === lastVerdict)
      ? detected
      : null;
  // A pin or a non-auto manual override freezes routing against re-evaluation.
  if (!initial && (pinned || override !== 'auto')) return NO_APPLY;
  // Effective route: the override resolved over detection. When detection has
  // nothing to say, a NON-AUTO override still routes by itself (the user's
  // explicit choice must never strand them on a torn-down panel just because
  // the gather failed at click time).
  const effective: SpaceKind | null =
    detected !== null
      ? resolveScanRoute(detected, override)
      : override !== 'auto'
        ? override
        : null;
  if (!initial) {
    // Re-route only when the effective route genuinely changes — never thrash.
    if (effective === null || effective === lastVerdict) {
      return { ...NO_APPLY, commitDetected: commitFor(false) };
    }
    // Never auto-surface the terrain panel mid-session (see doc comment).
    if (effective === 'terrain') return NO_APPLY;
  }
  const isNonTerrain = effective !== null && effective !== 'terrain';
  return {
    apply: true,
    effective,
    showObjectPanel: isNonTerrain,
    showAnalysePanel: !isNonTerrain,
    runTerrain: !isNonTerrain && override === 'terrain',
    commitDetected: commitFor(true),
  };
}

/**
 * The octree depth the resident set must reach before a "Streaming ready"
 * idle poll counts as GENUINELY settled — the gate in front of the streaming
 * settle one-shot (`applyScanRoute(false, true)` in `src/main.ts`).
 *
 * Mirrors the benchmark's coarse-stable guard and exists for the same reason:
 * the scheduler often reads idle at the root level (depth 0, root-only on a
 * slow link or a wide first view) long before the cloud has actually filled
 * in. v0.4.5 shipped with the one-shot fired — and SPENT — on that first
 * transient idle: the sparse frame's verdict was terrain/undecidable, the
 * planner refused it (no apply, no commit), and the genuine settle later
 * could never move the "Treat as" pill off Auto. Gating the attempt on real
 * depth coverage keeps THE settled verdict an actual settled verdict.
 *
 * Large hierarchies must show residency at depth ≥ 2; tiny scans whose whole
 * hierarchy is depth 0–1 settle at their own max depth (they have no deeper
 * level to wait for). Pure so the gate is unit-testable.
 */
export function settleTargetDepth(hierarchyMaxDepth: number): number {
  return Math.min(2, Math.max(0, hierarchyMaxDepth));
}

/**
 * Max settled evaluation attempts per scan. A refused or undecidable settled
 * verdict re-arms the one-shot (see {@link settleOneShotSpent}), so without a
 * cap a scan whose gather permanently fails — or whose early-node verdict is
 * permanently refused by the no-flip guard — would re-classify on every
 * "Streaming ready" poll forever. After this many attempts the one-shot is
 * spent regardless; the pill simply stays on Auto, which is the honest state.
 */
export const SETTLE_RETRY_CAP = 40;

/** Inputs to {@link settleOneShotSpent} — the settled evaluation's outcome. */
export interface SettleSpendInput {
  /** What the shape classifier said on this settled frame (null = undecidable). */
  readonly detected: SpaceKind | null;
  readonly override: ScanTypeOverride;
  readonly pinned: boolean;
  /** True when the planner APPLIED the verdict (`plan.apply`). */
  readonly applied: boolean;
  /** True when the settled soft-commit fired (`plan.commitDetected !== null`). */
  readonly committed: boolean;
  /** Settled evaluation attempts for this scan, INCLUDING this one. */
  readonly attempts: number;
}

/**
 * Whether a SETTLED re-evaluation SPENDS the streaming settle one-shot.
 *
 * v0.4.5 shipped "spend on reached verdict": any non-null detection spent the
 * one-shot, whatever the planner did with it. The remaining hole (the
 * "interior STILL not auto-committed" report): ceiling-heavy early nodes can
 * make the settled frame read TERRAIN even past the depth gate — the planner
 * REFUSES a mid-session terrain flip (no apply, NO COMMIT), yet the verdict
 * counted as "reached", the one-shot was spent, and the pill stayed on Auto
 * forever while the genuinely settled interior verdict arrived one poll later
 * with nothing left to fire.
 *
 * The one-shot is therefore spent only when:
 *   - no commit can ever come anyway (routing pinned / manual override), or
 *   - the verdict actually LANDED — the planner applied it or the settled
 *     soft-commit fired.
 *
 * A refused verdict and an undecidable frame both RE-ARM the one-shot so a
 * later ready poll retries on fuller geometry — bounded by
 * {@link SETTLE_RETRY_CAP} so a permanently refused/undecidable scan cannot
 * re-classify forever. Pure; the host applies the returned value to its
 * `streamingSettledRouted` latch.
 */
export function settleOneShotSpent(input: SettleSpendInput): boolean {
  if (input.pinned || input.override !== 'auto') return true;
  if (input.applied || input.committed) return true; // the verdict LANDED
  // Refused (detected but not applied/committed) or undecidable: re-arm,
  // capped so the re-evaluation can never loop unbounded.
  return input.attempts >= SETTLE_RETRY_CAP;
}
