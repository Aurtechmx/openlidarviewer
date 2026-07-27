/**
 * runnerOutput.test.ts — the result tree, the manifest, and what the verifier
 * catches.
 *
 * Everything here runs the REAL suites, at a size a unit test can afford: a few
 * thousand points, two recorded runs, one tier. Faking the suite output would
 * have tested the writer against a shape nothing produces.
 *
 * The verifier cases all follow the same pattern — publish a tree, edit one
 * thing a person plausibly would (a median in a summary, a number in a table, a
 * row in a CSV), and require a non-empty problem list. A verifier that passes a
 * doctored tree is worse than no verifier, because it certifies it.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nodeSha256Hex } from '../../benchmarks/framework/node';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ReproducibilityConfig, ScalingConfig } from '../../benchmarks/runner/config';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { runScalingSuite } from '../../benchmarks/runner/scaling';
import { archiveStamp, writeResults } from '../../benchmarks/runner/writer';
import { verifyArchives, verifyResultsDir } from '../../benchmarks/runner/verify';
import {
  overviewMarkdown,
  reproducibilityCsv,
  reproducibilityMarkdown,
  scalingCsv,
  scalingMarkdown,
  scalingTable,
  type OverviewInput,
} from '../../benchmarks/runner/render';
import { summariseForcedGc, type ForcedGcObservation } from '../../benchmarks/runner/gcMode';

const TERRAIN = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', holdoutSeed: 1 };

const TINY_REPRO: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: 4242,
  // Small, but not as small as it could be. At 3k points a run takes ~22 ms and
  // the residual JIT transient is a genuine 6 % of that, so the first-run band
  // check fires for a real reason and the fixture becomes a FAILED result set.
  // 25k runs in under 100 ms and puts ordinary noise well inside the band.
  pointCount: 25_000,
  warmupRuns: 3,
  recordedRuns: 5,
  terrain: TERRAIN,
  scalarTolerance: 0,
};

const TINY_SCALING: ScalingConfig = {
  suiteId: 'scaling',
  seed: 4242,
  tiers: [
    { id: 'tiny', pointCount: 25_000 },
    { id: 'small', pointCount: 50_000 },
  ],
  warmupRuns: 3,
  recordedRuns: 4,
  terrain: TERRAIN,
  acceptedTierFailures: [],
  // Spawning five vitest processes to check that a table renders is not a unit
  // test. The isolated path has its own case below.
  isolation: 'single-process',
};

const START = '2026-07-26T09:30:00.000Z';
const END = '2026-07-26T09:31:00.000Z';

let repro: ReturnType<typeof runReproducibilitySuite>;
let scaling: ReturnType<typeof runScalingSuite>;

beforeAll(() => {
  repro = runReproducibilitySuite(TINY_REPRO);
  scaling = runScalingSuite(TINY_SCALING);
}, 120_000);

/** Publish into a fresh temp tree and return its `latest/` directory. */
function publish(overrides: Partial<Parameters<typeof writeResults>[0]> = {}): {
  root: string;
  latest: string;
  archive: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'olv-bench-'));
  const outcome = writeResults({
    command: 'test',
    startedAtUtc: START,
    completedAtUtc: END,
    reproducibility: repro,
    scaling,
    resultsDir: root,
    // Pinned, never inherited from the ambient environment: left to default,
    // this whole file would assert something different depending on whether the
    // unit suite happened to be launched with BENCHMARK_FORCE_GC set.
    forcedGcRequested: false,
    ...overrides,
  });
  return { root, latest: outcome.latestDir, archive: outcome.archiveDir };
}

