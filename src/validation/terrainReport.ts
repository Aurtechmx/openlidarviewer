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

/**
 * Study-level completeness — separate from whether the executed legs passed.
 *
 * A validation universe is a DECLARED set of studies the suite is expected to
 * run. Completeness asks a different question from the pass/fail verdict: did we
 * run everything we declared? A study can be executed (pass / review / fail) or
 * skipped (its fixture or reference was absent, so it did not run at all). The
 * universe is complete only when every declared study was executed — none
 * skipped, none missing entirely.
 *
 * The two must not be conflated. "Everything we ran passed" is not "we ran
 * everything we declared": a suite where every executed study passes but one
 * declared study was skipped is NOT fully validated, and its overall standing is
 * REVIEW, not PASS.
 */
export interface StudyResult {
  readonly id: string;
  readonly status: LegStatus;
}

export interface CompletenessSummary {
  readonly expected: number;
  readonly executed: number;
  readonly passed: number;
  readonly review: number;
  readonly failed: number;
  readonly skipped: number;
  /** True only when every declared study was executed (none skipped or missing). */
  readonly validationUniverseComplete: boolean;
  /** IDs declared but not executed (skipped or absent from the results). */
  readonly missing: readonly string[];
}

/**
 * Summarise a set of study results against the DECLARED universe of study IDs.
 * A study counts as executed when it is present with a non-skipped status; a
 * declared study that is skipped or absent leaves the universe incomplete.
 * `review` here counts studies whose status is neither a clean pass nor a hard
 * fail (mapped from `skipped`? no — skipped is not executed); it is reserved for
 * an explicit review status if the caller supplies one via `fail`-vs-`pass`.
 */
export function summarizeStudies(results: readonly StudyResult[], expected: readonly string[]): CompletenessSummary {
  const byId = new Map(results.map((r) => [r.id, r.status]));
  const status = (id: string): LegStatus | undefined => byId.get(id);
  const executedIds = expected.filter((id) => { const s = status(id); return s === 'pass' || s === 'fail'; });
  const missing = expected.filter((id) => !executedIds.includes(id));
  return {
    expected: expected.length,
    executed: executedIds.length,
    passed: expected.filter((id) => status(id) === 'pass').length,
    // No dedicated review status in LegStatus; a study that ran but is under
    // review is modelled by the caller as a non-pass executed result. Kept 0
    // here unless the vocabulary is extended, so the field stays explicit.
    review: 0,
    failed: expected.filter((id) => status(id) === 'fail').length,
    skipped: expected.filter((id) => status(id) === 'skipped' || status(id) === undefined).length,
    validationUniverseComplete: missing.length === 0,
    missing,
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
