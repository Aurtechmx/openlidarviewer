/**
 * streamingViewStatus.ts
 *
 * Presentation model for the streaming panel's readiness line.
 *
 * WHAT THIS FIXES. The panel used to describe a view-dependent source with a
 * GLOBAL ratio — resident nodes over every node the hierarchy knows about — and
 * latched a terminal "ready" the moment the scheduler first went idle. Both
 * readings mislead: a hierarchy count is not a download denominator (the
 * scheduler never intends to fetch the whole octree), and a latch cannot be
 * revoked, so panning to a brand-new region still read 100% while a whole new
 * wanted set was loading.
 *
 * The honest quantity is the CURRENT VIEW: of the nodes the scheduler wants for
 * the camera as it stands, how many are resident. That verdict already exists —
 * `evaluateRefinementReadiness` derives it from wanted-set counts and the
 * renderer's DPR phase machine acts on it. This module only INTERPRETS that
 * verdict for display: it re-decides nothing, and introduces no threshold of
 * its own that could let an incomplete set claim completion.
 *
 * Pure: numbers and strings in, one record out. No DOM, no scheduler import.
 */

import type { StreamingDiagnostics } from '../render/streaming/streamingDiagnostics';

/**
 * The displayed state.
 *
 * The first four mirror the canonical readiness phases one-for-one. The other
 * two are presentation refinements over facts the verdict already carries, not
 * new verdicts: `incomplete` is a set holding failed nodes (the readiness model
 * calls that `'loading'` forever, which is true but does not say why), and
 * `paused` is a set the user stopped.
 */
export type StreamingViewState =
  | 'unknown'
  | 'loading'
  | 'settling'
  | 'settled'
  | 'incomplete'
  | 'paused';

/** How the line should read — never a colour, so the panel keeps its own styling. */
export type StreamingViewTone = 'neutral' | 'progress' | 'ready' | 'warn';

/** One rendering of the current-view readiness verdict. */
export interface StreamingViewStatus {
  readonly state: StreamingViewState;
  /** The headline sentence for the phase line. */
  readonly headline: string;
  /** Resident share of the WANTED set in [0,1], or null when there is no denominator. */
  readonly fraction: number | null;
  /** Whether `fraction` may be drawn as a bar (false ⇒ indeterminate, no percentage). */
  readonly determinate: boolean;
  /** Compact counts under the headline; empty when there is nothing to count. */
  readonly detail: string;
  readonly tone: StreamingViewTone;
}

/** "N requested node" / "N requested nodes" — the counts are small and exact. */
function nodes(n: number): string {
  return `${n} requested node${n === 1 ? '' : 's'}`;
}

/**
 * Interpret one streaming-diagnostics snapshot as a current-view readout.
 *
 * Precedence, and why:
 *  1. no wanted set (`wantedNodes === 0`) → `unknown`. Nothing is wanted, so
 *     there is nothing to be ready about and no denominator to be a percentage
 *     of. Indeterminate, with no fabricated fraction — this holds even while
 *     paused, because a paused view with no wanted set has nothing to report.
 *  2. `failedNodes > 0` → `incomplete`, whatever the phase says. A set that
 *     cannot complete must never present as ready, and the count of nodes that
 *     could not load is the fact the user needs; the real resident share is
 *     preserved beside it.
 *  3. paused → `paused`. A stopped load is not a failed one, and the two must
 *     not be told with the same words.
 *  4. otherwise the canonical phase, verbatim.
 *
 * `settled` means every wanted node is resident with nothing queued, in flight
 * or awaiting commit, and none failed. It does NOT mean the source finished
 * downloading; no wording here says it does.
 *
 * @param diagnostics one snapshot — take it ONCE per tick so every surface
 * describes the same instant.
 * @param paused whether the user has paused streaming.
 */
export function streamingViewStatus(
  diagnostics: StreamingDiagnostics,
  paused: boolean,
): StreamingViewStatus {
  const wanted = diagnostics.wantedNodes;
  if (wanted === 0) {
    return {
      state: 'unknown',
      headline: 'Establishing current view…',
      fraction: null,
      determinate: false,
      detail: '',
      tone: 'neutral',
    };
  }

  const resident = Math.min(diagnostics.residentNodes, wanted);
  // Read from the snapshot when the scheduler stated it, so the bar and the
  // renderer's phase machine cannot disagree by a rounding step.
  const fraction = diagnostics.fractionResident ?? resident / wanted;
  const detail = `${resident} / ${wanted} requested nodes resident`;

  if (diagnostics.failedNodes > 0) {
    return {
      state: 'incomplete',
      headline: `Current view incomplete — ${nodes(diagnostics.failedNodes)} could not load`,
      fraction,
      determinate: true,
      detail,
      tone: 'warn',
    };
  }

  if (paused) {
    return {
      state: 'paused',
      headline: 'Paused',
      fraction,
      determinate: true,
      detail,
      tone: 'neutral',
    };
  }

  switch (diagnostics.readinessPhase) {
    case 'settled':
      return {
        state: 'settled',
        headline: 'Current view ready',
        fraction,
        determinate: true,
        detail,
        tone: 'ready',
      };
    case 'settling':
      return {
        state: 'settling',
        headline: 'Refining current view…',
        fraction,
        determinate: true,
        detail,
        tone: 'progress',
      };
    default:
      return {
        state: 'loading',
        headline: 'Loading current view…',
        fraction,
        determinate: true,
        detail,
        tone: 'progress',
      };
  }
}
