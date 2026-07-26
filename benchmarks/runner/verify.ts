/**
 * verify.ts
 *
 * `benchmark:verify` — check a published result tree WITHOUT re-running a single
 * measurement.
 *
 * WHY A SEPARATE CHECK AT ALL, when the suites just produced the files. Because
 * by the time anyone cares, the suites did not just produce them: the files have
 * been copied into an archive, attached to a release, quoted in a paper and
 * possibly edited. Every check here answers "is this tree still internally
 * consistent", and every one of them is a check a human editing a summary by
 * hand would fail:
 *
 *   - every required file exists;
 *   - every file's SHA-256 matches the manifest;
 *   - the number of runs in the data matches the number in the configuration;
 *   - every published min, max, median, IQR and CV RECOMPUTES from the raw
 *     values, bit for bit, through the same functions the suites used;
 *   - the Markdown re-renders identically from `summary.json`, so a number in a
 *     table cannot have drifted from the number in the JSON;
 *   - `runs.csv` has exactly one row per recorded run;
 *   - the schemas parse and no principal metric is missing.
 *
 * Recomputation goes through `summariseRuns` and `summariseSeries` — the same
 * code the suites ran. That is deliberate: the check being made is "does the
 * published summary correspond to the published raw data", not "are two
 * independent statistics libraries in agreement". A second implementation would
 * fail on floating-point association order and tell nobody anything.
 *
 * Returns problems rather than throwing, so one invocation reports every fault
 * in the tree instead of the first.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeSha256Hex } from '../framework/node';
import {
  BENCHMARK_SCHEMA_VERSION,
  parseReproducibilityConfig,
  parseScalingConfig,
} from './config';
import {
  overviewHtml,
  overviewInputFrom,
  overviewMarkdown,
  reproducibilityCsv,
  reproducibilityMarkdown,
  scalingCsv,
  scalingMarkdown,
} from './render';
import type { ReproducibilityRaw, ReproducibilitySummary } from './reproducibility';
import { PRINCIPAL_SERIES, type ScalingRaw, type ScalingSummary } from './scaling';
import { firstSummaryDifference } from './stats';
import { summariseRuns, type SummarisedSeries } from './summarise';
import type { BenchmarkManifest } from './writer';

export interface VerifyOutcome {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly problems: readonly string[];
}

function readJson(path: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`${path}: could not be read as JSON — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Compare a re-derived series block against the published one, key by key. */
function checkSeriesBlock(
  label: string,
  published: SummarisedSeries,
  recomputed: SummarisedSeries,
  problems: string[],
): void {
  const publishedKeys = published.available.map((b) => b.key).sort();
  const recomputedKeys = recomputed.available.map((b) => b.key).sort();
  if (publishedKeys.join('|') !== recomputedKeys.join('|')) {
    problems.push(
      `${label}: summarised series do not match the raw data — published [${publishedKeys.join(', ')}], recomputed [${recomputedKeys.join(', ')}]`,
    );
    return;
  }
  for (const block of published.available) {
    const mine = recomputed.available.find((b) => b.key === block.key);
    if (!mine) {
      problems.push(`${label}: series ${block.key} is published but does not recompute from raw`);
      continue;
    }
    // Name the FIELD that differs. Reporting the median unconditionally printed
    // two identical numbers when `min` was the field that had been edited, and
    // an operator reading that concludes the verifier is broken.
    const diff = firstSummaryDifference(block.summary, mine.summary);
    if (diff !== null) {
      problems.push(
        `${label}: series ${block.key} does not recompute from raw — ${diff.key} is published as ${String(diff.published)}, recomputes to ${String(diff.recomputed)}`,
      );
    }
  }
}