describe('the suites themselves', () => {
  test('the reproducibility suite passes and compares exactly', () => {
    expect(repro.summary.failures).toEqual([]);
    expect(repro.summary.pass).toBe(true);
    expect(repro.summary.runCount).toBe(TINY_REPRO.recordedRuns);
    expect(repro.raw.runs).toHaveLength(TINY_REPRO.recordedRuns);
    expect(repro.summary.identity.scienceHashesStable).toBe(true);
    expect(repro.summary.identity.scalarsStable).toBe(true);
    expect(repro.summary.identity.manifestVerifiedOnEveryRun).toBe(true);
    expect(repro.summary.identity.divergences).toEqual([]);
  });

  test('records where run 1 sat relative to the rest', () => {
    const warmup = repro.summary.warmup;
    expect(warmup, 'a five-run suite must produce a first-run check').not.toBeNull();
    expect(warmup?.restCount).toBe(TINY_REPRO.recordedRuns - 1);
    // Four comparison runs is below the threshold for a meaningful band, so it
    // is withheld with a reason rather than computed from too little.
    expect(warmup?.withinRobustBand).toBeNull();
    expect(warmup?.bandUnavailableReason).toMatch(/comparison runs/);
    // The dispersion pair is published regardless: it is what a stability claim
    // has to be quoted from.
    expect(warmup?.cvAllRuns).not.toBeNull();
    expect(warmup?.cvExcludingFirstRun).not.toBeNull();
    // The order statistics are recorded but must not be what decides the run.
    expect(typeof warmup?.withinRestRange).toBe('boolean');
    expect(typeof warmup?.withinRestIqr).toBe('boolean');
  });

  test('the scaling suite runs every tier the configuration lists', () => {
    expect(scaling.summary.failures).toEqual([]);
    expect(scaling.raw.tiers.map((t) => t.tier.id)).toEqual(['tiny', 'small']);
    for (const tier of scaling.raw.tiers) {
      expect(tier.runs).toHaveLength(TINY_SCALING.recordedRuns);
      expect(tier.scienceHashesStableWithinTier).toBe(true);
    }
  });

  test('a bigger tier produces more grid cells and does more work', () => {
    const [tiny, small] = scaling.summary.tiers;
    expect(small.gridCellCount as number).toBeGreaterThan(tiny.gridCellCount as number);
  });
});

describe('the compact scaling table', () => {
  const rows = (): string[] => scalingTable(scaling.summary);
  const dataRows = (): string[] => rows().filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| tier |'));

  test('has one data row per tier and names its estimators', () => {
    expect(dataRows()).toHaveLength(scaling.summary.tiers.length);
    const header = rows().find((l) => l.startsWith('| tier |')) as string;
    expect(header).toContain('median analysis (ms)');
    expect(header).toContain('median pipeline total (ms)');
    expect(header).toContain('median points/s');
    // The memory column used to be a max sitting silently among medians.
    expect(header).toContain('peak RSS median (MiB)');
    expect(header).toContain('peak RSS max (MiB)');
    expect(dataRows()[0]).toContain('| tiny |');
  });

  test('carries the interval and relief that explain the contour count', () => {
    const header = rows().find((l) => l.startsWith('| tier |')) as string;
    expect(header).toContain('contour interval (m)');
    expect(header).toContain('elevation range (m)');
  });

  test('carries its caveats with it, so they survive being copied elsewhere', () => {
    const text = rows().join('\n');
    expect(text).toContain('No complexity class is claimed');
    expect(text).toContain('not a mid-stage high-water mark');
    expect(text).toContain('double-count');
    expect(text).toContain('NOT comparable across tiers');
    // And the isolation regime, because it decides whether the curve is
    // attributable to input size at all.
    expect(text).toContain('ONE process');
  });

  test('the overview embeds the same table, caveats included', () => {
    const { latest } = publish();
    const overview = readFileSync(join(latest, 'summary.md'), 'utf8');
    for (const line of dataRows()) expect(overview).toContain(line);
    expect(overview).toContain('No complexity class is claimed');
    expect(overview).toContain('NOT comparable across tiers');
  });
});

