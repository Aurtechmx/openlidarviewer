/**
 * render.ts
 *
 * Markdown, CSV and HTML for the two suites.
 *
 * WHY THE RENDERERS ARE PURE FUNCTIONS OF THE PUBLISHED JSON. `benchmark:verify`
 * checks that the Markdown a reader quotes says the same thing as `summary.json`
 * and that `runs.csv` says the same thing as `raw.json`. It does that by
 * re-rendering from the JSON and comparing the whole string, which is only a
 * meaningful check if rendering is deterministic and depends on nothing else —
 * no clock, no environment, no run state. So these take JSON in and return a
 * string, and every number they print goes through {@link formatFixed}, the one
 * rounding step in the system. Nothing is rounded before hashing or before a
 * summary is computed; rounding happens here, at the last possible moment, where
 * it cannot propagate into a comparison.
 *
 * WHY UNAVAILABLE IS SPELLED OUT. A blank cell in a table reads as zero, or as
 * an oversight. Every cell with no number says `unavailable` and the reason is
 * carried in the JSON the table points at.
 */

import { UNAVAILABLE_LABEL } from '../framework';
import type { SeriesSummary } from './stats';
import type { SummarisedSeries } from './summarise';
import type { ReproducibilityRaw, ReproducibilitySummary } from './reproducibility';
import type { ScalingRaw, ScalingSummary, ScalingTierSummary } from './scaling';
import {
  SERIES_ANALYSIS_MS,
  SERIES_PEAK_RSS_BYTES,
  SERIES_PIPELINE_TOTAL_MS,
  SERIES_POINTS_PER_SECOND,
} from './series';

/** Decimal places per kind of quantity. One place, so two renderers cannot differ. */
export const MS_DECIMALS = 3;
export const RATE_DECIMALS = 1;
export const MIB_DECIMALS = 2;
export const RATIO_DECIMALS = 6;

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Fixed-point formatting, or the unavailable label for a null.
 *
 * `toFixed` rather than a locale formatter: a locale would put a thousands
 * separator or a comma decimal point into a file another tool parses, and the
 * separator would depend on the machine that rendered it.
 */
export function formatFixed(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_LABEL;
  return value.toFixed(decimals);
}

export function formatInteger(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_LABEL;
  return String(Math.trunc(value));
}

export function formatMib(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return UNAVAILABLE_LABEL;
  return (bytes / BYTES_PER_MIB).toFixed(MIB_DECIMALS);
}

function findSeries(series: SummarisedSeries, key: string): SeriesSummary | null {
  return series.available.find((b) => b.key === key)?.summary ?? null;
}

/** A CSV field. Quotes only when it must, and doubles embedded quotes. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/** Markdown table cell — a pipe would split the row into two columns. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function statsRow(label: string, s: SeriesSummary, decimals: number): string {
  return `| ${cell(label)} | ${s.count} | ${formatFixed(s.min, decimals)} | ${formatFixed(s.median, decimals)} | ${formatFixed(s.max, decimals)} | ${formatFixed(s.mean, decimals)} | ${formatFixed(s.stdDev, decimals)} | ${formatFixed(s.iqr, decimals)} | ${formatFixed(s.cv, RATIO_DECIMALS)} |`;
}

const STATS_HEADER = [
  '| series | n | min | median | max | mean | sd | IQR | CV |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
];

/** Milliseconds for a duration series, MiB for the memory one, rate otherwise. */
function decimalsFor(key: string): number {
  if (key === SERIES_POINTS_PER_SECOND) return RATE_DECIMALS;
  if (key === SERIES_PEAK_RSS_BYTES) return 0;
  return MS_DECIMALS;
}

// ── reproducibility ─────────────────────────────────────────────────────────

