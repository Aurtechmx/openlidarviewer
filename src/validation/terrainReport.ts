/**
 * terrainReport.ts — the result schema the terrain-validation harness reports in.
 *
 * The harness runs a set of legs (OLV vs an independent implementation on a real
 * crop, a boundary study, a perturbation study). Each leg produces one
 * `LegResult`; the whole run rolls up to one `TerrainValidationReport` with a
 * single PASS / REVIEW / FAIL verdict a reviewer or a CI gate can read.
 *
 * The rollup is deliberately conservative about coverage. A run only PASSES when
 * every declared leg actually RAN and passed. If a leg was skipped — its
 * reference grid or crop fixture was absent, as on a fresh checkout — the run
 * cannot claim PASS, because nothing proved that leg; it rolls up to REVIEW. A
 * single failing leg forces FAIL regardless of the rest. So the verdict never
 * reads greener than what was actually validated: partial coverage is REVIEW,
 * not PASS, and one red leg is FAIL, not REVIEW.
 *
 * Pure and IO-free: callers build the leg list (the script from a vitest run, a
 * future in-suite reporter from its own results) and this rolls it up and
 * renders it. Validation-only — it lives outside the viewer runtime.
 */

/** How a single leg came out. */
export type LegStatus =
  /** Ran and every assertion held. */
  | 'pass'
  /** Ran and at least one assertion failed. */
  | 'fail'
  /** Could not run — its reference/fixture was absent. Not a failure, not a proof. */
  | 'skipped';

/** The whole run's verdict. */
export type TerrainVerdict =
  /** Every declared leg ran and passed. Full coverage, all green. */
  | 'PASS'
  /** No leg failed, but at least one was skipped — partial coverage. */
  | 'REVIEW'
  /** At least one leg failed. */
  | 'FAIL';

/** One leg of the harness. */
export interface LegResult {
  /** Stable identifier, e.g. `whitesands/scipy-point-in-cell`. */
  readonly id: string;
  /** Human-readable one-line description of what the leg checks. */
  readonly title: string;
  readonly status: LegStatus;
  /** Optional one-line metric summary the leg logged (e.g. `rmse=5.0e-5 cells=9979`). */
  readonly detail?: string;
  /** Optional dataset/study the leg draws on, for the report header. */
  readonly dataset?: string;
}

/** The rolled-up run. */
export interface TerrainValidationReport {
  /** Schema version, so a stored report can be read back safely. */
  readonly schemaVersion: 1;
  /** When the run was stamped (ISO-8601). Set by the caller, not computed here. */
  readonly generatedAt: string;
  readonly verdict: TerrainVerdict;
  readonly legs: readonly LegResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

/**
 * Roll a set of leg statuses up to one verdict.
 *
 * FAIL if any leg failed. Otherwise PASS only when every leg ran and passed —
 * so an empty run or any skipped leg is REVIEW, never PASS. This is the single
 * source of truth for the rule; the `validate:terrain` command mirrors it.
 */
export function rollupVerdict(legs: readonly LegResult[]): TerrainVerdict {
  if (legs.some((l) => l.status === 'fail')) return 'FAIL';
  if (legs.length > 0 && legs.every((l) => l.status === 'pass')) return 'PASS';
  return 'REVIEW';
}

/** Build the full report from a leg list and a caller-supplied timestamp. */
export function buildReport(legs: readonly LegResult[], generatedAt: string): TerrainValidationReport {
  return {
    schemaVersion: 1,
    generatedAt,
    verdict: rollupVerdict(legs),
    legs,
    summary: {
      total: legs.length,
      passed: legs.filter((l) => l.status === 'pass').length,
      failed: legs.filter((l) => l.status === 'fail').length,
      skipped: legs.filter((l) => l.status === 'skipped').length,
    },
  };
}

const MARK: Record<LegStatus, string> = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' };

/** Render the report as fixed-width text for a terminal or a log. */
export function renderReport(report: TerrainValidationReport): string {
  const lines: string[] = [];
  lines.push('Terrain validation — OLV terrain outputs vs independent references');
  lines.push('='.repeat(66));
  for (const leg of report.legs) {
    const head = `  [${MARK[leg.status]}] ${leg.title}`;
    lines.push(leg.detail ? `${head}\n         ${leg.detail}` : head);
  }
  lines.push('-'.repeat(66));
  const s = report.summary;
  lines.push(`  ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.total}`);
  lines.push(`  VERDICT: ${report.verdict}`);
  if (report.verdict === 'REVIEW' && s.skipped > 0) {
    lines.push(`  (REVIEW: ${s.skipped} leg(s) skipped — their reference or crop fixture was absent,`);
    lines.push('   so those checks did not run. Full coverage is required for PASS.)');
  }
  return lines.join('\n');
}
