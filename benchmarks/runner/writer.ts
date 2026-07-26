/**
 * writer.ts
 *
 * The output tree, the manifest, and the archive.
 *
 * WHY `latest/` IS REPLACEABLE AND ARCHIVES ARE NOT. `latest/` is a convenience:
 * a path a script or a README can point at without knowing when the last run
 * happened. An archive is evidence — a figure in a paper cites one, and a
 * citation to a directory whose contents can change is worth nothing. So a
 * write to an existing archive directory is refused outright rather than merged
 * or overwritten, and the refusal names the directory.
 *
 * WHY EVERY FILE IS HASHED INTO THE MANIFEST. The claim the manifest makes is
 * "these exact bytes were produced by that exact commit on that host". Without a
 * digest per file the claim covers the file NAMES only, and a summary edited by
 * hand afterwards would still be covered by it. `benchmark:verify` recomputes
 * every one of them.
 *
 * WHY THE CLOCK IS AN ARGUMENT. Nothing under `benchmarks/` reads the wall
 * clock — a source guard enforces it, because a hashed artifact that embeds a
 * timestamp can never reproduce. The manifest legitimately needs start and
 * completion times, so the caller (the vitest entry point, outside the guarded
 * tree) supplies them. That also makes the whole writer deterministic and
 * therefore testable.
 *
 * WHAT MUST NEVER REACH THE MANIFEST: a username, a home directory, an absolute
 * path, a token, an IP address. Every path written is relative to the results
 * directory, and the host fields come from the framework's own environment
 * capture, which reports OS, CPU model, architecture, Node version, commit and
 * cleanliness and nothing else. A test asserts the machine's home directory and
 * user name appear nowhere in the emitted JSON.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { capturedEnv, unavailableEnv, type BenchmarkEnvironment, type EnvValue } from '../framework';
import { captureEnvironment, nodeSha256Hex } from '../framework/node';
import { BENCHMARK_PACKAGE_VERSION, BENCHMARK_SCHEMA_VERSION } from './config';
import type { ReproducibilityResult } from './reproducibility';
import type { ScalingResult } from './scaling';
import {
  overviewHtml,
  overviewInputFrom,
  overviewMarkdown,
  reproducibilityCsv,
  reproducibilityMarkdown,
  scalingCsv,
  scalingMarkdown,
  type OverviewHeader,
  type OverviewInput,
} from './render';

/** Repo root, two levels up from `benchmarks/runner/`. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const RESULTS_DIR = join(REPO_ROOT, 'benchmark-results');
export const LATEST_DIR = join(RESULTS_DIR, 'latest');
export const ARCHIVE_DIR = join(RESULTS_DIR, 'archive');

/** Host facts the framework's environment capture does not carry. */
export interface HostExtras {
  readonly logicalCpuCount: EnvValue;
  readonly totalMemoryBytes: EnvValue;
  readonly npmVersion: EnvValue;
  /**
   * 1/5/15-minute load average at the moment the results were written.
   *
   * Recorded because it is the single most useful thing for deciding whether a
   * timing column is worth comparing against another run. The same suite on the
   * same commit produced a coefficient of variation near 0.02 on an idle
   * machine and near 0.10 with a load average of 7 on 14 cores — a difference
   * entirely outside the software. Without this field a reader has no way to
   * tell those two result sets apart. Zero on platforms that do not report it,
   * which is why the raw string is kept rather than a derived verdict.
   */
  readonly loadAverage: EnvValue;
}