function verifyReproducibility(
  dir: string,
  checked: string[],
  problems: string[],
): ReproducibilitySummary | null {
  const rawPath = join(dir, 'raw.json');
  const summaryPath = join(dir, 'summary.json');
  const raw = readJson(rawPath, problems) as ReproducibilityRaw | null;
  const summary = readJson(summaryPath, problems) as ReproducibilitySummary | null;
  if (raw === null || summary === null) return null;

  checked.push('reproducibility/raw.json + summary.json parsed');

  try {
    parseReproducibilityConfig(raw.config);
    parseReproducibilityConfig(summary.config);
    checked.push('reproducibility configuration is valid');
  } catch (err) {
    problems.push(`reproducibility: invalid configuration — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    problems.push(`reproducibility: raw.json schema version ${String(raw.schemaVersion)} is not ${BENCHMARK_SCHEMA_VERSION}`);
  }
  if (raw.runs.length !== raw.config.recordedRuns) {
    problems.push(`reproducibility: raw.json has ${raw.runs.length} runs, configuration says ${raw.config.recordedRuns}`);
  }
  if (summary.runCount !== raw.runs.length) {
    problems.push(`reproducibility: summary reports ${summary.runCount} runs, raw.json has ${raw.runs.length}`);
  }
  if (raw.warmupRunsCompleted !== raw.config.warmupRuns) {
    problems.push(`reproducibility: ${raw.warmupRunsCompleted} warm-up runs completed, configuration says ${raw.config.warmupRuns}`);
  }

  checkSeriesBlock(
    'reproducibility',
    summary.timing,
    summariseRuns(raw.runs.map((r) => r.series), raw.config.recordedRuns),
    problems,
  );
  checked.push('reproducibility summaries recompute from raw values');

  // Identity: the summary's own verdict must follow from the recorded runs, so
  // a summary edited to say PASS over data that diverged is caught here.
  for (const run of raw.runs) {
    for (const [name, hash] of Object.entries(summary.identity.referenceScienceHashes)) {
      if (run.observation.scienceHashes[name] !== hash && summary.identity.scienceHashesStable) {
        problems.push(`reproducibility: run ${run.index} artifact ${name} differs from the reference, but the summary claims the hashes are stable`);
      }
    }
    if (!run.observation.manifestVerified && summary.identity.manifestVerifiedOnEveryRun) {
      problems.push(`reproducibility: run ${run.index} did not verify its manifest, but the summary claims every run did`);
    }
  }
  if (summary.pass && summary.failures.length > 0) {
    problems.push('reproducibility: summary claims a pass while listing failures');
  }
  checked.push('reproducibility identity claims agree with the run records');

  checkText(join(dir, 'summary.md'), reproducibilityMarkdown(summary), 'reproducibility/summary.md', problems, checked);
  const csv = reproducibilityCsv(raw);
  checkText(join(dir, 'runs.csv'), csv, 'reproducibility/runs.csv', problems, checked);
  checkCsvRows(join(dir, 'runs.csv'), raw.runs.length, 'reproducibility/runs.csv', problems, checked);
  return summary;
}

function verifyScaling(dir: string, checked: string[], problems: string[]): ScalingSummary | null {
  const raw = readJson(join(dir, 'raw.json'), problems) as ScalingRaw | null;
  const summary = readJson(join(dir, 'summary.json'), problems) as ScalingSummary | null;
  if (raw === null || summary === null) return null;

  checked.push('scaling/raw.json + summary.json parsed');

  try {
    parseScalingConfig(raw.config);
    parseScalingConfig(summary.config);
    checked.push('scaling configuration is valid');
  } catch (err) {
    problems.push(`scaling: invalid configuration — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    problems.push(`scaling: raw.json schema version ${String(raw.schemaVersion)} is not ${BENCHMARK_SCHEMA_VERSION}`);
  }
  if (raw.tiers.length !== raw.config.tiers.length) {
    problems.push(`scaling: raw.json has ${raw.tiers.length} tiers, configuration lists ${raw.config.tiers.length}`);
  }

  let totalRuns = 0;
  for (const tier of raw.tiers) {
    totalRuns += tier.runs.length;
    const published = summary.tiers.find((t) => t.id === tier.tier.id);
    if (!published) {
      problems.push(`scaling: tier ${tier.tier.id} is in raw.json but not in summary.json`);
      continue;
    }
    if (published.runCount !== tier.runs.length) {
      problems.push(`scaling: tier ${tier.tier.id} summary reports ${published.runCount} runs, raw.json has ${tier.runs.length}`);
    }
    if (tier.status === 'ok' && tier.runs.length !== raw.config.recordedRuns) {
      problems.push(`scaling: tier ${tier.tier.id} is marked ok with ${tier.runs.length} of ${raw.config.recordedRuns} runs`);
    }
    checkSeriesBlock(
      `scaling tier ${tier.tier.id}`,
      published.series,
      summariseRuns(tier.runs.map((r) => r.series), raw.config.recordedRuns),
      problems,
    );
    if (tier.status === 'ok') {
      for (const key of PRINCIPAL_SERIES) {
        if (!published.series.available.some((b) => b.key === key)) {
          problems.push(`scaling: tier ${tier.tier.id} is marked ok but principal metric ${key} has no summary`);
        }
      }
      if (published.gridCellCount === null) {
        problems.push(`scaling: tier ${tier.tier.id} is marked ok but has no grid cell count`);
      }
      if (published.contourCount === null) {
        problems.push(`scaling: tier ${tier.tier.id} is marked ok but has no contour count`);
      }
    }
    if (tier.status === 'failed' && (tier.failureReason ?? '').trim() === '') {
      problems.push(`scaling: tier ${tier.tier.id} failed without a recorded reason`);
    }
  }
  if (summary.pass && summary.failures.length > 0) {
    problems.push('scaling: summary claims a pass while listing failures');
  }
  checked.push('scaling tier records agree with the published summary');

  checkText(join(dir, 'summary.md'), scalingMarkdown(summary), 'scaling/summary.md', problems, checked);
  checkText(join(dir, 'runs.csv'), scalingCsv(raw), 'scaling/runs.csv', problems, checked);
  checkCsvRows(join(dir, 'runs.csv'), totalRuns, 'scaling/runs.csv', problems, checked);
  return summary;
}

/** A rendered file must equal what the JSON re-renders to, byte for byte. */
function checkText(
  path: string,
  expected: string,
  label: string,
  problems: string[],
  checked: string[],
): void {
  if (!existsSync(path)) {
    problems.push(`${label}: missing`);
    return;
  }
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) {
    problems.push(`${label}: does not match what the published JSON renders to — a value was edited or the two are from different runs`);
    return;
  }
  checked.push(`${label} matches the published JSON`);
}