export function reproducibilityMarkdown(summary: ReproducibilitySummary): string {
  const lines: string[] = [];
  lines.push('# Benchmark 1 — deterministic reproducibility');
  lines.push('');
  lines.push(`Verdict: **${summary.pass ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(`- dataset: \`${cell(summary.datasetId)}\``);
  lines.push(`- seed: ${summary.config.seed}`);
  lines.push(`- points: ${summary.config.pointCount}`);
  lines.push(`- warm-up runs: ${summary.config.warmupRuns}`);
  lines.push(`- recorded runs: ${summary.runCount} of ${summary.config.recordedRuns} configured`);
  lines.push(`- cell size: ${summary.config.terrain.cellSizeM} m, CRS ${cell(summary.config.terrain.crs)}, vertical datum ${cell(summary.config.terrain.verticalDatum)}`);
  lines.push(`- scalar comparison tolerance: ${summary.config.scalarTolerance} (exact equality)`);
  lines.push(`- quantile convention: ${cell(summary.quantileConvention)}`);
  lines.push('');

  lines.push('## Scientific identity');
  lines.push('');
  lines.push(`- science-scoped hashes identical across all runs: ${summary.identity.scienceHashesStable ? 'yes' : 'no'}`);
  lines.push(`- scalar outputs identical across all runs: ${summary.identity.scalarsStable ? 'yes' : 'no'}`);
  lines.push(`- processing manifest verified on every run: ${summary.identity.manifestVerifiedOnEveryRun ? 'yes' : 'no'}`);
  lines.push(`- application content hash: \`${cell(summary.identity.applicationContentHash ?? UNAVAILABLE_LABEL)}\``);
  lines.push('');
  lines.push('| artifact | scope | sha256 |');
  lines.push('| --- | --- | --- |');
  for (const [name, hash] of Object.entries(summary.identity.referenceScienceHashes).sort()) {
    lines.push(`| ${cell(name)} | science | \`${cell(hash)}\` |`);
  }
  for (const [name, hash] of Object.entries(summary.identity.referenceBuildScopedHashes).sort()) {
    lines.push(`| ${cell(name)} | build | \`${cell(hash)}\` |`);
  }
  lines.push('');
  lines.push(
    'Build-scoped hashes track the git commit and the Node version of the machine that ran the suite. ' +
      'They are reported here and are NOT part of the pass condition: two machines are expected to differ, ' +
      'and that difference says nothing about whether the science reproduced.',
  );
  lines.push(
    `Within this process they were ${summary.identity.buildScopedHashesStableInThisProcess ? 'stable' : 'NOT stable'}.`,
  );
  lines.push('');

  lines.push('## Timing');
  lines.push('');
  lines.push('Durations in milliseconds, peak RSS in bytes, throughput in points/s. CV is dimensionless.');
  lines.push('');
  lines.push(...STATS_HEADER);
  for (const block of summary.timing.available) {
    lines.push(statsRow(block.key, block.summary, decimalsFor(block.key)));
  }
  lines.push('');
  if (summary.timing.unavailable.length > 0) {
    lines.push('Series with no summary:');
    lines.push('');
    for (const u of summary.timing.unavailable) {
      lines.push(`- \`${cell(u.key)}\`: ${cell(u.reason)}`);
    }
    lines.push('');
  }
  lines.push('Series meanings:');
  lines.push('');
  for (const block of summary.timing.available) {
    lines.push(`- \`${cell(block.key)}\`: ${cell(block.meaning)}`);
  }
  lines.push('');

  lines.push('## Failures');
  lines.push('');
  if (summary.failures.length === 0) lines.push('None.');
  else for (const f of summary.failures) lines.push(`- ${cell(f)}`);
  lines.push('');
  return lines.join('\n');
}

