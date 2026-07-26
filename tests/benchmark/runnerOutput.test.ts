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
import { verifyResultsDir } from '../../benchmarks/runner/verify';
import {
  reproducibilityCsv,
  reproducibilityMarkdown,
  scalingCsv,
  scalingMarkdown,
  scalingTable,
} from '../../benchmarks/runner/render';

const TERRAIN = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', holdoutSeed: 1 };

const TINY_REPRO: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: 4242,
  pointCount: 3_000,
  warmupRuns: 0,
  recordedRuns: 3,
  terrain: TERRAIN,
  scalarTolerance: 0,
};

const TINY_SCALING: ScalingConfig = {
  suiteId: 'scaling',
  seed: 4242,
  tiers: [
    { id: 'tiny', pointCount: 3_000 },
    { id: 'small', pointCount: 6_000 },
  ],
  warmupRuns: 0,
  recordedRuns: 2,
  terrain: TERRAIN,
  acceptedTierFailures: [],
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
  test('has one row per tier plus a header and a rule', () => {
    const rows = scalingTable(scaling.summary);
    expect(rows).toHaveLength(2 + scaling.summary.tiers.length);
    expect(rows[0]).toContain('median analysis (ms)');
    expect(rows[0]).toContain('median pipeline total (ms)');
    expect(rows[0]).toContain('median points/s');
    expect(rows[2]).toContain('| tiny |');
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

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.benchmarkPackageVersion).toBe('1.0.0');
    expect(manifest.startedAtUtc).toBe(START);
    expect(manifest.completedAtUtc).toBe(END);
    expect(manifest.command).toBe('test');
    expect(Object.keys(manifest.configuration).sort()).toEqual(['reproducibility', 'scaling']);
    expect(manifest.datasetIds.length).toBeGreaterThan(0);
    for (const field of ['os', 'arch', 'cpuModel', 'logicalCpuCount', 'totalMemoryBytes', 'nodeVersion', 'npmVersion', 'olvVersion', 'commit', 'workingTree']) {
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
    expect(summary).toContain('Every number here is derived from the raw result files');
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
