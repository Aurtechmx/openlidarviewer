/**
 * writer.ts
 *
 * The portability output tree: one directory per platform leg, and one
 * comparison built from two or more of them.
 *
 * WHY A PLATFORM LEG IS ITS OWN DIRECTORY WITH ITS OWN MANIFEST. The two legs
 * are produced by two machines that never see each other. Whatever travels
 * between them is the evidence, so it has to be self-describing and checkable
 * on arrival: a leg carries the record, the environment it was taken in, and a
 * manifest hashing both. The comparator refuses a leg whose manifest does not
 * verify rather than comparing bytes of unknown provenance.
 *
 * WHY THE COMPARISON IS RECOMPUTED, NOT TRUSTED. `comparison.json` is a derived
 * document, and the verifier re-derives it from the platform records in the
 * subdirectories and compares field by field. That is what makes an edited
 * verdict fail even when every SHA-256 in the manifest has been refreshed to
 * match the edit: the digests only prove the tree is self-consistent, and
 * self-consistency is exactly what a careful edit preserves.
 *
 * WHAT MUST NEVER REACH THESE FILES: a username, a home directory, an absolute
 * path. Every path recorded is relative to its own directory, and the host
 * fields come from the framework's environment capture.
 *
 * The clock is an argument, never read here, for the same reason it is an
 * argument in the suite writer: nothing under `benchmarks/` may read the wall
 * clock.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { capturedEnv, unavailableEnv, type EnvValue } from '../framework';
import { captureEnvironment, nodeSha256Hex } from '../framework/node';
import { BENCHMARK_PACKAGE_VERSION, BENCHMARK_SCHEMA_VERSION } from '../runner/config';
import { captureHostExtras, type ManifestFileEntry } from '../runner/writer';
import type { ReproducibilityResult } from '../runner/reproducibility';
import { comparePlatforms, type CompareOptions, type PortabilityComparison } from './compare';
import { detectEndianness, platformId } from './preconditions';
import {
  PORTABILITY_SCHEMA_VERSION,
  buildPlatformRecord,
  type PlatformRecord,
} from './record';
import { comparisonCsv, comparisonMarkdown, environmentsDocument } from './render';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PORTABILITY_DIR = join(REPO_ROOT, 'benchmark-results', 'portability');

/** The file a platform leg is identified by. */
export const PLATFORM_RECORD_FILE = 'platform-record.json';

export interface PortabilityManifest {
  readonly schemaVersion: number;
  readonly portabilitySchemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly kind: 'platform' | 'comparison';
  /** Present on a platform leg, absent on a comparison. */
  readonly platformId: string | null;
  readonly commit: EnvValue;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly command: string;
  readonly files: readonly ManifestFileEntry[];
}

function writeFile(root: string, relPath: string, contents: string, files: ManifestFileEntry[]): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  const bytes = Buffer.from(contents, 'utf8');
  files.push({ path: relPath.split(sep).join('/'), sha256: nodeSha256Hex(bytes), bytes: bytes.byteLength });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeManifest(dir: string, manifest: PortabilityManifest): void {
  // Written last and never listing itself: a self-hash would have to cover
  // bytes that do not exist yet.
  writeFileSync(join(dir, 'manifest.json'), json(manifest), 'utf8');
}

