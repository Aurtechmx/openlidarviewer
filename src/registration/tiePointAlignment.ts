/**
 * tiePointAlignment.ts — the manual tie-point fallback for registration.
 *
 * When automatic ICP has no reliable overlap, the user places matched pairs of
 * points (a feature seen in both clouds). Three well-distributed pairs pin a
 * rigid transform; this solves it with rigidSolve and, crucially, reports the
 * per-tie residual so a mistyped or mis-clicked pair shows up rather than being
 * averaged silently into a plausible-looking fit. It refuses on fewer than three
 * ties or a degenerate (near-collinear) tie set. Pure and deterministic.
 */

import { rigidSolve, type Vec3, type Mat3 } from './rigidSolve';

export interface TiePoint {
  readonly source: Vec3;
  readonly target: Vec3;
  /** Optional label for the pair (surfaced in per-tie diagnostics). */
  readonly label?: string;
}

export interface TiePointResult {
  readonly R: Mat3;
  readonly t: Vec3;
  /** Overall RMS residual across the ties. */
  readonly rmse: number;
  /** Post-fit distance error for each tie, in input order. */
  readonly perTieResidual: readonly number[];
  /** Index of the largest-residual tie, or -1 when there are no ties. */
  readonly worstTie: number;
  readonly n: number;
  readonly ok: boolean;
  readonly reason?: string;
}

const IDENT: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * Solve the rigid transform mapping the tie sources onto the tie targets, and
 * report per-tie residuals. `minTies` (default 3) is the floor for a determined
 * 6-DOF fit.
 */
export function alignTiePoints(ties: readonly TiePoint[], minTies = 3): TiePointResult {
  const n = ties.length;
  const base = { R: IDENT, t: [0, 0, 0] as Vec3, rmse: NaN, perTieResidual: [], worstTie: -1, n };
  if (n < Math.max(3, minTies)) return { ...base, ok: false, reason: 'TOO_FEW_TIES' };

  const fit = rigidSolve(ties.map((p) => p.source), ties.map((p) => p.target));
  if (!fit.ok) return { ...base, ok: false, reason: fit.reason ?? 'DEGENERATE_TIES' };

  // Per-tie residual: |R·source + t − target|.
  const perTieResidual = ties.map((p) => {
    const rx = fit.R[0][0] * p.source[0] + fit.R[0][1] * p.source[1] + fit.R[0][2] * p.source[2] + fit.t[0];
    const ry = fit.R[1][0] * p.source[0] + fit.R[1][1] * p.source[1] + fit.R[1][2] * p.source[2] + fit.t[1];
    const rz = fit.R[2][0] * p.source[0] + fit.R[2][1] * p.source[1] + fit.R[2][2] * p.source[2] + fit.t[2];
    return Math.hypot(rx - p.target[0], ry - p.target[1], rz - p.target[2]);
  });
  let worstTie = 0;
  for (let i = 1; i < n; i++) if (perTieResidual[i] > perTieResidual[worstTie]) worstTie = i;

  return { R: fit.R, t: fit.t, rmse: fit.rmse, perTieResidual, worstTie, n, ok: true };
}