/**
 * Row count, counted the same way a spreadsheet would: data lines, header
 * excluded. The renderers never emit an embedded newline (`stage.ts` collapses
 * multi-line error messages), so line counting is exact here.
 */
function checkCsvRows(
  path: string,
  expected: number,
  label: string,
  problems: string[],
  checked: string[],
): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  const rows = Math.max(0, lines.length - 1);
  if (rows !== expected) {
    problems.push(`${label}: ${rows} data rows, expected ${expected}`);
    return;
  }
  checked.push(`${label} has one row per recorded run`);
}

/** The files a complete tree must contain, relative to the results directory. */
export function requiredFiles(manifest: BenchmarkManifest): readonly string[] {
  const files = ['manifest.json', 'environment.json', 'summary.md', 'summary.html'];
  for (const suite of manifest.suites) {
    if (suite.suiteId === 'reproducibility') {
      files.push(
        'reproducibility/raw.json',
        'reproducibility/runs.csv',
        'reproducibility/summary.json',
        'reproducibility/summary.md',
        'reproducibility/artifacts/science-hashes.json',
      );
    }
    if (suite.suiteId === 'scaling') {
      files.push('scaling/raw.json', 'scaling/runs.csv', 'scaling/summary.json', 'scaling/summary.md');
    }
  }
  return files;
}

/** Fields that must never carry private machine information. */
const PRIVACY_FORBIDDEN = /(?:\/Users\/|\/home\/|C:\\Users\\|\b(?:\d{1,3}\.){3}\d{1,3}\b)/;

