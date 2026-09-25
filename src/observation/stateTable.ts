/**
 * stateTable.ts — OB-ST-01: counters to a state, per source and in aggregate.
 *
 * SPEC §2.2-§2.4 is prose. This restates it as a total function: an explicit
 * answer for every combination of counters, addressed and notDecoded flags,
 * across any number of sources, including combinations the prose leaves
 * between two named bands. Two places close a gap the prose leaves open, both
 * preregistered in `validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json`
 * alongside the numeric thresholds:
 *
 *   PARTIAL is the total complement of SURFACE and OBSERVED_EMPTY, not only
 *   the literal `p_empty < f < p_solid` band. SPEC's own three bullets leave a
 *   gap: a voxel with `hit = 0` and `0 < pass < n_min` fits none of them,
 *   since it fails OBSERVED_EMPTY's `pass ≥ n_min` and fails PARTIAL's literal
 *   `f > p_empty` (its `f` is exactly 0). Reading PARTIAL as "some hit-or-pass
 *   evidence, and not confidently SURFACE or OBSERVED_EMPTY" closes this
 *   without moving the p_solid/p_empty boundary itself. SURFACE and
 *   OBSERVED_EMPTY keep their literal definitions.
 *
 *   OUTSIDE_DOMAIN is evaluated FIRST, not last. SPEC numbers it rule 9 but
 *   states in the same sentence that it "is applied first spatially" — the
 *   list order is presentation order, not evaluation order, for that one rule.
 *
 * The independent restatement this function is checked against is
 * `validation/observatory/oracle/state_table.py`, written from this same
 * comment rather than from this file's code, and the exhaustive lattice test
 * (`tests/observatoryStateTable.test.ts`) asserts the two agree.
 *
 * Pure: no imports beyond sibling types, no I/O, no randomness.
 */
import type { ObservationCounters, ObservationParameters, ObservationState, SourceObservationRecord } from './types';

/** Which step of the precedence order produced the state (OB-UI-03: "the rule row"). */
export type ObservationStateRuleId = ObservationState;

/** Details on a `CONFLICT` verdict: the two disagreeing sources and their own counters (SPEC §2.3: "keeps both source ids and both counts"). */
export interface ObservationConflictDetail {
  readonly solidSourceIndex: number;
  readonly solidCounters: ObservationCounters;
  readonly emptySourceIndex: number;
  readonly emptyCounters: ObservationCounters;
}

/** What {@link deriveObservationState} returns: the state, which rule decided it, and a one-line human account (OB-UI-03). */
export interface ObservationStateDecision {
  readonly state: ObservationState;
  readonly ruleId: ObservationStateRuleId;
  readonly detail: string;
  /** Present only when `ruleId === 'CONFLICT'`. */
  readonly conflict?: ObservationConflictDetail;
}

const thresholdParams = (p: Pick<ObservationParameters, 'p_solid' | 'p_empty' | 'n_min'>): void => {
  if (!(p.n_min >= 1)) throw new Error(`n_min must be >= 1, got ${p.n_min}`);
  if (!(p.p_empty >= 0 && p.p_empty <= 1)) throw new Error(`p_empty must be in [0, 1], got ${p.p_empty}`);
  if (!(p.p_solid >= 0 && p.p_solid <= 1)) throw new Error(`p_solid must be in [0, 1], got ${p.p_solid}`);
  if (!(p.p_empty <= p.p_solid)) {
    throw new Error(`p_empty (${p.p_empty}) must be <= p_solid (${p.p_solid})`);
  }
};

/** `hit / (hit + pass)`, or `null` when there is no hit-or-pass evidence at all (n = 0). */
function hitFraction(c: ObservationCounters): number | null {
  const n = c.hit + c.pass;
  return n > 0 ? c.hit / n : null;
}

/** SPEC §2.3's "solid" side of `CONFLICT`: `f ≥ p_solid` with `n ≥ n_min`. */
function isSolidSource(c: ObservationCounters, p: Pick<ObservationParameters, 'p_solid' | 'n_min'>): boolean {
  const n = c.hit + c.pass;
  if (n < p.n_min) return false;
  const f = hitFraction(c);
  return f !== null && f >= p.p_solid;
}

/** SPEC §2.3's "empty" side of `CONFLICT`: `f ≤ p_empty` with `n ≥ n_min`. Distinct from `OBSERVED_EMPTY`, which requires `hit = 0` exactly. */
function isConflictEmptySource(c: ObservationCounters, p: Pick<ObservationParameters, 'p_empty' | 'n_min'>): boolean {
  const n = c.hit + c.pass;
  if (n < p.n_min) return false;
  const f = hitFraction(c);
  return f !== null && f <= p.p_empty;
}

/** SPEC §2.4 "SHADOWED_s": addressed, all behind-evidence, no hit or pass evidence. */
function isShadowedSource(c: SourceObservationRecord): boolean {
  return c.addressed && c.behind > 0 && c.hit === 0 && c.pass === 0;
}

function sumCounters(sources: readonly ObservationCounters[]): { hit: number; pass: number; behind: number; noReturn: number } {
  let hit = 0;
  let pass = 0;
  let behind = 0;
  let noReturn = 0;
  for (const s of sources) {
    hit += s.hit;
    pass += s.pass;
    behind += s.behind;
    noReturn += s.noReturn;
  }
  return { hit, pass, behind, noReturn };
}

const detailFraction = (n: number, hit: number): string => (n > 0 ? `${hit}/${n}` : '0/0');

