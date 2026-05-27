/**
 * streamingStressReport.test.ts — v0.3.3 stress reporter.
 *
 * Opt-in benchmark-report emitter for the stress harness. Reuses the
 * same `runStressTier` the in-CI harness uses, runs across every tier
 * named in `OPENLIDARVIEWER_STRESS_REPORT_TIERS` (default: empty → does
 * nothing in CI), and prints a markdown table block ready to paste into
 * `docs/benchmarks.md`.
 *
 * Usage:
 *
 *   OPENLIDARVIEWER_STRESS_REPORT_TIERS="1M,10M,100M,250M,500M,1B" \
 *     npx vitest run tests/streamingStressReport.test.ts \
 *     --reporter=basic 2>/dev/null
 *
 * The report is printed to stdout; pipe to a file if you want to commit
 * the raw output. The numbers measure scheduler / cache / eviction
 * behaviour with synthetic COPC fixtures + an instant fake decoder, NOT
 * real laz-perf decode throughput — `docs/benchmarks.md` records this
 * assumption explicitly alongside the table.
 *
 * Why a test file and not a standalone script: the project doesn't ship
 * tsx / vite-node, so vitest's loader is the easiest way to run TS code
 * from Node without adding a dev dependency. The test is opt-in (env-
 * gated) so it never fires in default CI runs.
 */

import { test } from 'vitest';
import { runStressTier } from './streamingStressHarness.test';
import { STRESS_TIERS, type StressTier } from './fixtures/copc/scaledSynthCopc';

function tiersFromEnv(): StressTier[] {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env?.OPENLIDARVIEWER_STRESS_REPORT_TIERS;
  if (!fromEnv) return [];
  const out: StressTier[] = [];
  for (const name of fromEnv.split(',')) {
    const t = name.trim() as StressTier;
    if (t in STRESS_TIERS) out.push(t);
  }
  return out;
}

const fmt = (n: number, d = 2): string => n.toFixed(d);
const mb = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MB`;
const pts = (n: number): string => n.toLocaleString('en-US');

const tiers = tiersFromEnv();
if (tiers.length > 0) {
  test('stress benchmark report (markdown)', async () => {
    // Stash and replace console.log so the markdown table is the only
    // thing on stdout — vitest's reporter chatter goes to stderr.
    const lines: string[] = [];
    lines.push('');
    lines.push(
      '| Tier | Source points | Peak resident | Peak GPU est. | Tick mean | Tick p95 | Thrash | Wall time |',
    );
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const tier of tiers) {
      const wall0 = (
        globalThis as { performance?: { now: () => number } }
      ).performance!.now();
      const { result } = await runStressTier(tier);
      const wall =
        (globalThis as { performance?: { now: () => number } }).performance!.now() - wall0;
      const row = [
        `**${tier}**`,
        pts(STRESS_TIERS[tier]),
        pts(result.peakResidentPoints),
        mb(result.peakResidentBytes),
        `${fmt(result.schedulerTickMs.mean)} ms`,
        `${fmt(result.schedulerTickMs.p95)} ms`,
        `${result.thrashEvents}`,
        `${fmt(wall / 1000)} s`,
      ];
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 300_000);
}