describe('the written tree', () => {
  test('has the layout the manifest promises', () => {
    const { latest, archive } = publish();
    for (const file of [
      'manifest.json',
      'environment.json',
      'summary.md',
      'summary.html',
      'reproducibility/raw.json',
      'reproducibility/runs.csv',
      'reproducibility/summary.json',
      'reproducibility/summary.md',
      'reproducibility/artifacts/science-hashes.json',
      'scaling/raw.json',
      'scaling/runs.csv',
      'scaling/summary.json',
      'scaling/summary.md',
    ]) {
      expect(readFileSync(join(latest, file), 'utf8').length, file).toBeGreaterThan(0);
    }
    // The archive is a full copy, not a pointer: `latest/` is replaced on the
    // next run and a citation to it would then say something different.
    expect(readFileSync(join(archive, 'manifest.json'), 'utf8')).toBe(
      readFileSync(join(latest, 'manifest.json'), 'utf8'),
    );
  });

  test('the manifest carries the provenance a reader needs and nothing private', () => {
    const { latest } = publish();
    const manifest = JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8'));

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.benchmarkPackageVersion).toBe('1.1.0');
    expect(manifest.startedAtUtc).toBe(START);
    expect(manifest.completedAtUtc).toBe(END);
    expect(manifest.command).toBe('test');
    expect(Object.keys(manifest.configuration).sort()).toEqual(['reproducibility', 'scaling']);
    expect(manifest.datasetIds.length).toBeGreaterThan(0);
    for (const field of ['os', 'arch', 'cpuModel', 'logicalCpuCount', 'totalMemoryBytes', 'loadAverage', 'nodeVersion', 'npmVersion', 'olvVersion', 'commit', 'workingTree']) {
      expect(manifest[field], field).toBeDefined();
      expect(['captured', 'unavailable']).toContain(manifest[field].status);
    }
    if (manifest.commit.status === 'captured') {
      expect(manifest.commit.value).toMatch(/^[0-9a-f]{40}$/);
    }

    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain(homedir());
    expect(serialised).not.toContain(userInfo().username);
    // Relative paths only — an absolute path in a published manifest leaks the
    // layout of the machine that produced it.
    for (const entry of manifest.files) {
      expect(entry.path.startsWith('/'), entry.path).toBe(false);
      expect(entry.path).not.toContain('..');
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The manifest cannot list itself: its own hash would be over bytes that do
    // not exist while it is being written.
    expect(manifest.files.some((f: { path: string }) => f.path === 'manifest.json')).toBe(false);
  });

  test('records the garbage-collection regime, asked-for and observed', () => {
    const { latest } = publish();
    const manifest = JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8'));

    // Both halves present. The pair is the point: `requested` alone would let a
    // flag that never reached a worker publish itself as a GC-controlled run.
    expect(manifest.forcedGc.requested).toBe(false);
    expect(['all', 'none', 'mixed', 'no-runs']).toContain(manifest.forcedGc.observedInRuns);

    // The observed half is DERIVED FROM THE RUNS, not from the environment, so
    // it has to agree with what the raw file says every run had.
    const raw = JSON.parse(readFileSync(join(latest, 'scaling', 'raw.json'), 'utf8'));
    const observed: boolean[] = [];
    for (const r of JSON.parse(readFileSync(join(latest, 'reproducibility', 'raw.json'), 'utf8')).runs) {
      observed.push(r.observation.memory.forcedGcAvailable);
    }
    for (const tier of raw.tiers) {
      for (const r of tier.runs) observed.push(r.observation.memory.forcedGcAvailable);
    }
    expect(manifest.forcedGc.observedInRuns).toBe(summariseForcedGc(observed));

    // And it reaches the page a reader actually opens.
    expect(readFileSync(join(latest, 'summary.md'), 'utf8')).toContain('- forced GC: not requested;');
  });

  test('the overview calls out a GC mode that was asked for and did not arrive', () => {
    // The pure renderer rather than a published tree: whether THIS worker has
    // `global.gc` depends on how the unit suite was launched, and a test whose
    // expectation moves with that would be asserting the environment.
    const base: OverviewInput = {
      startedAt: START,
      completedAt: END,
      command: 'test',
      olvVersion: '0.0.0',
      benchmarkPackageVersion: '1.1.0',
      commit: 'f'.repeat(40),
      workingTreeClean: true,
      reproducibility: null,
      scaling: null,
      notRun: [],
      forcedGc: { requested: true, observedInRuns: 'all' },
    };
    const line = (requested: boolean, observedInRuns: ForcedGcObservation): string =>
      overviewMarkdown({ ...base, forcedGc: { requested, observedInRuns } })
        .split('\n')
        .find((l) => l.startsWith('- forced GC:')) ?? '';

    // Agreement, either way round, is quiet.
    expect(line(true, 'all')).not.toContain('MISMATCH');
    expect(line(false, 'none')).not.toContain('MISMATCH');
    // Disagreement is not. These are the two shapes of a broken flag: it
    // reached nothing, or it reached some of the tier children and not others.
    expect(line(true, 'none')).toContain('MISMATCH');
    expect(line(true, 'mixed')).toContain('MISMATCH');
    // And GC that turned up unasked matters too — it means the numbers are not
    // the default-mode numbers the label promises.
    expect(line(false, 'all')).toContain('MISMATCH');
  });

  test('names the browser suite as not run rather than reporting zeros for it', () => {
    const { latest } = publish();
    const manifest = JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8'));
    const summary = readFileSync(join(latest, 'summary.md'), 'utf8');
    expect(manifest.notRun).toEqual([]);
    // With a declared seam, the overview states it in the suite table.
    const withSeam = publish({
      resultsDir: mkdtempSync(join(tmpdir(), 'olv-bench-seam-')),
      notRun: [{ suiteId: 'browser', reason: 'needs a browser' }],
    });
    expect(readFileSync(join(withSeam.latest, 'summary.md'), 'utf8')).toContain('| browser | not run |');
    // The closing note is deliberately narrow: it claims derivation, not
    // completeness, and points at the per-suite files for what it leaves out.
    expect(summary).toContain('none is hand-entered');
    expect(summary).toContain('This page is a summary, not the full record');
  });

  test('refuses to overwrite an archive', () => {
    const { root } = publish();
    // Same start timestamp, same commit — the archive directory name is the
    // same, and the second write must be refused rather than merged.
    expect(() =>
      writeResults({
        command: 'test',
        startedAtUtc: START,
        completedAtUtc: END,
        reproducibility: repro,
        scaling,
        resultsDir: root,
      }),
    ).toThrow(/archives are immutable/);
  });

  test('replaces latest/ rather than leaving a previous suite behind', () => {
    const root = mkdtempSync(join(tmpdir(), 'olv-bench-'));
    writeResults({
      command: 'both',
      startedAtUtc: START,
      completedAtUtc: END,
      reproducibility: repro,
      scaling,
      resultsDir: root,
    });
    const second = writeResults({
      command: 'scaling only',
      // A different stamp, so the archive check is not what is being exercised.
      startedAtUtc: '2026-07-26T10:30:00.000Z',
      completedAtUtc: '2026-07-26T10:31:00.000Z',
      reproducibility: null,
      scaling,
      resultsDir: root,
    });
    expect(() => readFileSync(join(second.latestDir, 'reproducibility', 'raw.json'), 'utf8')).toThrow();
    expect(second.manifest.suites.map((s) => s.suiteId)).toEqual(['scaling']);
  });

  test('the archive stamp is filesystem-safe and refuses a non-UTC string', () => {
    expect(archiveStamp('2026-07-26T09:30:00.000Z')).toBe('2026-07-26T09-30-00Z');
    expect(() => archiveStamp('yesterday')).toThrow(/UTC ISO 8601/);
  });
});

