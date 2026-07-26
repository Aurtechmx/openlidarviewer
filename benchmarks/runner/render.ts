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

import { UNAVAILABLE_LABEL, type EnvValue } from '../framework';
import type { ForcedGcObservation } from './gcMode';
import type { FirstRunCheck, SeriesSummary } from './stats';
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

/**
 * Where run 1 sat relative to the rest — the residual warm-up statement.
 *
 * Reported wherever a CV is reported, because the two are inseparable: a
 * coefficient of variation computed over a series that still contains a warm-up
 * transient is not a repeatability figure, and a reader has no way to tell from
 * the number itself.
 */
function firstRunLines(check: FirstRunCheck | null): string[] {
  if (check === null) return ['- first-run warm-up check: unavailable (needs at least three recorded runs)'];
  const ratio = check.ratioToRestMedian;
  const band =
    check.withinRobustBand === null
      ? `no robust band: ${check.bandUnavailableReason ?? 'sample too small'}`
      : `${check.withinRobustBand ? 'inside' : 'OUTSIDE'} the +/-${formatFixed(check.bandHalfWidth, MS_DECIMALS)} ms ` +
        'robust band (max of 3 IQRs and 5 % of the median)';
  return [
    `- first-run warm-up check: run 1 was ${formatFixed(check.firstValue, MS_DECIMALS)} ms against a median of ` +
      `${formatFixed(check.restMedian, MS_DECIMALS)} ms over the remaining ${check.restCount} runs ` +
      `${ratio === null ? '' : `(${formatFixed(ratio, 4)}x) `}— ${band}`,
    // The pair a stability claim has to be quoted from. Printed together so
    // nobody has to compute the difference to notice there is one.
    `- analysis-duration CV including run 1: ${formatFixed(check.cvAllRuns, RATIO_DECIMALS)}; ` +
      `excluding run 1: ${formatFixed(check.cvExcludingFirstRun, RATIO_DECIMALS)}. ` +
      'Quote the second as the repeatability figure and say so; the difference between them is the residual ' +
      'first-run transient, which tracks machine load rather than the pipeline and is therefore reported ' +
      'rather than failed on.',
    `- diagnostics: run 1 within the rest's min-max ${formatFixed(check.restMin, MS_DECIMALS)}-${formatFixed(check.restMax, MS_DECIMALS)} ms: ` +
      `${check.withinRestRange ? 'yes' : 'no'}; within their interquartile range: ${check.withinRestIqr ? 'yes' : 'no'}. ` +
      'Neither is a pass condition: under a stationary process the first is expected to fail about 2/n of the time ' +
      'and the second about half the time, so both would red-light healthy runs.',
  ];
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
  lines.push(`- quantile convention: ${cell(summary.quantileConvention)}, CV is sd/mean`);
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
  lines.push('Durations in milliseconds, peak RSS in bytes, throughput in points/s. CV is sd/mean, dimensionless.');
  lines.push('');
  lines.push(...firstRunLines(summary.warmup));
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
    // The reason travels with the blank: a CSV cell reading 'unavailable' with
    // no explanation is the gap this framework refuses to emit elsewhere.
    'peakHeapUnavailableReason',
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
      o.memory.peakHeapUnavailableReason,
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

/**
 * The caveats that make the table below readable, carried WITH the table.
 *
 * They live here rather than in `scalingMarkdown` because the same table is
 * emitted into the top-level overview, and the version a reader is most likely
 * to copy into a document was the one with none of this attached — a table
 * whose memory column is a max among medians, whose contour count is not
 * comparable across tiers, and which says nothing about the double-counting
 * trap, reads as a scaling law. Hoisting the paragraph means the caveats travel
 * wherever the table is published.
 */
function scalingCaveats(summary: ScalingSummary): string[] {
  const isolation = summary.config.isolation;
  return [
    'Peak RSS is the largest stage-boundary reading of a run, not a mid-stage high-water mark; both the ' +
      'median across runs and the max are given, because they are different estimators and a single ' +
      'column silently switching between them is worse than either. Pipeline total excludes the isolated ' +
      'rasterize and descriptor leaves, which re-run work the DTM stage already does; adding them would ' +
      'double-count. No complexity class is claimed — this is a measured curve.',
    '',
    'Contour count is NOT comparable across tiers and is not a pipeline property. The fixture holds point ' +
      'density constant and scales tile extent as the square root of the point count, and its landform ' +
      'amplitudes are fractions of that extent, so vertical relief grows with the tier. The interval ' +
      'selector therefore chooses a larger interval on the upper rungs, which reduces the number of levels ' +
      'and with it the polyline count. The interval and the relief it was chosen from are both columns ' +
      'here so the effect is visible rather than mysterious.',
    '',
    isolation === 'process-per-tier'
      ? 'Each tier ran in its own process, so runtime warm-up state and heap growth are not confounded with ' +
        'the tier.'
      : 'All tiers ran sequentially in ONE process in ascending order, so runtime warm-up state and heap ' +
        'growth are confounded with the tier; the curve is an artefact of this configuration on this ' +
        'machine and is not attributable to input size.',
  ];
}

/** The compact table: one row per tier, principal metrics only. */
export function scalingTable(summary: ScalingSummary): string[] {
  const lines = [
    ...scalingCaveats(summary),
    '',
    '| tier | points | median analysis (ms) | median pipeline total (ms) | median points/s | peak RSS median (MiB) | peak RSS max (MiB) | grid cells | contour interval (m) | elevation range (m) | contours | CV analysis |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
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
        `${rss ? formatMib(rss.median) : UNAVAILABLE_LABEL} | ` +
        `${rss ? formatMib(rss.max) : UNAVAILABLE_LABEL} | ` +
        `${formatInteger(tier.gridCellCount)} | ` +
        `${formatFixed(tier.contourIntervalM, 2)} | ` +
        `${formatFixed(tier.elevationRangeM, 2)} | ` +
        `${formatInteger(tier.contourCount)} | ` +
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
  lines.push(`- contours: ${formatInteger(tier.contourCount)} polylines at a ${formatFixed(tier.contourIntervalM, 2)} m interval over ${formatFixed(tier.elevationRangeM, 2)} m of relief`);
  lines.push(`- quality score: ${formatFixed(tier.qualityScore, RATE_DECIMALS)}`);
  lines.push(`- mean confidence: ${formatFixed(tier.meanConfidence, RATIO_DECIMALS)}`);
  lines.push(`- science hashes stable within tier: ${tier.scienceHashesStableWithinTier ? 'yes' : 'no'}`);
  lines.push(`- forced GC available: ${tier.forcedGcAvailable ? 'yes' : 'no'}`);
  lines.push(...firstRunLines(tier.firstRunAnalysisMs));
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
  lines.push(`- tier isolation: ${cell(summary.config.isolation)}`);
  lines.push(`- quantile convention: ${cell(summary.quantileConvention)}, CV is sd/mean`);
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
    // The reason travels with the blank: a CSV cell reading 'unavailable' with
    // no explanation is the gap this framework refuses to emit elsewhere.
    'peakHeapUnavailableReason',
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
          o.memory.peakHeapUnavailableReason,
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
  /**
   * Whether this result set was measured with forced GC, as asked for and as
   * actually observed.
   *
   * On the front page rather than buried in `raw.json` because it is the one
   * fact that decides whether two result trees may be compared at all. Two
   * ladders differing only in this were the whole reason the field exists, and
   * a reader who copies a table out of `summary.md` never opens `raw.json`.
   */
  readonly forcedGc: ForcedGcReport;
}

/** Requested is what someone typed; observed is what the runs actually got. */
export interface ForcedGcReport {
  readonly requested: boolean;
  readonly observedInRuns: ForcedGcObservation;
}

/**
 * The GC line, phrased so the interesting case cannot be skimmed past.
 *
 * "requested but not observed" means the flag did not arrive and the numbers
 * are default-GC numbers wearing the wrong label; it gets the word MISMATCH,
 * because a reader scanning a page of green needs one token to catch on.
 */
function forcedGcLine(report: ForcedGcReport): string {
  const asked = report.requested ? 'requested' : 'not requested';
  const got = report.observedInRuns;
  const mismatch =
    (report.requested && (got === 'none' || got === 'mixed')) ||
    (!report.requested && (got === 'all' || got === 'mixed'));
  return `- forced GC: ${asked}; observed in runs: ${got}${mismatch ? ' — MISMATCH, the recorded runs do not match the mode asked for' : ''}`;
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
  lines.push(forcedGcLine(input.forcedGc));
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
    lines.push(...firstRunLines(input.reproducibility.warmup));
    lines.push('');
  }
  // Deliberately narrow. The earlier wording — "every number here is derived
  // from the raw result files" — was true and still read as a completeness
  // guarantee, which this page is not: it is a summary, the caveats that make
  // each table readable travel with that table, and the per-suite files carry
  // what this one leaves out.
  lines.push(
    'Every number on this page is derived from the raw result files in this directory; none is hand-entered, ' +
      'and `npm run benchmark:verify` re-derives all of them. This page is a summary, not the full record — ' +
      'the per-suite `summary.md` and `raw.json` carry the per-stage statistics, the artifact hashes and the ' +
      'reasons behind every value reported as unavailable.',
  );
  lines.push('');
  return lines.join('\n');
}

/** The manifest fields the overview is rendered from. See {@link overviewInputFrom}. */
export interface OverviewHeader {
  readonly olvVersion: EnvValue;
  readonly commit: EnvValue;
  readonly workingTree: EnvValue;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly command: string;
  readonly notRun: readonly { readonly suiteId: string; readonly reason: string }[];
  readonly forcedGc: ForcedGcReport;
}

/**
 * Build the overview's input from the manifest header and the two summaries.
 *
 * ONE derivation, used by the writer when it publishes and by the verifier when
 * it re-renders. Written as a separate function because the two used to derive
 * it independently — and the verifier simply did not re-render the top-level
 * page at all, so an edit to the headline table passed. Those are the files a
 * figure is copied out of; they now go through exactly the same path as
 * everything else.
 */
export function overviewInputFrom(
  header: OverviewHeader,
  benchmarkPackageVersion: string,
  reproducibility: ReproducibilitySummary | null,
  scaling: ScalingSummary | null,
): OverviewInput {
  return {
    startedAt: header.startedAtUtc,
    completedAt: header.completedAtUtc,
    command: header.command,
    olvVersion: header.olvVersion.status === 'captured' ? header.olvVersion.value : UNAVAILABLE_LABEL,
    benchmarkPackageVersion,
    commit: header.commit.status === 'captured' ? header.commit.value : UNAVAILABLE_LABEL,
    workingTreeClean:
      header.workingTree.status === 'captured' ? header.workingTree.value === 'clean' : null,
    reproducibility,
    scaling,
    notRun: header.notRun,
    forcedGc: header.forcedGc,
  };
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