function sortFiles(files: readonly ManifestFileEntry[]): ManifestFileEntry[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** SHA-256 of the committed lockfile, so two legs can prove one dependency tree. */
export function captureLockfileHash(repoRoot: string = REPO_ROOT): EnvValue {
  try {
    return capturedEnv(nodeSha256Hex(readFileSync(join(repoRoot, 'package-lock.json'))));
  } catch (err) {
    return unavailableEnv(`lockfile hash: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface WritePlatformLegOptions {
  readonly reproducibility: ReproducibilityResult;
  readonly command: string;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  /** Defaults to `benchmark-results/portability/<platformId>`. */
  readonly outDir?: string;
  readonly repoRoot?: string;
}

export interface WritePlatformLegOutcome {
  readonly dir: string;
  readonly record: PlatformRecord;
  readonly manifest: PortabilityManifest;
}

/**
 * Reduce a completed reproducibility run to one platform leg and write it.
 *
 * The suite is not re-run here and no measurement is taken: this reads a result
 * the caller already has, so the leg and the ordinary result tree describe the
 * same ten runs rather than two different sets of them.
 */
export function writePlatformLeg(options: WritePlatformLegOptions): WritePlatformLegOutcome {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const environment = captureEnvironment({ repoRoot });
  const hostExtras = captureHostExtras();
  const platform = environment.os.status === 'captured' ? environment.os.value.split(' ')[0] : os.platform();
  const arch = environment.arch.status === 'captured' ? environment.arch.value : process.arch;
  const id = platformId(platform, arch);

  const record = buildPlatformRecord({
    platformId: id,
    endianness: detectEndianness(),
    environment: {
      os: environment.os,
      arch: environment.arch,
      cpuModel: environment.cpuModel,
      logicalCpuCount: hostExtras.logicalCpuCount,
      totalMemoryBytes: hostExtras.totalMemoryBytes,
      loadAverage: hostExtras.loadAverage,
      nodeVersion: environment.nodeVersion,
      npmVersion: hostExtras.npmVersion,
      v8Version:
        typeof process.versions.v8 === 'string' && process.versions.v8 !== ''
          ? capturedEnv(process.versions.v8)
          : unavailableEnv('v8 version: not reported by this runtime'),
    },
    commit: environment.gitCommitFull,
    commitShort: environment.gitCommitShort,
    workingTree: environment.gitDirty,
    releaseVersion: environment.releaseVersion,
    lockfileSha256: captureLockfileHash(repoRoot),
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    raw: options.reproducibility.raw,
    summary: options.reproducibility.summary,
  });

  const dir = options.outDir ?? join(PORTABILITY_DIR, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const files: ManifestFileEntry[] = [];
  writeFile(dir, PLATFORM_RECORD_FILE, json(record), files);
  writeFile(dir, 'environment.json', json({ ...environment, ...hostExtras, endianness: record.environment.endianness }), files);
  // The per-run hash table, so a reader diffing two legs by hand has the same
  // evidence the comparator used rather than a summary of it.
  writeFile(
    dir,
    'science-hashes.json',
    json({
      note: 'Science-scoped artifact hashes per recorded run on this platform. Build-scoped hashes are listed separately because they track the commit and the runtime, not the science.',
      reference: record.science.hashes,
      buildScoped: record.buildScopedHashes,
      perRun: options.reproducibility.raw.runs.map((r) => ({
        run: r.index,
        science: r.observation.scienceHashes,
        buildScoped: r.observation.buildScopedHashes,
      })),
    }),
    files,
  );

  const manifest: PortabilityManifest = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    kind: 'platform',
    platformId: id,
    commit: environment.gitCommitFull,
    startedAtUtc: options.startedAtUtc,
    completedAtUtc: options.completedAtUtc,
    command: options.command,
    files: sortFiles(files),
  };
  writeManifest(dir, manifest);

  return { dir, record, manifest };
}

export interface ReadLegOutcome {
  readonly record: PlatformRecord | null;
  readonly problems: readonly string[];
  readonly checked: readonly string[];
}

/**
 * Read one platform leg, refusing it unless its own manifest verifies.
 *
 * A leg arrives as a downloaded CI artifact, which is a tarball anyone could
 * have rewritten between the runner and here. Checking the manifest first is
 * what makes the later comparison a comparison of recorded measurements rather
 * than of whatever bytes were on disk.
 */
export function readPlatformLeg(dir: string): ReadLegOutcome {
  const problems: string[] = [];
  const checked: string[] = [];

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { record: null, problems: [`${dir}: no manifest.json, so this is not a platform leg`], checked };
  }

  let manifest: PortabilityManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PortabilityManifest;
  } catch (err) {
    return {
      record: null,
      problems: [`${dir}/manifest.json: could not be read as JSON — ${err instanceof Error ? err.message : String(err)}`],
      checked,
    };
  }

  if (manifest.kind !== 'platform') {
    problems.push(`${dir}: manifest kind is ${JSON.stringify(manifest.kind)}, expected "platform"`);
  }
  if (manifest.portabilitySchemaVersion !== PORTABILITY_SCHEMA_VERSION) {
    problems.push(
      `${dir}: portability schema version ${String(manifest.portabilitySchemaVersion)} is not ${PORTABILITY_SCHEMA_VERSION}`,
    );
  }

  for (const entry of manifest.files) {
    const full = join(dir, entry.path);
    if (!existsSync(full)) {
      problems.push(`${dir}/${entry.path}: listed in the manifest but absent`);
      continue;
    }
    const bytes = readFileSync(full);
    const hash = nodeSha256Hex(bytes);
    if (hash !== entry.sha256) {
      problems.push(`${dir}/${entry.path}: sha256 ${hash} does not match the manifest's ${entry.sha256}`);
    } else if (bytes.byteLength !== entry.bytes) {
      problems.push(`${dir}/${entry.path}: ${bytes.byteLength} bytes, manifest says ${entry.bytes}`);
    }
  }
  if (!manifest.files.some((f) => f.path === PLATFORM_RECORD_FILE)) {
    problems.push(`${dir}: the manifest does not list ${PLATFORM_RECORD_FILE}`);
  }
  checked.push(`${dir}: manifest lists and matches ${manifest.files.length} files`);

  let record: PlatformRecord | null = null;
  try {
    record = JSON.parse(readFileSync(join(dir, PLATFORM_RECORD_FILE), 'utf8')) as PlatformRecord;
  } catch (err) {
    problems.push(`${dir}/${PLATFORM_RECORD_FILE}: could not be read — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (record !== null && manifest.platformId !== record.platformId) {
    problems.push(
      `${dir}: manifest names platform ${String(manifest.platformId)} but the record names ${record.platformId}`,
    );
  }
  // Checked on the RECORD as well as on the manifest. A manifest is cheap to
  // rewrite and the record is the document the comparison actually reads, so a
  // leg from an older schema carried beside a current manifest has to be
  // refused on the strength of the record itself.
  if (record !== null && record.portabilitySchemaVersion !== PORTABILITY_SCHEMA_VERSION) {
    problems.push(
      `${dir}/${PLATFORM_RECORD_FILE}: portability schema version ${String(record.portabilitySchemaVersion)} is not ${PORTABILITY_SCHEMA_VERSION}`,
    );
  }

  return { record: problems.length === 0 ? record : null, problems, checked };
}

/** Every immediate subdirectory that looks like a platform leg. */
export function findPlatformLegs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, PLATFORM_RECORD_FILE)))
    .map((e) => join(root, e.name))
    .sort();
}

export interface WriteComparisonOptions {
  readonly legDirs: readonly string[];
  readonly command: string;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly compare?: CompareOptions;
  /** Defaults to `benchmark-results/portability`. */
  readonly outDir?: string;
}

export interface WriteComparisonOutcome {
  readonly dir: string;
  readonly comparison: PortabilityComparison | null;
  readonly problems: readonly string[];
  readonly checked: readonly string[];
}

/**
 * Verify every leg, compare them, and write the comparison tree.
 *
 * A leg that does not verify stops the write. Publishing a comparison over a
 * leg whose provenance could not be checked would put a number in the output
 * that nothing stands behind, which is the one thing this tree must not
 * contain.
 */
export function writeComparison(options: WriteComparisonOptions): WriteComparisonOutcome {
  const outDir = options.outDir ?? PORTABILITY_DIR;
  const problems: string[] = [];
  const checked: string[] = [];
  const records: PlatformRecord[] = [];

  if (options.legDirs.length === 0) {
    return {
      dir: outDir,
      comparison: null,
      problems: ['no platform legs were given, so there is nothing to compare'],
      checked,
    };
  }

  for (const legDir of options.legDirs) {
    const outcome = readPlatformLeg(legDir);
    problems.push(...outcome.problems);
    checked.push(...outcome.checked);
    if (outcome.record !== null) records.push(outcome.record);
  }
  if (problems.length > 0) return { dir: outDir, comparison: null, problems, checked };

  const comparison = comparePlatforms(records, options.compare ?? {});

  // Read every leg into memory BEFORE anything is removed. A leg directory is
  // very often the destination subdirectory as well — a local run writes its
  // own leg straight into the comparison tree — so copying in place would
  // delete the source it was about to read.
  const payloads = options.legDirs.map((legDir, i) => {
    const legManifest = JSON.parse(readFileSync(join(legDir, 'manifest.json'), 'utf8')) as PortabilityManifest;
    return {
      platformId: records[i].platformId,
      manifestText: json(legManifest),
      files: legManifest.files.map((entry) => ({
        path: entry.path,
        contents: readFileSync(join(legDir, entry.path), 'utf8'),
      })),
    };
  });

  // The per-platform subdirectories are rebuilt from the legs that were
  // actually read, so the published tree cannot contain a leg the comparison
  // did not use, or omit one it did.
  for (const record of records) {
    rmSync(join(outDir, record.platformId), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const files: ManifestFileEntry[] = [];
  for (const payload of payloads) {
    for (const entry of payload.files) {
      writeFile(outDir, join(payload.platformId, entry.path), entry.contents, files);
    }
    writeFile(outDir, join(payload.platformId, 'manifest.json'), payload.manifestText, files);
  }

  writeFile(outDir, 'comparison.json', json(comparison), files);
  writeFile(outDir, 'comparison.csv', comparisonCsv(comparison), files);
  writeFile(outDir, 'summary.md', comparisonMarkdown(comparison), files);
  writeFile(outDir, 'environments.json', json(environmentsDocument(records)), files);

  const manifest: PortabilityManifest = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    kind: 'comparison',
    platformId: null,
    commit:
      comparison.evaluatedCommit === null
        ? unavailableEnv('commit: the platforms did not agree on one')
        : capturedEnv(comparison.evaluatedCommit),
    startedAtUtc: options.startedAtUtc,
    completedAtUtc: options.completedAtUtc,
    command: options.command,
    files: sortFiles(files),
  };
  writeManifest(outDir, manifest);

  checked.push(`comparison written over ${records.length} platform legs`);
  return { dir: outDir, comparison, problems: [], checked };
}

export interface VerifyPortabilityOutcome {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly problems: readonly string[];
}

/** Fields that must never carry private machine information. */
const PRIVACY_FORBIDDEN = /(?:\/Users\/|\/home\/|C:\\Users\\|\b(?:\d{1,3}\.){3}\d{1,3}\b)/;

/**
 * Re-derive a published comparison tree from the platform legs inside it.
 *
 * Every check here fails on an edit whose SHA-256 was refreshed afterwards,
 * because none of them consults the digest for the answer: the comparison is
 * recomputed from the records, and the two rendered files are re-rendered from
 * the recomputed document.
 */
export function verifyPortabilityDir(dir: string, compare: CompareOptions = {}): VerifyPortabilityOutcome {
  const checked: string[] = [];
  const problems: string[] = [];

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, checked, problems: [`${manifestPath}: missing`] };

  let manifest: PortabilityManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PortabilityManifest;
  } catch (err) {
    return { ok: false, checked, problems: [`${manifestPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (manifest.kind !== 'comparison') {
    problems.push(`manifest kind is ${JSON.stringify(manifest.kind)}, expected "comparison"`);
  }

  for (const entry of manifest.files) {
    const full = join(dir, entry.path);
    if (!existsSync(full)) {
      problems.push(`${entry.path}: listed in the manifest but absent`);
      continue;
    }
    const bytes = readFileSync(full);
    if (nodeSha256Hex(bytes) !== entry.sha256) {
      problems.push(`${entry.path}: sha256 does not match the manifest`);
    }
  }
  checked.push(`manifest hashes match all ${manifest.files.length} listed files`);

  for (const relPath of ['comparison.json', 'comparison.csv', 'summary.md', 'environments.json', 'manifest.json']) {
    if (!existsSync(join(dir, relPath))) problems.push(`${relPath}: required file is missing`);
  }

  for (const relPath of ['manifest.json', ...manifest.files.map((f) => f.path)]) {
    const full = join(dir, relPath);
    if (!existsSync(full)) continue;
    const match = PRIVACY_FORBIDDEN.exec(readFileSync(full, 'utf8'));
    if (match) problems.push(`${relPath} carries a home-directory path or an IP address (${JSON.stringify(match[0])})`);
  }
  checked.push('no home-directory path or IP address in any published file');

  const legs = findPlatformLegs(dir);
  if (legs.length === 0) {
    problems.push('the tree has no platform subdirectory, so the comparison cannot be re-derived');
    return { ok: false, checked, problems };
  }
  const records: PlatformRecord[] = [];
  for (const leg of legs) {
    const outcome = readPlatformLeg(leg);
    problems.push(...outcome.problems);
    if (outcome.record !== null) records.push(outcome.record);
  }
  if (records.length !== legs.length) return { ok: false, checked, problems };
  checked.push(`${legs.length} platform legs verify against their own manifests`);

  const recomputed = comparePlatforms(records, compare);
  let published: PortabilityComparison;
  try {
    published = JSON.parse(readFileSync(join(dir, 'comparison.json'), 'utf8')) as PortabilityComparison;
  } catch (err) {
    problems.push(`comparison.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, checked, problems };
  }

  if (JSON.stringify(published) !== JSON.stringify(recomputed)) {
    problems.push(
      'comparison.json does not re-derive from the platform records in this tree; a verdict, a count or a hash was edited after the comparison ran',
    );
  } else {
    checked.push('comparison.json re-derives from the platform records');
  }

  for (const [relPath, expected] of [
    ['comparison.csv', comparisonCsv(recomputed)],
    ['summary.md', comparisonMarkdown(recomputed)],
  ] as const) {
    const full = join(dir, relPath);
    if (!existsSync(full)) continue;
    if (readFileSync(full, 'utf8') !== expected) {
      problems.push(`${relPath}: does not match what the comparison re-renders to`);
    } else {
      checked.push(`${relPath} matches the re-derived comparison`);
    }
  }

  return { ok: problems.length === 0, checked, problems };
}