/**
 * OB-ST-01: derive a voxel's observation state.
 *
 * Calling this with a single-element `sources` array IS the per-source case
 * (SPEC §2.2: "per source, then aggregated") — with one source, `CONFLICT`
 * cannot fire (OB-INV-02: it requires two distinct sources), which follows
 * from this same code rather than from a separate branch.
 *
 * @param sources This voxel's per-source records. May be empty (no source's
 *   ray domain reaches here at all), which resolves to `UNADDRESSED` when
 *   `insideDomain` is true.
 * @param insideDomain Whether the voxel lies inside the declared ROI, range
 *   window and angular extent. Checked first (see the module comment).
 * @param params Only the three thresholds this function reads; passing the
 *   full {@link ObservationParameters} record is fine.
 */
export function deriveObservationState(
  sources: readonly SourceObservationRecord[],
  insideDomain: boolean,
  params: Pick<ObservationParameters, 'p_solid' | 'p_empty' | 'n_min'>,
): ObservationStateDecision {
  thresholdParams(params);

  // Rule applied first (SPEC §2.4): outside the ROI, range window or angular
  // extent, nothing else is evaluated.
  if (!insideDomain) {
    return { state: 'OUTSIDE_DOMAIN', ruleId: 'OUTSIDE_DOMAIN', detail: 'voxel lies outside the declared ROI, range window or angular extent' };
  }

  const totals = sumCounters(sources);
  const anyNotDecoded = sources.some((s) => s.notDecoded);

  // Rule 1: a not-decoded ray reached here and no READ ray anywhere gives hit
  // or pass evidence.
  if (anyNotDecoded && totals.hit === 0 && totals.pass === 0) {
    const count = sources.filter((s) => s.notDecoded).length;
    return {
      state: 'NOT_READ',
      ruleId: 'NOT_READ',
      detail: `${count} of ${sources.length} source(s) left a not-decoded ray reaching this voxel; no read ray gives hit or pass evidence`,
    };
  }

  // Rule 2: CONFLICT, only across two DISTINCT sources (OB-INV-02).
  for (let i = 0; i < sources.length; i++) {
    if (!isSolidSource(sources[i], params)) continue;
    for (let j = 0; j < sources.length; j++) {
      if (i === j) continue;
      if (!isConflictEmptySource(sources[j], params)) continue;
      const a = sources[i];
      const b = sources[j];
      return {
        state: 'CONFLICT',
        ruleId: 'CONFLICT',
        detail:
          `source ${a.sourceIndex} reads solid (${detailFraction(a.hit + a.pass, a.hit)}); ` +
          `source ${b.sourceIndex} reads empty (${detailFraction(b.hit + b.pass, b.hit)})`,
        conflict: {
          solidSourceIndex: a.sourceIndex,
          solidCounters: a,
          emptySourceIndex: b.sourceIndex,
          emptyCounters: b,
        },
      };
    }
  }

  const n = totals.hit + totals.pass;
  if (n > 0) {
    const f = totals.hit / n;
    // Rule 3: SURFACE.
    if (f >= params.p_solid && n >= params.n_min) {
      return { state: 'SURFACE', ruleId: 'SURFACE', detail: `aggregate hit fraction ${detailFraction(n, totals.hit)} meets p_solid over ${n} ray(s)` };
    }
    // Rule 5: OBSERVED_EMPTY (hit = 0 exactly; checked before the PARTIAL
    // catch-all so a clean empty voxel with pass < n_min does not fall into
    // it — see the module comment for the reverse case, hit = 0 with too few
    // pass rays to trust, which PARTIAL absorbs instead).
    if (totals.hit === 0 && totals.pass >= params.n_min) {
      return { state: 'OBSERVED_EMPTY', ruleId: 'OBSERVED_EMPTY', detail: `${totals.pass} pass ray(s) crossed this voxel with zero hits` };
    }
    // Rule 4: PARTIAL — everything else with any hit-or-pass evidence.
    return { state: 'PARTIAL', ruleId: 'PARTIAL', detail: `aggregate hit fraction ${detailFraction(n, totals.hit)} over ${n} ray(s) is neither solid nor confidently empty` };
  }

  // From here, totals.hit === 0 && totals.pass === 0 (no read-ray evidence at all).

  // Rule 6: SHADOWED — at least one source is individually shadowed. (The
  // rule's own "no source has hit or pass evidence" clause is already
  // established by n === 0 above.)
  const shadowedSources = sources.filter(isShadowedSource);
  if (shadowedSources.length > 0) {
    return {
      state: 'SHADOWED',
      ruleId: 'SHADOWED',
      detail: `no hit or pass from any source; behind-evidence from ${shadowedSources.length} of ${sources.length} source(s)`,
    };
  }

  // Rule 7: NO_RETURN_PATH — some addressed source fired with no return here.
  if (totals.noReturn > 0) {
    const count = sources.filter((s) => s.noReturn > 0).length;
    return {
      state: 'NO_RETURN_PATH',
      ruleId: 'NO_RETURN_PATH',
      detail: `no hit or pass from any source; ${count} of ${sources.length} source(s) fired with no return here`,
    };
  }

  // Rule 8: UNADDRESSED — the residual default: no source's evidence of any
  // recognised kind reached this voxel.
  return {
    state: 'UNADDRESSED',
    ruleId: 'UNADDRESSED',
    detail: sources.length === 0 ? 'no source records a ray domain reaching this voxel' : "no source's ray domain covers this voxel with any recorded evidence",
  };
}
