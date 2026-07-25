/**
 * markdown.ts
 *
 * The human-readable report — what gets pasted into a release note, a pull
 * request, or a paper's supplementary material.
 *
 * Every cell that could hold a measurement holds either a number with its unit
 * or the words `unavailable — <reason>`. Markdown makes the tempting shortcut
 * especially cheap here (an empty cell still renders as a tidy table), which is
 * exactly why the reason is spelled out in the cell rather than relegated to a
 * footnote a reader can skip.
 *
 * Pipes in any interpolated string are escaped: an unescaped `|` in a reason
 * would silently split the row into an extra column and shift every value one
 * cell to the left — a corruption that still looks like a valid table.
 */

import type { RunReport } from '../types';
import { describeHashExclusions, formatEnvValue, formatMetric } from './metricText';

/** Escape the only character that can restructure a Markdown table. */
function md(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${header.map(md).join(' | ')} |`;
  const rule = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(md).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function toMarkdown(report: RunReport): string {
  const out: string[] = [];

  out.push(`# Benchmark run — ${md(report.suiteId)}`);
  out.push('');
  out.push(
    table(
      ['field', 'value'],
      [
        ['suite', report.suiteId],
        ['dataset', report.datasetId],
        ['schema version', String(report.schemaVersion)],
        ['release version', formatEnvValue(report.environment.releaseVersion)],
        ['git commit', formatEnvValue(report.environment.gitCommitShort)],
        ['git commit (full)', formatEnvValue(report.environment.gitCommitFull)],
        ['OS', formatEnvValue(report.environment.os)],
        ['CPU', formatEnvValue(report.environment.cpuModel)],
        ['arch', formatEnvValue(report.environment.arch)],
        ['Node', formatEnvValue(report.environment.nodeVersion)],
      ],
    ),
  );

  out.push('');
  out.push('## Stages');
  out.push('');
  out.push(
    table(
      ['stage', 'status', 'duration', 'peak RSS', 'error'],
      report.stages.map((s) => [
        s.name,
        s.status,
        formatMetric(s.duration),
        formatMetric(s.peakMemory),
        s.error ?? '',
      ]),
    ),
  );

  out.push('');
  out.push('## Metrics');
  out.push('');
  const metrics = Object.entries(report.metrics);
  out.push(
    metrics.length === 0
      ? '_This run reported no suite-level metrics._'
      : table(
          ['metric', 'value', 'runtime', 'deterministic'],
          metrics.map(([name, m]) => [
            name,
            formatMetric(m),
            m.runtime,
            String(m.deterministic),
          ]),
        ),
  );

  out.push('');
  out.push('## Artifacts');
  out.push('');
  out.push(
    report.artifacts.length === 0
      ? '_This run produced no hashed artifacts._'
      : table(
          ['artifact', 'algorithm', 'hash', 'bytes', 'excluded from hash'],
          report.artifacts.map((a) => [
            a.name,
            a.algorithm,
            a.hash,
            String(a.byteLength),
            describeHashExclusions(a),
          ]),
        ),
  );

  out.push('');
  return `${out.join('\n')}\n`;
}