/** One row per recorded run. Row count is checked against `raw.json`. */
export function reproducibilityCsv(raw: ReproducibilityRaw): string {
  const header = [
    'run',
    'datasetId',
    'seed',
    'requestedPointCount',
    'generatedPointCount',
    'generateMs',
    'rasterizeIsolatedMs',
    'dtmMs',
    'descriptorsIsolatedMs',
    'contoursMs',
    'scientificRecordMs',
    'manifestMs',
    'analysisMs',
    'pipelineTotalMs',
    'pointsPerSecond',
    'startRssBytes',
    'endRssBytes',
    'startHeapUsedBytes',
    'endHeapUsedBytes',
    'peakRssBytes',
    'peakHeapBytes',
    'forcedGcAvailable',
    'gridCols',
    'gridRows',
    'gridCellCount',
    'contourPolylineCount',
    'qualityScore',
    'meanConfidence',
    'manifestVerified',
    'applicationContentHash',
    'failedStages',
  ];
  const rows = raw.runs.map((run) => {
    const o = run.observation;
    const d = o.durations;
    return csvRow([
      String(run.index),
      o.datasetId,
      String(o.seed),
      String(o.requestedPointCount),
      formatInteger(o.generatedPointCount),
      formatFixed(d.generateMs, MS_DECIMALS),
      formatFixed(d.rasterizeIsolatedMs, MS_DECIMALS),
      formatFixed(d.dtmMs, MS_DECIMALS),
      formatFixed(d.descriptorsIsolatedMs, MS_DECIMALS),
      formatFixed(d.contoursMs, MS_DECIMALS),
      formatFixed(d.scientificRecordMs, MS_DECIMALS),
      formatFixed(d.manifestMs, MS_DECIMALS),
      formatFixed(d.analysisMs, MS_DECIMALS),
      formatFixed(d.pipelineTotalMs, MS_DECIMALS),
      formatFixed(d.pointsPerSecond, RATE_DECIMALS),
      formatInteger(o.memory.startRssBytes),
      formatInteger(o.memory.endRssBytes),
      formatInteger(o.memory.startHeapUsedBytes),
      formatInteger(o.memory.endHeapUsedBytes),
      formatInteger(o.memory.peakRssBytes),
      formatInteger(o.memory.peakHeapBytes),
      String(o.memory.forcedGcAvailable),
      formatInteger(o.scalars.gridCols),
      formatInteger(o.scalars.gridRows),
      formatInteger(o.scalars.gridCellCount),
      formatInteger(o.scalars.contourPolylineCount),
      formatFixed(o.scalars.qualityScore, RATE_DECIMALS),
      formatFixed(o.scalars.meanConfidence, RATIO_DECIMALS),
      String(o.manifestVerified),
      o.scalars.applicationContentHash ?? UNAVAILABLE_LABEL,
      o.failedStages.map((f) => `${f.name}: ${f.error}`).join('; '),
    ]);
  });
  return [csvRow(header), ...rows].join('\n') + '\n';
}

// ── scaling ─────────────────────────────────────────────────────────────────

/** The compact table: one row per tier, principal metrics only. */
export function scalingTable(summary: ScalingSummary): string[] {
  const lines = [
    '| tier | points | median analysis (ms) | median pipeline total (ms) | median points/s | peak RSS (MiB) | grid cells | contours | CV analysis |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const tier of summary.tiers) {
    const analysis = findSeries(tier.series, SERIES_ANALYSIS_MS);
    const total = findSeries(tier.series, SERIES_PIPELINE_TOTAL_MS);
    const rate = findSeries(tier.series, SERIES_POINTS_PER_SECOND);
    const rss = findSeries(tier.series, SERIES_PEAK_RSS_BYTES);
    lines.push(
      `| ${cell(tier.id)} | ${tier.requestedPointCount} | ` +
        `${analysis ? formatFixed(analysis.median, MS_DECIMALS) : UNAVAILABLE_LABEL} | ` +
        `${total ? formatFixed(total.median, MS_DECIMALS) : UNAVAILABLE_LABEL} | ` +
        `${rate ? formatFixed(rate.median, RATE_DECIMALS) : UNAVAILABLE_LABEL} | ` +
        `${rss ? formatMib(rss.max) : UNAVAILABLE_LABEL} | ` +
        `${formatInteger(tier.gridCellCount)} | ${formatInteger(tier.contourCount)} | ` +
        `${analysis ? formatFixed(analysis.cv, RATIO_DECIMALS) : UNAVAILABLE_LABEL} |`,
    );
  }
  return lines;
}

function tierDetail(tier: ScalingTierSummary): string[] {
  const lines: string[] = [];
  lines.push(`### ${cell(tier.id)} — ${tier.requestedPointCount} points`);
  lines.push('');
  lines.push(`- status: ${tier.status}`);
  if (tier.failureReason !== null) {
    lines.push(`- failure reason: ${cell(tier.failureReason)}`);
    lines.push(`- failure deliberately accepted in configuration: ${tier.failureAccepted ? 'yes' : 'no'}`);
  }
  lines.push(`- recorded runs: ${tier.runCount}`);
  lines.push(`- generated points: ${formatInteger(tier.generatedPointCount)}`);
  lines.push(`- grid: ${formatInteger(tier.gridCols)} x ${formatInteger(tier.gridRows)} = ${formatInteger(tier.gridCellCount)} cells`);
  lines.push(`- contours: ${formatInteger(tier.contourCount)}`);
  lines.push(`- quality score: ${formatFixed(tier.qualityScore, RATE_DECIMALS)}`);
  lines.push(`- mean confidence: ${formatFixed(tier.meanConfidence, RATIO_DECIMALS)}`);
  lines.push(`- science hashes stable within tier: ${tier.scienceHashesStableWithinTier ? 'yes' : 'no'}`);
  lines.push(`- forced GC available: ${tier.forcedGcAvailable ? 'yes' : 'no'}`);
  lines.push('');
  if (tier.series.available.length > 0) {
    lines.push(...STATS_HEADER);
    for (const block of tier.series.available) {
      lines.push(statsRow(block.key, block.summary, decimalsFor(block.key)));
    }
    lines.push('');
  }
  if (tier.series.unavailable.length > 0) {
    lines.push('Series with no summary:');
    lines.push('');
    for (const u of tier.series.unavailable) lines.push(`- \`${cell(u.key)}\`: ${cell(u.reason)}`);
    lines.push('');
  }
  return lines;
}