export function verifyResultsDir(dir: string): VerifyOutcome {
  const checked: string[] = [];
  const problems: string[] = [];

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, checked, problems: [`${manifestPath}: missing`] };
  }
  const manifest = readJson(manifestPath, problems) as BenchmarkManifest | null;
  if (manifest === null) return { ok: false, checked, problems };

  if (manifest.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    problems.push(`manifest: schema version ${String(manifest.schemaVersion)} is not ${BENCHMARK_SCHEMA_VERSION}`);
  }
  for (const field of ['startedAtUtc', 'completedAtUtc', 'command'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      problems.push(`manifest: ${field} is missing`);
    }
  }
  if (manifest.commit.status === 'captured' && !/^[0-9a-f]{40}$/.test(manifest.commit.value)) {
    problems.push(`manifest: commit is not a 40-character hash`);
  }
  checked.push('manifest header fields are present');

  // Scanned across every published file, not just the manifest. The manifest is
  // where a path was most likely to appear, but `environment.json` carries host
  // capture, `raw.json` carries error messages, and a stage error is exactly
  // the kind of string that arrives with a path embedded in it.
  const scanned = ['manifest.json', ...manifest.files.map((f) => f.path)];
  const leaking: string[] = [];
  for (const relPath of scanned) {
    const full = join(dir, relPath);
    if (!existsSync(full)) continue;
    const match = PRIVACY_FORBIDDEN.exec(readFileSync(full, 'utf8'));
    if (match) leaking.push(`${relPath} (matched ${JSON.stringify(match[0])})`);
  }
  if (leaking.length > 0) {
    problems.push(`published files carry a home-directory path or an IP address: ${leaking.join(', ')}`);
  } else {
    checked.push(`no home-directory path or IP address in any of the ${scanned.length} published files`);
  }

  for (const relPath of requiredFiles(manifest)) {
    if (!existsSync(join(dir, relPath))) problems.push(`${relPath}: required file is missing`);
  }
  checked.push('required files are present');

  for (const entry of manifest.files) {
    const full = join(dir, entry.path);
    if (!existsSync(full)) {
      problems.push(`${entry.path}: listed in the manifest but absent`);
      continue;
    }
    const bytes = readFileSync(full);
    const hash = nodeSha256Hex(bytes);
    if (hash !== entry.sha256) {
      problems.push(`${entry.path}: sha256 ${hash} does not match the manifest's ${entry.sha256}`);
    } else if (bytes.byteLength !== entry.bytes) {
      problems.push(`${entry.path}: ${bytes.byteLength} bytes, manifest says ${entry.bytes}`);
    }
  }
  checked.push(`manifest hashes match all ${manifest.files.length} listed files`);

  const reproSummary = manifest.suites.some((s) => s.suiteId === 'reproducibility')
    ? verifyReproducibility(join(dir, 'reproducibility'), checked, problems)
    : null;
  const scalingSummary = manifest.suites.some((s) => s.suiteId === 'scaling')
    ? verifyScaling(join(dir, 'scaling'), checked, problems)
    : null;

  // The TOP-LEVEL page, re-rendered from the manifest header and the two
  // summaries it points at.
  //
  // This is the file a figure gets copied out of, and it was the one file
  // outside every check: hashed, listed as required, and never re-derived, so
  // an edited headline number with a refreshed digest passed. It goes through
  // the identical path the per-suite Markdown does now.
  const overview = overviewInputFrom(
    {
      olvVersion: manifest.olvVersion,
      commit: manifest.commit,
      workingTree: manifest.workingTree,
      startedAtUtc: manifest.startedAtUtc,
      completedAtUtc: manifest.completedAtUtc,
      command: manifest.command,
      notRun: manifest.notRun,
    },
    manifest.benchmarkPackageVersion,
    reproSummary,
    scalingSummary,
  );
  checkText(join(dir, 'summary.md'), overviewMarkdown(overview), 'summary.md', problems, checked);
  checkText(join(dir, 'summary.html'), overviewHtml(overview), 'summary.html', problems, checked);

  return { ok: problems.length === 0, checked, problems };
}

/**
 * Verify every archived result set under `root/archive/`.
 *
 * Archives are the citable artifacts, so "the latest run verifies" is the
 * weaker of the two claims worth making. Each archive is a complete tree and
 * goes through the identical checks.
 */
export function verifyArchives(root: string): VerifyOutcome {
  const archiveRoot = join(root, 'archive');
  if (!existsSync(archiveRoot)) {
    return { ok: true, checked: ['no archive directory to verify'], problems: [] };
  }
  const checked: string[] = [];
  const problems: string[] = [];
  const entries = readdirSync(archiveRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    const outcome = verifyResultsDir(join(archiveRoot, name));
    checked.push(`archive/${name}: ${outcome.ok ? 'verified' : `${outcome.problems.length} problems`}`);
    for (const p of outcome.problems) problems.push(`archive/${name}: ${p}`);
  }
  if (entries.length === 0) checked.push('archive directory is empty');
  return { ok: problems.length === 0, checked, problems };
}