describe('markdown and CSV agree with the JSON they came from', () => {
  test('every rendered file re-renders identically from the published JSON', () => {
    const { latest } = publish();
    expect(readFileSync(join(latest, 'reproducibility', 'summary.md'), 'utf8')).toBe(
      reproducibilityMarkdown(JSON.parse(readFileSync(join(latest, 'reproducibility', 'summary.json'), 'utf8'))),
    );
    expect(readFileSync(join(latest, 'scaling', 'summary.md'), 'utf8')).toBe(
      scalingMarkdown(JSON.parse(readFileSync(join(latest, 'scaling', 'summary.json'), 'utf8'))),
    );
    expect(readFileSync(join(latest, 'reproducibility', 'runs.csv'), 'utf8')).toBe(
      reproducibilityCsv(JSON.parse(readFileSync(join(latest, 'reproducibility', 'raw.json'), 'utf8'))),
    );
    expect(readFileSync(join(latest, 'scaling', 'runs.csv'), 'utf8')).toBe(
      scalingCsv(JSON.parse(readFileSync(join(latest, 'scaling', 'raw.json'), 'utf8'))),
    );
  });

  /**
   * The quanta come from `benchmark:seeds`, which measures the seed-to-seed
   * spread of each scalar over 32 fixtures and reports any published at a finer
   * quantum than that spread. Pinned here so a renderer cannot go back to
   * printing digits the measurement does not carry.
   */
  test('the scalars are printed at the quantum their seed-to-seed spread supports', () => {
    const { latest } = publish();
    const md = readFileSync(join(latest, 'scaling', 'summary.md'), 'utf8');
    expect(md).toMatch(/^- mean confidence: (\d+|unavailable)$/m);
    expect(md).toMatch(/^- quality score: (\d+|unavailable)$/m);
    expect(md).toMatch(/ m interval over (\d+\.\d|unavailable) m of relief$/m);

    const csv = readFileSync(join(latest, 'scaling', 'runs.csv'), 'utf8').split('\n').filter((l) => l !== '');
    const header = csv[0].split(',');
    const column = (row: string, name: string): string => row.split(',')[header.indexOf(name)];
    for (const row of csv.slice(1)) {
      expect(column(row, 'meanConfidence')).toMatch(/^(-?\d+|unavailable)$/);
      expect(column(row, 'qualityScore')).toMatch(/^(-?\d+|unavailable)$/);
    }
  });

  test('the CSVs carry one row per recorded run', () => {
    const { latest } = publish();
    const rows = (file: string): number =>
      readFileSync(join(latest, file), 'utf8').split('\n').filter((l) => l !== '').length - 1;
    expect(rows('reproducibility/runs.csv')).toBe(TINY_REPRO.recordedRuns);
    expect(rows('scaling/runs.csv')).toBe(TINY_SCALING.tiers.length * TINY_SCALING.recordedRuns);
  });
});

