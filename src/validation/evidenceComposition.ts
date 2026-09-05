/**
 * evidenceComposition.ts
 *
 * WHICH claim governs an artifact that contains more than one product.
 *
 * The register already says a contour "depends on DTM validity", and it scopes
 * the CONTOURS cross-implementation to `olv.contour.analytical`. Neither
 * constraint was reachable from code: every export resolved its evidence under
 * ONE claim id, so a deliverable bundle holding a DTM (E4, required E5 — below
 * its bar) alongside contours (E4, required E4 — at its bar) could stamp the
 * contour verdict and read as a validated export. A reader cannot see that the
 * surface underneath it never met its own requirement.
 *
 * An artifact's evidence is the evidence of its WEAKEST constituent. Not the
 * lowest level — the least favourable GATE, which is a different ordering: a
 * product at E4 needing E5 is worse off than a product at E4 needing E4, and
 * worse off than one at E2 needing E2. What a reader may claim is bounded by
 * whichever part of the artifact they may claim least about.
 *
 * This never promotes. Composing a single claim returns that claim unchanged,
 * so a path that names one product is byte-identical to before.
 *
 * Pure data, deterministic. No DOM, no I/O.
 */

import { exportGate, EVIDENCE_REGISTRY } from './evidenceRegistry';
import { evidenceRank } from './evidenceLevel';

/**
 * Gate severity, worst first. An unregistered or not-exportable claim outranks
 * everything: it is the strongest reason to withhold a validated label.
 */
function gateSeverity(claimId: string): number {
  const d = exportGate(claimId);
  if (!d.allowed && d.exploratoryOnly && EVIDENCE_REGISTRY[claimId] == null) return 3; // unregistered
  if (!d.allowed && !d.exploratoryOnly) return 3; // refused outright
  if (d.exploratoryOnly) return 2;
  return 1; // meets its required level
}

/**
 * The shortfall between what a claim has and what it needs, in ranks. Positive
 * when the claim is below its bar. Used to separate two exploratory
 * constituents: E2-needing-E4 is a wider gap than E4-needing-E5, and the wider
 * gap is what a reader must be told about.
 */
function shortfall(claimId: string): number {
  const e = EVIDENCE_REGISTRY[claimId];
  if (e == null) return Number.POSITIVE_INFINITY;
  return evidenceRank(e.required) - evidenceRank(e.current);
}

/** Current level rank, or -1 for an unregistered claim. */
function currentRank(claimId: string): number {
  const e = EVIDENCE_REGISTRY[claimId];
  return e == null ? -1 : evidenceRank(e.current);
}

/**
 * The claim that governs an artifact composed of `claimIds` — the constituent a
 * reader may claim least about.
 *
 * Ordered by gate severity, then by how far the claim falls short of its own
 * requirement, then by the lower current level, then by id so the choice is
 * deterministic for a tie (two constituents that are equally weak give the same
 * verdict either way; determinism keeps the stamp reproducible).
 *
 * Throws on an empty set rather than inventing a default: an artifact with no
 * declared constituents is a wiring bug, and the old silent `'DTM'` default is
 * exactly the bug this module exists to close.
 */
export function governingClaim(claimIds: readonly string[]): string {
  if (claimIds.length === 0) {
    throw new Error('governingClaim: no constituent claims — an artifact must declare what it contains');
  }
  const unique = [...new Set(claimIds)];
  let best = unique[0];
  for (const id of unique.slice(1)) {
    const [sa, sb] = [gateSeverity(id), gateSeverity(best)];
    if (sa !== sb) { if (sa > sb) best = id; continue; }
    const [fa, fb] = [shortfall(id), shortfall(best)];
    if (fa !== fb) { if (fa > fb) best = id; continue; }
    const [ra, rb] = [currentRank(id), currentRank(best)];
    if (ra !== rb) { if (ra < rb) best = id; continue; }
    if (id < best) best = id;
  }
  return best;
}

/**
 * The constituents whose gate is worse than the artifact's best part — what a
 * "why is this exploratory?" disclosure names. Empty when every constituent
 * meets its required level.
 */
export function limitingConstituents(claimIds: readonly string[]): string[] {
  return [...new Set(claimIds)].filter((id) => gateSeverity(id) > 1).sort((a, b) => (a < b ? -1 : 1));
}
