/**
 * candidateReview.ts — the review state over extracted candidates.
 *
 * Extraction proposes; a person disposes. A candidate is a DERIVED proposal, so
 * the product's job is to make each one reviewable — accept it, reject it, or
 * leave it pending — and to make those judgments outlive the extraction that
 * produced them.
 *
 * WHY THIS IS KEYED BY CANDIDATE ID, AND WHY THAT ID HAD TO BE FIXED FIRST.
 * Re-running extraction (a re-analysis, a parameter tweak, more points arriving)
 * produces a FRESH list. If a decision were held by list position, the second run
 * would silently reassign every judgment: the building the reviewer accepted as
 * #3 becomes #4, and the accept lands on a different building. Because ids are
 * now derived from a candidate's own geometry, a decision re-attaches to the
 * thing it was made about. That is the whole reason the identity fix preceded
 * this module.
 *
 * A decision for a candidate that a later run does NOT produce is KEPT, not
 * discarded: extraction output moves with its inputs, and a reviewer who
 * rejected something should not have to reject it again when it reappears.
 *
 * Pure: no DOM, no I/O, no clock. Every method is deterministic.
 */

/** Where a candidate stands with its reviewer. */
export type CandidateStatus = 'review' | 'accepted' | 'rejected';

/** The default for anything nobody has judged yet. */
export const DEFAULT_STATUS: CandidateStatus = 'review';

/** A candidate paired with the reviewer's standing decision about it. */
export interface ReviewedCandidate<T extends { readonly id: string }> {
  readonly candidate: T;
  readonly status: CandidateStatus;
}

/** How a review set stands, for a header or a gate. */
export interface ReviewSummary {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly pending: number;
  /** True when nothing is left in `review` — every candidate has been judged. */
  readonly complete: boolean;
}

/**
 * A pure store of review decisions keyed by candidate id. Only non-default
 * decisions are stored, so an untouched set costs nothing and `statusOf`
 * answers `'review'` for anything unknown.
 */
export class CandidateReviewStore {
  private readonly _byId = new Map<string, CandidateStatus>();

  /** The standing decision for an id; `'review'` when nobody has judged it. */
  statusOf(id: string): CandidateStatus {
    return this._byId.get(id) ?? DEFAULT_STATUS;
  }

  accept(id: string): CandidateStatus {
    return this._set(id, 'accepted');
  }

  reject(id: string): CandidateStatus {
    return this._set(id, 'rejected');
  }

  /** Return a candidate to the pending state, forgetting the decision. */
  reset(id: string): CandidateStatus {
    this._byId.delete(id);
    return DEFAULT_STATUS;
  }

  /** Every recorded decision, for persistence. Pending candidates are absent. */
  decisions(): ReadonlyMap<string, CandidateStatus> {
    return new Map(this._byId);
  }

  /** Reload recorded decisions (e.g. from a restored session). Replaces all. */
  restore(decisions: Iterable<readonly [string, CandidateStatus]>): void {
    this._byId.clear();
    for (const [id, status] of decisions) {
      // Never store the default: it is the absence of a decision, and storing it
      // would make an untouched candidate indistinguishable from a reset one.
      if (status !== DEFAULT_STATUS) this._byId.set(id, status);
    }
  }

  /** Drop every decision. */
  clear(): void {
    this._byId.clear();
  }

  /**
   * Join the standing decisions onto a FRESH extraction, in the extraction's own
   * order. This is the call a re-run makes: candidates are new objects, the
   * judgments are the store's, and they meet by id.
   */
  apply<T extends { readonly id: string }>(candidates: readonly T[]): ReviewedCandidate<T>[] {
    return candidates.map((candidate) => ({ candidate, status: this.statusOf(candidate.id) }));
  }

  /** Only the candidates a reviewer has accepted — what a deliverable ships. */
  accepted<T extends { readonly id: string }>(candidates: readonly T[]): T[] {
    return candidates.filter((c) => this.statusOf(c.id) === 'accepted');
  }

  /** Counts over a candidate set, for a header or an export gate. */
  summarise<T extends { readonly id: string }>(candidates: readonly T[]): ReviewSummary {
    let accepted = 0;
    let rejected = 0;
    for (const c of candidates) {
      const s = this.statusOf(c.id);
      if (s === 'accepted') accepted++;
      else if (s === 'rejected') rejected++;
    }
    const total = candidates.length;
    const pending = total - accepted - rejected;
    return { total, accepted, rejected, pending, complete: pending === 0 };
  }

  private _set(id: string, status: CandidateStatus): CandidateStatus {
    this._byId.set(id, status);
    return status;
  }
}