export function scalingMarkdown(summary: ScalingSummary): string {
  const lines: string[] = [];
  lines.push('# Benchmark 2 — synthetic scaling');
  lines.push('');
  lines.push(`Verdict: **${summary.pass ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(`- seed: ${summary.config.seed}`);
  lines.push(`- warm-up runs per tier: ${summary.config.warmupRuns}`);
  lines.push(`- recorded runs per tier: ${summary.config.recordedRuns}`);
  lines.push(`- cell size: ${summary.config.terrain.cellSizeM} m, CRS ${cell(summary.config.terrain.crs)}`);
  lines.push(`- quantile convention: ${cell(summary.quantileConvention)}`);
  lines.push('');
  lines.push(
    'Peak RSS is the largest stage-boundary reading observed in the tier, not a mid-stage high-water mark. ' +
      'Pipeline total excludes the isolated rasterize and descriptor leaves, which re-run work the DTM stage ' +
      'already does; adding them would double-count. No complexity class is claimed — this is a measured curve.',
  );
  lines.push('');
  lines.push(...scalingTable(summary));
  lines.push('');
  lines.push('## Per-tier detail');
  lines.push('');
  for (const tier of summary.tiers) lines.push(...tierDetail(tier));
  lines.push('## Failures');
  lines.push('');
  if (summary.failures.length === 0) lines.push('None.');
  else for (const f of summary.failures) lines.push(`- ${cell(f)}`);
  lines.push('');
  return lines.join('\n');
}

/** One row per tier-run. Row count is checked against `raw.json`. */
export function scalingCsv(raw: ScalingRaw): string {
  const header = [
    'tier',
    'requestedPointCount',
    'generatedPointCount',
    'run',
    'tierStatus',
    'generateMs',
    'rasterizeIsolatedMs',
    'dtmMs',
    'descriptorsIsolatedMs',
    'contoursMs',
    'scientificRecordMs',
    'manifestMs',
    'analysisMs',
    'pipelineTotalMs',
    'pointsPerSecond',
    'startRssBytes',
    'endRssBytes',
    'startHeapUsedBytes',
    'endHeapUsedBytes',
    'peakRssBytes',
    'peakHeapBytes',
    'forcedGcAvailable',
    'gridCols',
    'gridRows',
    'gridCellCount',
    'contourPolylineCount',
    'qualityScore',
    'meanConfidence',
    'manifestVerified',
    'failedStages',
  ];
  const rows: string[] = [];
  for (const tier of raw.tiers) {
    for (const run of tier.runs) {
      const o = run.observation;
      const d = o.durations;
      rows.push(
        csvRow([
          tier.tier.id,
          String(tier.tier.pointCount),
          formatInteger(o.generatedPointCount),
          String(run.index),
          tier.status,
          formatFixed(d.generateMs, MS_DECIMALS),
          formatFixed(d.rasterizeIsolatedMs, MS_DECIMALS),
          formatFixed(d.dtmMs, MS_DECIMALS),
          formatFixed(d.descriptorsIsolatedMs, MS_DECIMALS),
          formatFixed(d.contoursMs, MS_DECIMALS),
          formatFixed(d.scientificRecordMs, MS_DECIMALS),
          formatFixed(d.manifestMs, MS_DECIMALS),
          formatFixed(d.analysisMs, MS_DECIMALS),
          formatFixed(d.pipelineTotalMs, MS_DECIMALS),
          formatFixed(d.pointsPerSecond, RATE_DECIMALS),
          formatInteger(o.memory.startRssBytes),
          formatInteger(o.memory.endRssBytes),
          formatInteger(o.memory.startHeapUsedBytes),
          formatInteger(o.memory.endHeapUsedBytes),
          formatInteger(o.memory.peakRssBytes),
          formatInteger(o.memory.peakHeapBytes),
          String(o.memory.forcedGcAvailable),
          formatInteger(o.scalars.gridCols),
          formatInteger(o.scalars.gridRows),
          formatInteger(o.scalars.gridCellCount),
          formatInteger(o.scalars.contourPolylineCount),
          formatFixed(o.scalars.qualityScore, RATE_DECIMALS),
          formatFixed(o.scalars.meanConfidence, RATIO_DECIMALS),
          String(o.manifestVerified),
          o.failedStages.map((f) => `${f.name}: ${f.error}`).join('; '),
        ]),
      );
    }
  }
  return [csvRow(header), ...rows].join('\n') + '\n';
}

// ── the run overview ────────────────────────────────────────────────────────

export interface OverviewInput {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly command: string;
  readonly olvVersion: string;
  readonly benchmarkPackageVersion: string;
  readonly commit: string;
  readonly workingTreeClean: boolean | null;
  readonly reproducibility: ReproducibilitySummary | null;
  readonly scaling: ScalingSummary | null;
  /** Suites that were deliberately not run here, with the reason. */
  readonly notRun: readonly { readonly suiteId: string; readonly reason: string }[];
}

export function overviewMarkdown(input: OverviewInput): string {
  const lines: string[] = [];
  lines.push('# OpenLiDARViewer benchmark results');
  lines.push('');
  lines.push(`- command: \`${cell(input.command)}\``);
  lines.push(`- OLV version: ${cell(input.olvVersion)}`);
  lines.push(`- benchmark package version: ${cell(input.benchmarkPackageVersion)}`);
  lines.push(`- commit: \`${cell(input.commit)}\``);
  lines.push(
    `- working tree: ${input.workingTreeClean === null ? UNAVAILABLE_LABEL : input.workingTreeClean ? 'clean' : 'dirty'}`,
  );
  lines.push(`- started (UTC): ${cell(input.startedAt)}`);
  lines.push(`- completed (UTC): ${cell(input.completedAt)}`);
  lines.push('');
  lines.push('| suite | verdict | detail |');
  lines.push('| --- | --- | --- |');
  if (input.reproducibility) {
    lines.push(
      `| reproducibility | ${input.reproducibility.pass ? 'PASS' : 'FAIL'} | ${input.reproducibility.runCount} runs over ${input.reproducibility.config.pointCount} points, seed ${input.reproducibility.config.seed} |`,
    );
  }
  if (input.scaling) {
    const ok = input.scaling.tiers.filter((t) => t.status === 'ok').length;
    lines.push(
      `| scaling | ${input.scaling.pass ? 'PASS' : 'FAIL'} | ${ok} of ${input.scaling.tiers.length} tiers complete |`,
    );
  }
  for (const suite of input.notRun) {
    lines.push(`| ${cell(suite.suiteId)} | not run | ${cell(suite.reason)} |`);
  }
  lines.push('');
  if (input.scaling) {
    lines.push('## Scaling');
    lines.push('');
    lines.push(...scalingTable(input.scaling));
    lines.push('');
  }
  if (input.reproducibility) {
    lines.push('## Reproducibility');
    lines.push('');
    lines.push(`- science-scoped hashes identical across all runs: ${input.reproducibility.identity.scienceHashesStable ? 'yes' : 'no'}`);
    lines.push(`- scalar outputs identical across all runs: ${input.reproducibility.identity.scalarsStable ? 'yes' : 'no'}`);
    lines.push(`- manifest verified on every run: ${input.reproducibility.identity.manifestVerifiedOnEveryRun ? 'yes' : 'no'}`);
    lines.push('');
  }
  lines.push('Every number here is derived from the raw result files in this directory. Nothing is hand-entered.');
  lines.push('');
  return lines.join('\n');
}

/** Escape for HTML text content, including quotes for attribute safety. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The overview as a single self-contained page.
 *
 * Deliberately plain: this is evidence, not a dashboard, and a page that pulls
 * a chart library from a CDN stops rendering the day the CDN changes — which is
 * the opposite of what an archived result should do.
 */
export function overviewHtml(input: OverviewInput): string {
  const markdown = overviewMarkdown(input);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>OpenLiDARViewer benchmark results</title>',
    '<style>',
    'body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}',
    'pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:1rem;border-radius:6px}',
    '@media (prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#1c1c1c}}',
    '</style>',
    '</head>',
    '<body>',
    `<pre>${esc(markdown)}</pre>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
