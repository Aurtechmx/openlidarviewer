/**
 * refinementReadiness.ts
 *
 * A pure readiness model derived from SCHEDULER STATE rather than from a clock.
 *
 * WHY THIS EXISTS. The refinement phase machine (`nextRefinementPhase` in
 * `render/refinementPhase.ts`) takes two readiness signals —
 * `coverageComplete` and `centralRefined` — and the phase machine itself is
 * exact. What feeds it today is not: the Viewer supplies both as elapsed-time
 * proxies (`coverageComplete: msSinceSettle >= SETTLE_MS`,
 * `centralRefined: msSinceSettle >= PHASE_CENTER_PROXY_MS`), and
 * `refinementPhase.ts` itself gates the first transition on
 * `msSinceSettle >= settleMs`. A stopwatch cannot tell the difference between
 * a scene that finished streaming and a scene that is still waiting on a slow
 * network: after 250 ms both look "refined". One of those readings is a lie,
 * and it is the one that shows a sharp, full-resolution frame over a half-loaded
 * cloud — the failure mode a viewer must never have, because the user reads
 * "sharp" as "this is all the data there is".
 *
 * State answers the question the clock only guesses at: how much of the set the
 * scheduler WANTS is actually resident, and how much work is still moving. Those
 * are counts the scheduler already maintains exactly (`StreamingNodeStore`
 * keeps them O(1) at every state transition), so deriving readiness from them
 * costs nothing and cannot drift from what is on screen.
 *
 * THE REFUSAL RULE. An empty wanted set reports `'unknown'`, never `'settled'`.
 * Nothing wanted means nothing to be ready about — before the first cull, after
 * a stop, or with the hierarchy still arriving, the honest answer is "no
 * verdict", not "complete". `'settled'` is likewise exact rather than
 * thresholded: it requires every wanted node resident, nothing in flight,
 * queued, or awaiting commit, and no known failure inside the set. A set that
 * stalls short of complete (permanent decode failures) reports `'loading'`
 * forever with `fractionResident` short of 1 — which is true. A clock would have
 * called it settled seconds ago.
 *
 * Pure and deterministic: no timers, no DOM, no three.js, no scheduler import.
 * The same facts always produce the same verdict, so it is unit-tested in Node.
 *
 * WIRING: `StreamingScheduler.readinessFacts()` builds `SchedulerReadinessFacts`
 * from the live wanted set, and `Viewer.refinementReadiness()` evaluates it. The
 * Viewer's DPR phase machine reads that verdict — `settling`/`settled` drive
 * coverage and central-refine — so full resolution is reached only when the
 * requested nodes are resident, not after a fixed elapsed time. The time proxy
 * remains only as the fallback for a static cloud or the pre-first-cull window,
 * where there is no wanted set to be ready about.
 */

/**
 * The counts one readiness verdict is derived from.
 *
 * Every count is measured OVER THE WANTED SET — the caller intersects. A global
 * resident count would include nodes held by eviction hysteresis that are no
 * longer wanted, and letting those vote would let data outside the view claim
 * readiness for data inside it.
 */
export interface SchedulerReadinessFacts {
  /** Nodes the scheduler selected for this view (the denominator). */
  readonly wantedCount: number;
  /** Wanted nodes uploaded and drawable (`resident`). */
  readonly residentCount: number;
  /** Wanted nodes with a decode in flight (`loading`). */
  readonly inFlightCount: number;
  /** Wanted nodes waiting to start (`queued`). */
  readonly queuedCount: number;
  /** Wanted nodes decoded but not yet committed to the renderer (`decoded`). */
  readonly decodedPendingCount: number;
  /** Wanted nodes in the terminal-or-backing-off failure state (`error`). */
  readonly failedCount: number;
}

/**
 * A readiness verdict.
 *
 * `unknown` carries no derived numbers at all: with an empty wanted set both
 * `fractionResident` and `churn` would be fabricated from a zero denominator,
 * and a field that cannot be computed is better absent than plausible.
 */