function captureOne(what: string, read: () => string | null): EnvValue {
  try {
    const value = read();
    if (value === null || value.trim() === '') return unavailableEnv(`${what}: not reported by this host`);
    return capturedEnv(value.trim());
  } catch (err) {
    return unavailableEnv(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function captureHostExtras(): HostExtras {
  return {
    // availableParallelism reflects cgroup and affinity limits; cpus().length
    // does not, and on a container the difference is the whole point of the
    // field. Neither is invented when both are missing.
    logicalCpuCount: captureOne('logical cpu count', () =>
      String(os.availableParallelism ? os.availableParallelism() : os.cpus().length),
    ),
    totalMemoryBytes: captureOne('total memory', () => String(os.totalmem())),
    loadAverage: captureOne('load average', () => {
      const [one, five, fifteen] = os.loadavg();
      // Windows reports [0, 0, 0]; that is "not supported", not "idle", and
      // publishing three zeros as a measurement is the substitution this whole
      // framework refuses to make.
      if (one === 0 && five === 0 && fifteen === 0) return null;
      return `${one.toFixed(2)} ${five.toFixed(2)} ${fifteen.toFixed(2)}`;
    }),
    npmVersion: captureOne('npm version', () =>
      execFileSync('npm', ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    ),
  };
}

export interface ManifestFileEntry {
  /** POSIX-style path relative to the results directory. Never absolute. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BenchmarkManifest {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly olvVersion: EnvValue;
  readonly commit: EnvValue;
  readonly commitShort: EnvValue;
  readonly workingTree: EnvValue;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly os: EnvValue;
  readonly arch: EnvValue;
  readonly cpuModel: EnvValue;
  readonly logicalCpuCount: EnvValue;
  readonly totalMemoryBytes: EnvValue;
  /** Host load when the results were written. See {@link HostExtras}. */
  readonly loadAverage: EnvValue;
  readonly nodeVersion: EnvValue;
  readonly npmVersion: EnvValue;
  readonly command: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly datasetIds: readonly string[];
  readonly suites: readonly { readonly suiteId: string; readonly pass: boolean }[];
  readonly notRun: readonly { readonly suiteId: string; readonly reason: string }[];
  readonly files: readonly ManifestFileEntry[];
}

export interface WriteResultsOptions {
  readonly command: string;
  /** UTC ISO 8601, supplied by the caller. See the header for why. */
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly reproducibility: ReproducibilityResult | null;
  readonly scaling: ScalingResult | null;
  /** Suites deliberately not run, each with a reason a reader can act on. */
  readonly notRun?: readonly { readonly suiteId: string; readonly reason: string }[];
  /** Overridable for tests; defaults to the repo's `benchmark-results/`. */
  readonly resultsDir?: string;
  readonly environment?: BenchmarkEnvironment;
  readonly hostExtras?: HostExtras;
}

export interface WriteResultsOutcome {
  readonly latestDir: string;
  readonly archiveDir: string;
  readonly manifest: BenchmarkManifest;
}

/** `2026-07-26T09:30:00.000Z` → `2026-07-26T09-30-00Z`, safe on every filesystem. */
export function archiveStamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) throw new Error(`benchmark archive: expected a UTC ISO 8601 timestamp, got ${iso}`);
  return `${match[1]}T${match[2]}-${match[3]}-${match[4]}Z`;
}

function writeFile(root: string, relPath: string, contents: string, files: ManifestFileEntry[]): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  const bytes = Buffer.from(contents, 'utf8');
  files.push({
    path: relPath.split(sep).join('/'),
    sha256: nodeSha256Hex(bytes),
    bytes: bytes.byteLength,
  });
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}

export function writeResults(options: WriteResultsOptions): WriteResultsOutcome {
  const resultsDir = options.resultsDir ?? RESULTS_DIR;
  const latestDir = join(resultsDir, 'latest');
  const environment = options.environment ?? captureEnvironment({ repoRoot: REPO_ROOT });
  const hostExtras = options.hostExtras ?? captureHostExtras();

  const shortCommit =
    environment.gitCommitShort.status === 'captured' ? environment.gitCommitShort.value : 'nocommit';
  const archiveDir = join(resultsDir, 'archive', `${archiveStamp(options.startedAtUtc)}-${shortCommit}`);
  if (existsSync(archiveDir)) {
    // Refused, not merged. An archive a second run can edit is not evidence.
    throw new Error(
      `benchmark archive: ${archiveStamp(options.startedAtUtc)}-${shortCommit} already exists and archives are immutable`,
    );
  }

  // `latest/` is explicitly replaceable, and it must be REPLACED rather than
  // written over: a previous run's reproducibility directory left in place next
  // to a scaling-only run would be read as part of this run's results.
  rmSync(latestDir, { recursive: true, force: true });
  mkdirSync(latestDir, { recursive: true });

  const files: ManifestFileEntry[] = [];
  const datasetIds: string[] = [];
  const configuration: Record<string, unknown> = {};
  const suites: { suiteId: string; pass: boolean }[] = [];

  if (options.reproducibility) {
    const { raw, summary } = options.reproducibility;
    configuration.reproducibility = raw.config;
    datasetIds.push(raw.datasetId);
    suites.push({ suiteId: 'reproducibility', pass: summary.pass });
    writeFile(latestDir, join('reproducibility', 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`, files);
    writeFile(latestDir, join('reproducibility', 'runs.csv'), reproducibilityCsv(raw), files);
    writeFile(
      latestDir,
      join('reproducibility', 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      files,
    );
    writeFile(latestDir, join('reproducibility', 'summary.md'), reproducibilityMarkdown(summary), files);
    // The artifact evidence, separated from the summary a reader skims: the
    // per-run hash table is what someone re-running the suite on another
    // machine actually diffs.
    writeFile(
      latestDir,
      join('reproducibility', 'artifacts', 'science-hashes.json'),
      `${JSON.stringify(
        {
          note: 'Science-scoped artifact hashes. Build-scoped hashes are listed separately because they track the commit and Node version, not the science.',
          reference: summary.identity.referenceScienceHashes,
          buildScoped: summary.identity.referenceBuildScopedHashes,
          perRun: raw.runs.map((r) => ({
            run: r.index,
            science: r.observation.scienceHashes,
            buildScoped: r.observation.buildScopedHashes,
          })),
        },
        null,
        2,
      )}\n`,
      files,
    );
    writeFile(
      latestDir,
      join('reproducibility', 'artifacts', 'scientific-record-content.json'),
      `${JSON.stringify(raw.runs[0]?.observation.scientificRecordContent ?? null, null, 2)}\n`,
      files,
    );
  }

  if (options.scaling) {
    const { raw, summary } = options.scaling;
    configuration.scaling = raw.config;
    for (const tier of raw.tiers) {
      const id = tier.runs[0]?.observation.datasetId;
      if (id !== undefined) datasetIds.push(id);
    }
    suites.push({ suiteId: 'scaling', pass: summary.pass });
    writeFile(latestDir, join('scaling', 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`, files);
    writeFile(latestDir, join('scaling', 'runs.csv'), scalingCsv(raw), files);
    writeFile(latestDir, join('scaling', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, files);
    writeFile(latestDir, join('scaling', 'summary.md'), scalingMarkdown(summary), files);
  }

  writeFile(
    latestDir,
    'environment.json',
    `${JSON.stringify({ ...environment, ...hostExtras }, null, 2)}\n`,
    files,
  );

  // The header is built ONCE and used for both the overview and the manifest,
  // so the verifier can rebuild the overview from the manifest alone and get
  // the identical string. Two independent derivations is how the top-level
  // summary ended up outside every check the per-suite files were inside.
  const header: OverviewHeader = {
    olvVersion: environment.releaseVersion,
    commit: environment.gitCommitFull,
    workingTree: environment.gitDirty,
    startedAtUtc: options.startedAtUtc,
    completedAtUtc: options.completedAtUtc,
    command: options.command,
    notRun: options.notRun ?? [],
  };
  const overview: OverviewInput = overviewInputFrom(
    header,
    BENCHMARK_PACKAGE_VERSION,
    options.reproducibility?.summary ?? null,
    options.scaling?.summary ?? null,
  );
  writeFile(latestDir, 'summary.md', overviewMarkdown(overview), files);
  writeFile(latestDir, 'summary.html', overviewHtml(overview), files);

  const manifest: BenchmarkManifest = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    olvVersion: environment.releaseVersion,
    commit: environment.gitCommitFull,
    commitShort: environment.gitCommitShort,
    workingTree: environment.gitDirty,
    startedAtUtc: options.startedAtUtc,
    completedAtUtc: options.completedAtUtc,
    os: environment.os,
    arch: environment.arch,
    cpuModel: environment.cpuModel,
    logicalCpuCount: hostExtras.logicalCpuCount,
    totalMemoryBytes: hostExtras.totalMemoryBytes,
    loadAverage: hostExtras.loadAverage,
    nodeVersion: environment.nodeVersion,
    npmVersion: hostExtras.npmVersion,
    command: options.command,
    configuration,
    datasetIds,
    suites,
    notRun: options.notRun ?? [],
    // Sorted so two runs' manifests diff cleanly; the directory walk order is
    // not a property anyone should have to reason about.
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  // The manifest lists every OTHER file and is therefore written last and never
  // lists itself — a self-hash would have to be computed over bytes that do not
  // exist yet.
  writeFileSync(join(latestDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  copyTree(latestDir, archiveDir);

  return { latestDir, archiveDir, manifest };
}

/** Relative POSIX path of `full` inside `root`. Used by the verifier. */
export function relPosix(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}
