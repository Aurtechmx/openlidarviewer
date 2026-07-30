/**
 * requiredArtifactInventory.test.ts
 *
 * Is the benchmark verifier's required-artifact inventory authoritative?
 *
 * WHY THIS IS A SEPARATE QUESTION from "does the verifier reject a tree with a
 * file missing". Registered mutant M07 deletes `summary.html` from
 * `requiredFiles`. A tree with that page removed is still rejected afterwards,
 * because the overview page is also re-rendered and compared, so a test that
 * only asks "does verification fail" cannot see the mutation at all. What the
 * mutation destroys is the INVENTORY: the list that says, independently of any
 * other check, which artifacts a complete deposit has to carry. If a future
 * change moves the re-render behind a condition, or renders only when a suite
 * ran, the inventory is the last thing standing between a truncated tree and a
 * clean verdict.
 *
 * So the inventory is checked two ways here, neither of which restates the
 * source list:
 *
 *   1. Against a tree the writer actually produced. Every top-level file a
 *      fresh publish emits must be in the inventory. That derivation comes from
 *      the writer, not from a literal typed next to the one under test.
 *   2. By the problem it must report. Removing the page has to produce the
 *      inventory's own diagnosis, not merely some failure.
 *
 * Everything runs against a tree published into the OS temp directory. Nothing
 * here reads `benchmark-results/`: a stale or generated tree left in a checkout
 * must not be able to satisfy or to break this file.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReproducibilityConfig, ScalingConfig } from '../../benchmarks/runner/config';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { runScalingSuite } from '../../benchmarks/runner/scaling';
import { writeResults } from '../../benchmarks/runner/writer';
import { requiredFiles, verifyResultsDir } from '../../benchmarks/runner/verify';
import type { BenchmarkManifest } from '../../benchmarks/runner/writer';

const TERRAIN = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', holdoutSeed: 1 };

// 25k points per run, matching the sizing the other runner suites settled on:
// below that the residual JIT transient is a real fraction of a run and the
// first-run band check fires for a reason that has nothing to do with this file.
const TINY_REPRO: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: 4242,
  pointCount: 25_000,
  warmupRuns: 3,
  recordedRuns: 5,
  terrain: TERRAIN,
  scalarTolerance: 0,
};

const TINY_SCALING: ScalingConfig = {
  suiteId: 'scaling',
  seed: 4242,
  tiers: [{ id: 'tiny', pointCount: 25_000 }],
  warmupRuns: 3,
  recordedRuns: 4,
  terrain: TERRAIN,
  acceptedTierFailures: [],
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

/**
 * Publish into a fresh temp tree.
 *
 * The root is created under the OS temp directory, never inside the repository,
 * so no file already on disk in a checkout can take part in the verdict.
 */
function publish(): { root: string; latest: string; archive: string } {
  const root = mkdtempSync(join(tmpdir(), 'olv-required-'));
  const outcome = writeResults({
    command: 'test',
    startedAtUtc: START,
    completedAtUtc: END,
    reproducibility: repro,
    scaling,
    resultsDir: root,
    forcedGcRequested: false,
  });
  return { root, latest: outcome.latestDir, archive: outcome.archiveDir };
}

/** Names of the files sitting directly in `dir`, subdirectories excluded. */
function topLevelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function readManifest(latest: string): BenchmarkManifest {
  return JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8')) as BenchmarkManifest;
}

describe('the required-artifact inventory', () => {
  test('names every top-level file a published tree actually carries', () => {
    // Derived from the writer's output, so the inventory cannot be trimmed to
    // match itself. A file the runner emits at the top level of a deposit is by
    // construction part of a complete deposit.
    const { latest } = publish();
    const required = new Set(requiredFiles(readManifest(latest)));
    for (const name of topLevelFiles(latest)) {
      expect(required.has(name), `${name} is published but not required`).toBe(true);
    }
    // Guard against the check passing because the tree emitted nothing: the
    // rendered overview page in both formats is the minimum a reader gets.
    expect(topLevelFiles(latest)).toContain('summary.html');
    expect(topLevelFiles(latest)).toContain('summary.md');
  });

  test('names the rendered overview page whatever suites the manifest claims', () => {
    // The suite-conditional entries drop out when a manifest lists no suite,
    // and the unconditional core must not drop out with them. Built as a
    // manifest literal rather than from a publish, because a tree with no suite
    // is not something the runner produces.
    const empty = { suites: [] } as unknown as BenchmarkManifest;
    expect(requiredFiles(empty)).toContain('summary.html');
    const reproOnly = { suites: [{ suiteId: 'reproducibility', pass: true }] } as unknown as BenchmarkManifest;
    expect(requiredFiles(reproOnly)).toContain('summary.html');
  });

  test('reports its own diagnosis when the overview page is removed', () => {
    const { latest } = publish();
    const manifestPath = join(latest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: { path: string }[];
    };
    // The listing is edited too, so the digest check has nothing to say and the
    // inventory is the check under observation rather than a bystander.
    manifest.files = manifest.files.filter((f) => f.path !== 'summary.html');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    rmSync(join(latest, 'summary.html'));

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toContain('summary.html: required file is missing');
  });

  test('is not satisfied by a copy of the page sitting elsewhere on disk', () => {
    // The archive directory beside `latest/` holds a byte-identical copy of the
    // same page, and a generated tree in a working directory would hold others.
    // A verifier that resolved required files loosely, or that trusted "the
    // build produced this once", would pass the truncated tree.
    const { latest, archive } = publish();
    expect(existsSync(join(archive, 'summary.html'))).toBe(true);
    rmSync(join(latest, 'summary.html'));

    const outcome = verifyResultsDir(latest);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toContain('summary.html: required file is missing');
    // The copy is untouched, so the failure is about the tree under test and
    // not about having deleted the only instance of the file.
    expect(existsSync(join(archive, 'summary.html'))).toBe(true);
  });
});