export type RefinementReadiness =
  | { readonly phase: 'unknown' }
  | {
      readonly phase: 'loading';
      readonly fractionResident: number;
      readonly churn: number;
    }
  | {
      readonly phase: 'settling';
      readonly fractionResident: number;
      readonly churn: number;
    }
  | {
      readonly phase: 'settled';
      readonly fractionResident: 1;
      readonly churn: number;
    };

/** The phase names, for callers that only need the label. */
export type RefinementReadinessPhase = RefinementReadiness['phase'];

/**
 * Resident fraction at or above which a set with work still moving counts as
 * `'settling'` rather than `'loading'` — "the picture is essentially there, a
 * tail is still landing".
 *
 * A display-honesty threshold, not a physical constant: it separates "almost
 * done" from "still filling in" for a progress readout. `'settled'` uses no
 * threshold at all, so nothing here can make an incomplete set claim completion.
 */
export const SETTLING_MIN_FRACTION = 0.95;

/**
 * Reject a count that cannot be a count. A NaN or negative arriving here means
 * the caller's own bookkeeping is broken; silently coercing it to 0 would turn
 * a counting bug into a false `'settled'` — the exact lie this module exists to
 * prevent — so it throws, naming the argument.
 */
function requireCount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `evaluateRefinementReadiness: ${name} must be a finite count >= 0 (received ${String(value)})`,
    );
  }
}

/**
 * Evaluate readiness from scheduler counts. Pure and total: every valid input
 * yields exactly one verdict.
 *
 * Rules:
 *  - `wantedCount === 0` → `'unknown'` (the refusal rule; never `'settled'`);
 *  - nothing outstanding, every wanted node resident, no failures → `'settled'`;
 *  - work still moving and `fractionResident >= SETTLING_MIN_FRACTION` →
 *    `'settling'`;
 *  - everything else → `'loading'`, including a set stalled short of complete
 *    by permanent decode failures. `'loading'` is the honest bucket for "the
 *    wanted set is not represented on screen", whether or not anything is
 *    currently moving; the companion `failedCount` says which case it is.
 *
 * `churn` = `(inFlightCount + queuedCount) / max(1, wantedCount)` — thrash
 * visible without a timer. A camera flicked back and forth keeps churn high
 * while `fractionResident` hovers, which is a signature no elapsed-time reading
 * can produce. `decodedPendingCount` is deliberately excluded: it is work
 * already done awaiting a commit, not work being re-requested.
 *
 * @throws TypeError if any count is non-finite or negative.
 */
export function evaluateRefinementReadiness(
  facts: SchedulerReadinessFacts,
): RefinementReadiness {
  // Validate before the empty-set shortcut, so poison input is reported even
  // when the verdict would have been 'unknown' anyway.
  requireCount(facts.wantedCount, 'wantedCount');
  requireCount(facts.residentCount, 'residentCount');
  requireCount(facts.inFlightCount, 'inFlightCount');
  requireCount(facts.queuedCount, 'queuedCount');
  requireCount(facts.decodedPendingCount, 'decodedPendingCount');
  requireCount(facts.failedCount, 'failedCount');

  if (facts.wantedCount === 0) return { phase: 'unknown' };

  const churn =
    (facts.inFlightCount + facts.queuedCount) / Math.max(1, facts.wantedCount);
  const raw = facts.residentCount / facts.wantedCount;
  // Clamped for display safety only. A correct caller (counts over the wanted
  // set) cannot exceed 1; a caller that passed a global resident count can, and
  // the clamp keeps a progress bar sane without letting the excess vote below.
  const fractionResident = Math.min(1, raw);
  const outstanding =
    facts.inFlightCount + facts.queuedCount + facts.decodedPendingCount;

  if (
    outstanding === 0 &&
    facts.residentCount >= facts.wantedCount &&
    facts.failedCount === 0
  ) {
    return { phase: 'settled', fractionResident: 1, churn };
  }

  if (outstanding > 0 && fractionResident >= SETTLING_MIN_FRACTION) {
    return { phase: 'settling', fractionResident, churn };
  }

  return { phase: 'loading', fractionResident, churn };
}