describe('the verifier', () => {
  test('passes a freshly published tree', () => {
    const { latest } = publish();
    const outcome = verifyResultsDir(latest);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.checked.length).toBeGreaterThan(5);
  });

  test('fails when a summary is missing entirely', () => {
    const { latest } = publish();
    writeFileSync(join(latest, 'scaling', 'summary.json'), 'not json', 'utf8');
    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/sha256|could not be read as JSON/);
  });

  test('catches a hand-edited median', () => {
    const { latest } = publish();
    const path = join(latest, 'reproducibility', 'summary.json');
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    const block = summary.timing.available.find((b: { key: string }) => b.key === 'analysisMs');
    block.summary.median = 1;
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/does not match the manifest/);
  });

  test('catches a doctored median even when the manifest is re-hashed to match', () => {
    const { latest } = publish();
    const summaryPath = join(latest, 'reproducibility', 'summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    summary.timing.available.find((b: { key: string }) => b.key === 'analysisMs').summary.median = 1;
    const contents = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(summaryPath, contents, 'utf8');
    rehash(latest, 'reproducibility/summary.json', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    // Recomputation from the raw values is what catches this, not the digest.
    expect(outcome.problems.join('\n')).toMatch(/does not recompute from raw/);
  });

  test('catches a raw file whose run count no longer matches the configuration', () => {
    const { latest } = publish();
    const path = join(latest, 'reproducibility', 'raw.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.runs.pop();
    const contents = `${JSON.stringify(raw, null, 2)}\n`;
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'reproducibility/raw.json', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/runs, configuration says/);
  });

  test('catches a CSV row removed by hand', () => {
    const { latest } = publish();
    const path = join(latest, 'scaling', 'runs.csv');
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    const contents = `${lines.slice(0, -1).join('\n')}\n`;
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'scaling/runs.csv', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/data rows, expected|does not match what the published JSON renders to/);
  });

  test('catches a required file removed from the tree and from the listing', () => {
    const { latest } = publish();
    const manifestPath = join(latest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files.filter((f: { path: string }) => f.path !== 'scaling/summary.md');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    rmSync(join(latest, 'scaling', 'summary.md'));

    // Dropping a file from the digest list is not enough to hide it: the
    // required-file list is derived from the suites the manifest claims to
    // have run, not from the listing itself.
    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/scaling\/summary\.md/);
  });

  test('catches an edited number in the top-level summary.md', () => {
    // The file a figure is copied out of. It was hashed and listed as required
    // but never re-rendered, so this exact edit — with the digest refreshed —
    // used to pass.
    const { latest } = publish();
    const path = join(latest, 'summary.md');
    const original = readFileSync(path, 'utf8');
    const median = /\| (\d+\.\d{3}) \|/.exec(original);
    expect(median, 'the overview must contain a median to tamper with').not.toBeNull();
    const contents = original.replace(median![1], '999.999');
    expect(contents).not.toBe(original);
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'summary.md', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/summary\.md: does not match what the published JSON renders to/);
  });

  test('catches an edited number in the top-level summary.html', () => {
    const { latest } = publish();
    const path = join(latest, 'summary.html');
    const original = readFileSync(path, 'utf8');
    const rate = /(\d+\.\d) \|/.exec(original);
    expect(rate).not.toBeNull();
    const contents = original.replace(rate![1], '999999.9');
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'summary.html', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/summary\.html: does not match what the published JSON renders to/);
  });

  test('names the field that was tampered with, not always the median', () => {
    const { latest } = publish();
    const path = join(latest, 'reproducibility', 'summary.json');
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    const block = summary.timing.available.find((b: { key: string }) => b.key === 'analysisMs');
    block.summary.min = 1;
    const contents = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'reproducibility/summary.json', contents);

    const outcome = verifyResultsDir(latest);
    const message = outcome.problems.join('\n');
    expect(message).toMatch(/min is published as 1, recomputes to/);
    expect(message).not.toMatch(/median is published/);
  });

  test('scans every published file for private paths, not just the manifest', () => {
    const { latest } = publish();
    const path = join(latest, 'environment.json');
    const contents = JSON.stringify({ leaked: `${homedir()}/scratch` }, null, 2);
    writeFileSync(path, contents, 'utf8');
    rehash(latest, 'environment.json', contents);

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/home-directory path or an IP address.*environment\.json/s);
  });

  test('verifies every archive, not only latest/', () => {
    const { root, archive } = publish();
    expect(verifyArchives(root).problems).toEqual([]);

    const path = join(archive, 'scaling', 'summary.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}tampered\n`, 'utf8');
    const outcome = verifyArchives(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/archive\/.*scaling\/summary\.md/);
  });

  test('fails on a bad schema version', () => {
    const { latest } = publish();
    const path = join(latest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaVersion = 99;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/schema version 99/);
  });

  test('fails on a missing tree rather than reporting success over nothing', () => {
    const outcome = verifyResultsDir(join(mkdtempSync(join(tmpdir(), 'olv-empty-')), 'absent'));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/manifest\.json: missing/);
  });
});

/**
 * Rewrite one manifest entry's digest.
 *
 * Used only to prove the OTHER checks stand on their own: with the hash made
 * consistent again, a caught tamper is caught by recomputation or by
 * re-rendering, not by the digest doing all the work.
 */
function rehash(latest: string, relPath: string, contents: string): void {
  const manifestPath = join(latest, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = Buffer.from(contents, 'utf8');
  const entry = manifest.files.find((f: { path: string }) => f.path === relPath);
  if (!entry) throw new Error(`rehash: ${relPath} is not in the manifest`);
  entry.sha256 = nodeSha256Hex(new Uint8Array(bytes));
  entry.bytes = bytes.byteLength;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
