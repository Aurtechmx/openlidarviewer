/**
 * compare.ts
 *
 * Cross-Platform Scientific Reproducibility: does the same commit, over the
 * same seeded fixture, produce identical science-scoped outputs on independently
 * executed platforms.
 *
 * THE NAME IS NARROWER THAN "PLATFORM INDEPENDENCE" ON PURPOSE. What this
 * comparator can establish is a statement about the specific platforms whose
 * records it was handed, on one Node major version, at one commit. Nothing here
 * generalises to an untested platform, and the report says which platforms it
 * covers rather than leaving a reader to assume the set is complete.
 *
 * THE FIXTURE IS COMPARED FIRST, AND ITS FAILURE IS A DIFFERENT FINDING. Every
 * downstream artifact is a function of the seeded source cloud, so a generator
 * that produced different points on two hosts makes every later hash differ as
 * well. Reported in hash order that reads as "the science diverged", which
 * would be wrong: the pipeline may be perfectly reproducible over an input that
 * is not. So the source-cloud hash is checked before anything else and gets its
 * own status, `generator-not-portable`, and the downstream comparison is
 * reported as suppressed rather than run and blamed.
 *
 * WHAT A FIXTURE MISMATCH WOULD MOST LIKELY MEAN. The generator's PRNG is
 * integer arithmetic and exact on any engine; its surface uses `Math.sin`,
 * `Math.cos` and `Math.exp`, which ECMAScript leaves implementation-defined.
 * That is the one place byte-identity rests on the engine rather than on
 * integer arithmetic, and `syntheticCloud.ts` says so in its own header. A
 * fixture mismatch between two hosts running the same V8 is a real portability
 * finding about transcendental functions, to be reported precisely. It is not
 * grounds for loosening the comparison: `scalarTolerance` is zero and there is
 * no code path here that relaxes it.
 *
 * WHAT IS ALLOWED TO DIFFER IS ENUMERATED, NOT DISCARDED. Execution time,
 * memory, CPU model, OS, architecture, Node and V8 metadata, build identity and
 * everything derived from it, timestamps and archive paths all differ between
 * two honest legs. Every one of them is listed in `expectedDifferences` with
 * the values each platform reported, so a reader sees what was excluded rather
 * than trusting that the exclusions were narrow.
 *
 * Pure. No I/O, no clock, no randomness.
 */

import type { PlatformRecord } from './record';
import { FIXTURE_DESCRIPTOR_ARTIFACT, PORTABILITY_SCHEMA_VERSION, SOURCE_CLOUD_ARTIFACT } from './record';
import { SUPPORTED_ENDIANNESS, unsupportedEndiannessReason } from './preconditions';

/**
 * The science-scoped artifacts every platform record must carry.
 *
 * Written out rather than derived from the pipeline's `ARTIFACT_SCOPE`, for two
 * reasons that pull the same way. A comparison that iterates whatever keys
 * happen to be present passes vacuously when a key is absent from both sides,
 * which is exactly the hole a cross-platform check must not have. And this list
 * is the comparator's own statement of what it requires, so an artifact
 * silently dropped from the pipeline shows up here as a missing artifact rather
 * than as a comparison that quietly got smaller. A test asserts this list
 * equals `scienceScopedArtifacts()`, so the two cannot drift unnoticed.
 */
export const REQUIRED_SCIENCE_ARTIFACTS: readonly string[] = [
  'fixture',
  'pointBytes',
  'rasterSummary',
  'rasterZBytes',
  'dtmSummary',
  'dtmZBytes',
  'dtmConfidenceBytes',
  'dtmCoverageBytes',
  'dtmCountsBytes',
  'heightAboveGroundBytes',
  'descriptors',
  'contours',
  'contourFeatures',
  'scientificRecordContent',
  'processingManifestContent',
];

/**
 * Artifacts whose hash tracks the build rather than the science.
 *
 * Listed here so a record that files one of them under `science.hashes` is
 * refused. Promoting a build-scoped hash into the scientific set would make the
 * comparison fail on two honest legs for a reason that is not about
 * reproducibility, and demoting a scientific one would make it pass on legs
 * that disagreed. Both are misclassification, and both are caught.
 */
export const BUILD_SCOPED_ARTIFACTS: readonly string[] = ['scientificRecord', 'processingManifest'];

export type ComparisonStatus =
  /** Two or more platforms, every science-scoped output identical. */
  | 'reproduced'
  /** One platform only. Nothing cross-platform is established. */
  | 'single-platform'
  /** A platform reported a byte order the comparison is not defined for. */
  | 'unsupported-architecture'
  /** The legs are not comparable: different commit, lockfile, config or schema. */
  | 'preconditions-not-met'
  /** The seeded fixture itself differs. Downstream comparison is suppressed. */
  | 'generator-not-portable'
  /** Same fixture, different science. */
  | 'science-diverged';

/** One thing two platforms disagreed about. */
export interface Mismatch {
  readonly kind: 'scienceHash' | 'missingArtifact' | 'scalar' | 'applicationContentHash';
  readonly field: string;
  /** The value each platform reported, keyed by platform id. */
  readonly values: Readonly<Record<string, string>>;
}

/** One category of difference two honest legs are expected to show. */
export interface ExpectedDifference {
  readonly category: 'host' | 'runtime' | 'build-scoped-hash' | 'timing';
  readonly field: string;
  readonly why: string;
  /** What each platform reported. Present only for observed differences. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * A difference the comparison never looks at, named so its absence from the
 * mismatch list is a stated exclusion rather than an omission.
 */
export interface ExcludedFromComparison {
  readonly field: string;
  readonly why: string;
}

export const STRUCTURAL_EXCLUSIONS: readonly ExcludedFromComparison[] = [
  {
    field: 'timestamps',
    why: 'Run start and completion times are wall-clock readings. The framework strips them from every hashed artifact, and they are recorded in each platform manifest rather than compared.',
  },
  {
    field: 'archive paths',
    why: 'Each platform writes into its own results directory and each CI runner has its own workspace root. Paths are relative in every manifest and are not part of any hash.',
  },
  {
    field: 'build identity',
    why: 'The build identity string embeds the commit and the runtime that produced it. The scientific record and the processing manifest are seeded from it, which is why both are build-scoped and compared separately.',
  },
];

export interface FixtureComparison {
  readonly identical: boolean;
  readonly seed: number | null;
  readonly requestedPointCount: number | null;
  readonly generatedPointCount: number | null;
  readonly datasetId: string | null;
  /** SHA-256 of the seeded cloud's coordinate bytes, per platform. */
  readonly sourceCloudHashes: Readonly<Record<string, string | null>>;
  readonly descriptorHashes: Readonly<Record<string, string | null>>;
  readonly mismatches: readonly Mismatch[];
  /** Stated whenever the fixtures differ. See the module header. */
  readonly likelyCause: string | null;
}

export interface ScienceComparison {
  readonly evaluated: boolean;
  /** Why the comparison was not evaluated, when it was not. */
  readonly suppressedReason: string | null;
  readonly hashesCompared: number;
  readonly hashesMismatched: number;
  readonly scalarsCompared: number;
  readonly scalarsMismatched: number;
  readonly mismatches: readonly Mismatch[];
}

export interface PlatformTimingRow {
  readonly platformId: string;
  readonly medianAnalysisMs: number | null;
  readonly medianAnalysisUnavailableReason: string | null;
  readonly analysisCv: number | null;
  readonly analysisCvUnavailableReason: string | null;
  readonly peakRssBytes: number | null;
  readonly peakRssUnavailableReason: string | null;
  readonly recordedRuns: number;
}

export interface PortabilityComparison {
  readonly portabilitySchemaVersion: number;
  readonly status: ComparisonStatus;
  /** True when the command should exit zero. See `claimEstablished` for the claim. */
  readonly ok: boolean;
  /**
   * Whether the cross-platform claim holds on this evidence.
   *
   * Distinct from `ok` on purpose: a single-platform run is a legitimate
   * outcome of the command and establishes nothing across platforms, so it
   * exits zero with this false. Only a `reproduced` status sets it.
   */
  readonly claimEstablished: boolean;
  readonly claim: string;
  readonly platforms: readonly string[];
  readonly evaluatedCommit: string | null;
  readonly lockfileSha256: string | null;
  readonly releaseVersion: string | null;
  readonly scalarTolerance: 0;
  readonly endianness: Readonly<Record<string, string>>;
  readonly preconditionFailures: readonly string[];
  readonly fixture: FixtureComparison;
  readonly science: ScienceComparison;
  readonly expectedDifferences: readonly ExpectedDifference[];
  readonly structuralExclusions: readonly ExcludedFromComparison[];
  readonly timing: readonly PlatformTimingRow[];
}

export interface CompareOptions {
  /**
   * Platform ids that must be present.
   *
   * Empty by default, which is what makes a local single-platform run report
   * itself honestly instead of failing. CI sets it to both legs, so a missing
   * leg fails the job rather than silently producing a one-platform comparison
   * that reads like a cross-platform result.
   */
  readonly requirePlatforms?: readonly string[];
}

/** The exact wording the report carries, built from what was actually compared. */
function claimFor(status: ComparisonStatus, platforms: readonly string[], commit: string | null): string {
  const where = platforms.join(' and ');
  const at = commit === null ? 'an unrecorded commit' : `commit ${commit.slice(0, 7)}`;
  switch (status) {
    case 'reproduced':
      return `At ${at}, OpenLiDARViewer produced identical science-scoped artifacts from the same seeded fixture on ${where}. Build-scoped provenance and execution timing differed, as expected. Nothing is claimed for platforms not in that list.`;
    case 'single-platform':
      return `Only ${where} was recorded, so this run establishes single-platform reproducibility and nothing cross-platform. The cross-platform claim remains unestablished until a second platform's leg exists.`;
    case 'generator-not-portable':
      return `The seeded fixture itself differs between ${where}, so the source cloud is not byte-identical across these platforms and no downstream comparison is meaningful. This is a finding about the generator, not about the analysis pipeline.`;
    case 'science-diverged':
      return `The seeded fixture matched across ${where}, but at least one science-scoped output did not. Cross-platform scientific reproducibility does not hold on this evidence.`;
    case 'unsupported-architecture':
      return 'A platform reported a byte order this comparison is not defined for. Cross-platform reproducibility is claimed for little-endian platforms only.';
    case 'preconditions-not-met':
      return 'The recorded legs are not comparable — they differ in commit, lockfile, configuration or schema, or one failed its own reproducibility check. No cross-platform claim follows.';
  }
}

function envText(value: { readonly status: string; readonly value: string | null }): string {
  return value.status === 'captured' && value.value !== null ? value.value : 'unavailable';
}

function scalarText(value: unknown): string {
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

/** Every distinct value a field took across the records, keyed by platform. */
function valuesOf(
  records: readonly PlatformRecord[],
  read: (r: PlatformRecord) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of records) out[r.platformId] = read(r);
  return out;
}

function allAgree(values: Readonly<Record<string, string>>): boolean {
  const seen = Object.values(values);
  return seen.every((v) => v === seen[0]);
}

export function comparePlatforms(
  records: readonly PlatformRecord[],
  options: CompareOptions = {},
): PortabilityComparison {
  if (records.length === 0) {
    throw new Error('benchmark portability: a comparison needs at least one platform record');
  }
  // Sorted so two invocations over the same inputs in a different order produce
  // byte-identical output. The comparison itself is order-independent; the
  // report should be too.
  const sorted = [...records].sort((a, b) => (a.platformId < b.platformId ? -1 : a.platformId > b.platformId ? 1 : 0));
  const platforms = sorted.map((r) => r.platformId);

  const duplicates = platforms.filter((id, i) => platforms.indexOf(id) !== i);
  const preconditionFailures: string[] = [];
  for (const id of [...new Set(duplicates)]) {
    preconditionFailures.push(`platform ${id} appears more than once; each platform contributes exactly one leg`);
  }

  for (const id of options.requirePlatforms ?? []) {
    if (!platforms.includes(id)) {
      preconditionFailures.push(`required platform ${id} is absent from this comparison`);
    }
  }

  // ── byte order ────────────────────────────────────────────────────────────
  const endianness: Record<string, string> = {};
  let unsupportedArchitecture = false;
  for (const r of sorted) {
    endianness[r.platformId] = r.environment.endianness;
    if (r.environment.endianness !== SUPPORTED_ENDIANNESS) {
      unsupportedArchitecture = true;
      preconditionFailures.push(unsupportedEndiannessReason(r.platformId, r.environment.endianness));
    }
  }

  // ── schema, commit, lockfile, configuration ───────────────────────────────
  const schemaValues = valuesOf(sorted, (r) => `${r.portabilitySchemaVersion}/${r.benchmarkSchemaVersion}`);
  if (!allAgree(schemaValues)) {
    preconditionFailures.push(
      `platform records were written by different schema versions: ${describeValues(schemaValues)}`,
    );
  }
  for (const r of sorted) {
    if (r.portabilitySchemaVersion !== PORTABILITY_SCHEMA_VERSION) {
      preconditionFailures.push(
        `${r.platformId} carries portability schema version ${String(r.portabilitySchemaVersion)}, this comparator writes ${PORTABILITY_SCHEMA_VERSION}`,
      );
    }
  }

  const commitValues = valuesOf(sorted, (r) => envText(r.evaluated.commit));
  if (!allAgree(commitValues)) {
    preconditionFailures.push(`platforms did not evaluate the same commit: ${describeValues(commitValues)}`);
  }
  const lockValues = valuesOf(sorted, (r) => envText(r.evaluated.lockfileSha256));
  if (!allAgree(lockValues)) {
    preconditionFailures.push(`platforms did not install from the same lockfile: ${describeValues(lockValues)}`);
  }
  const treeValues = valuesOf(sorted, (r) => envText(r.evaluated.workingTree));
  for (const [id, value] of Object.entries(treeValues)) {
    if (value !== 'clean') {
      preconditionFailures.push(
        `${id} ran from a ${value} working tree, so its commit does not describe what was executed`,
      );
    }
  }
  const configValues = valuesOf(sorted, (r) => JSON.stringify(r.evaluated.config));
  if (!allAgree(configValues)) {
    preconditionFailures.push('platforms ran different suite configurations (seed, point count, run counts or terrain parameters)');
  }
  const packageValues = valuesOf(sorted, (r) => r.evaluated.benchmarkPackageVersion);
  if (!allAgree(packageValues)) {
    preconditionFailures.push(`platforms ran different benchmark package versions: ${describeValues(packageValues)}`);
  }
  for (const r of sorted) {
    if (r.evaluated.config.scalarTolerance !== 0) {
      preconditionFailures.push(`${r.platformId} recorded a non-zero scalar tolerance; scientific tolerance is exactly zero`);
    }
  }

  // ── each platform's own reproducibility check ─────────────────────────────
  for (const r of sorted) {
    if (!r.internal.pass) {
      preconditionFailures.push(
        `${r.platformId} failed its own reproducibility check (${r.internal.failures.length} failures), so its outputs do not represent that platform`,
      );
    }
    if (r.internal.recordedRuns !== r.evaluated.config.recordedRuns) {
      preconditionFailures.push(
        `${r.platformId} recorded ${r.internal.recordedRuns} runs, its configuration says ${r.evaluated.config.recordedRuns}`,
      );
    }
    if (!r.internal.manifestVerifiedOnEveryRun) {
      preconditionFailures.push(`${r.platformId} has a run whose processing manifest did not verify`);
    }
    for (const name of BUILD_SCOPED_ARTIFACTS) {
      if (name in r.science.hashes) {
        preconditionFailures.push(
          `${r.platformId} files the build-scoped artifact ${name} under its scientific hashes; a build-scoped hash tracks the commit and the runtime, not the science`,
        );
      }
    }
    for (const name of REQUIRED_SCIENCE_ARTIFACTS) {
      if (!(name in r.science.hashes)) {
        preconditionFailures.push(`${r.platformId} is missing the required science-scoped artifact ${name}`);
      }
    }
  }

  // ── the fixture, before anything downstream of it ─────────────────────────
  const fixture = compareFixture(sorted);

  // ── the science ───────────────────────────────────────────────────────────
  const blocked = preconditionFailures.length > 0 || unsupportedArchitecture;
  const science = blocked
    ? suppressed('the legs are not comparable, so a hash comparison between them would not be interpretable')
    : !fixture.identical
      ? suppressed(
          'the seeded fixture differs between platforms, so every downstream artifact differs as a consequence; reporting those as scientific divergence would name the wrong finding',
        )
      : compareScience(sorted);

  const status: ComparisonStatus = unsupportedArchitecture
    ? 'unsupported-architecture'
    : preconditionFailures.length > 0
      ? 'preconditions-not-met'
      : !fixture.identical
        ? 'generator-not-portable'
        : sorted.length < 2
          ? 'single-platform'
          : science.mismatches.length > 0
            ? 'science-diverged'
            : 'reproduced';

  const commit = sorted[0].evaluated.commit;
  const evaluatedCommit = allAgree(commitValues) && commit.status === 'captured' ? commit.value : null;

  return {
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    status,
    ok: status === 'reproduced' || status === 'single-platform',
    claimEstablished: status === 'reproduced',
    claim: claimFor(status, platforms, evaluatedCommit),
    platforms,
    evaluatedCommit,
    lockfileSha256: allAgree(lockValues) ? envText(sorted[0].evaluated.lockfileSha256) : null,
    releaseVersion: envText(sorted[0].evaluated.releaseVersion),
    scalarTolerance: 0,
    endianness,
    preconditionFailures,
    fixture,
    science,
    expectedDifferences: expectedDifferencesOf(sorted),
    structuralExclusions: STRUCTURAL_EXCLUSIONS,
    timing: sorted.map(timingRow),
  };
}

function describeValues(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([id, v]) => `${id}=${v}`)
    .join(', ');
}

function suppressed(reason: string): ScienceComparison {
  return {
    evaluated: false,
    suppressedReason: reason,
    hashesCompared: 0,
    hashesMismatched: 0,
    scalarsCompared: 0,
    scalarsMismatched: 0,
    mismatches: [],
  };
}

function compareFixture(records: readonly PlatformRecord[]): FixtureComparison {
  const sourceCloudHashes: Record<string, string | null> = {};
  const descriptorHashes: Record<string, string | null> = {};
  for (const r of records) {
    sourceCloudHashes[r.platformId] = r.fixture.sourceCloudHash;
    descriptorHashes[r.platformId] = r.fixture.descriptorHash;
  }

  const mismatches: Mismatch[] = [];
  const first = records[0].fixture;

  const scalarFields: readonly [string, (r: PlatformRecord) => unknown][] = [
    ['seed', (r) => r.fixture.seed],
    ['requestedPointCount', (r) => r.fixture.requestedPointCount],
    ['generatedPointCount', (r) => r.fixture.generatedPointCount],
    ['datasetId', (r) => r.fixture.datasetId],
    ['config.seed', (r) => r.evaluated.config.seed],
    ['config.pointCount', (r) => r.evaluated.config.pointCount],
  ];
  for (const [field, read] of scalarFields) {
    const values = valuesOf(records, (r) => scalarText(read(r)));
    if (!allAgree(values)) mismatches.push({ kind: 'scalar', field, values });
  }

  for (const [field, bag] of [
    [SOURCE_CLOUD_ARTIFACT, sourceCloudHashes],
    [FIXTURE_DESCRIPTOR_ARTIFACT, descriptorHashes],
  ] as const) {
    const values: Record<string, string> = {};
    let missing = false;
    for (const r of records) {
      const hash = bag[r.platformId];
      if (hash === null) missing = true;
      values[r.platformId] = hash ?? 'absent';
    }
    if (missing) mismatches.push({ kind: 'missingArtifact', field, values });
    else if (!allAgree(values)) mismatches.push({ kind: 'scienceHash', field, values });
  }

  const identical = mismatches.length === 0;
  return {
    identical,
    seed: first.seed,
    requestedPointCount: first.requestedPointCount,
    generatedPointCount: first.generatedPointCount,
    datasetId: first.datasetId,
    sourceCloudHashes,
    descriptorHashes,
    mismatches,
    likelyCause: identical
      ? null
      : 'The generator drives an integer PRNG, which is exact on any engine, but its surface uses Math.sin, Math.cos and Math.exp, which ECMAScript leaves implementation-defined. A fixture that differs across hosts is a portability finding about those functions, not a reason to widen the comparison.',
  };
}

function compareScience(records: readonly PlatformRecord[]): ScienceComparison {
  const mismatches: Mismatch[] = [];

  const names = [
    ...new Set([...REQUIRED_SCIENCE_ARTIFACTS, ...records.flatMap((r) => Object.keys(r.science.hashes))]),
  ].sort();
  for (const name of names) {
    const values: Record<string, string> = {};
    let missing = false;
    for (const r of records) {
      const hash = r.science.hashes[name];
      if (hash === undefined) missing = true;
      values[r.platformId] = hash ?? 'absent';
    }
    if (missing) mismatches.push({ kind: 'missingArtifact', field: name, values });
    else if (!allAgree(values)) mismatches.push({ kind: 'scienceHash', field: name, values });
  }

  // Read through `unknown`: RunScalars is a closed interface with no index
  // signature, and the comparison must iterate whatever keys the records
  // actually carry rather than the keys this file was compiled against — a
  // scalar added to the pipeline must be compared, not skipped.
  const scalarsOf = (r: PlatformRecord): Record<string, unknown> =>
    r.science.scalars as unknown as Record<string, unknown>;
  const scalarKeys = [...new Set(records.flatMap((r) => Object.keys(scalarsOf(r))))].sort();
  for (const key of scalarKeys) {
    // Object.is, matching the single-platform suite: it separates a genuine
    // null from a NaN and does not equate +0 with -0.
    const raw = records.map((r) => scalarsOf(r)[key]);
    const values = valuesOf(records, (r) => scalarText(scalarsOf(r)[key]));
    if (!raw.every((v) => Object.is(v, raw[0]))) {
      mismatches.push({ kind: 'scalar', field: key, values });
    }
  }

  const contentValues = valuesOf(records, (r) => r.science.applicationContentHash ?? 'absent');
  if (!allAgree(contentValues)) {
    mismatches.push({ kind: 'applicationContentHash', field: 'applicationContentHash', values: contentValues });
  }

  return {
    evaluated: true,
    suppressedReason: null,
    hashesCompared: names.length,
    hashesMismatched: mismatches.filter((m) => m.kind === 'scienceHash' || m.kind === 'missingArtifact').length,
    scalarsCompared: scalarKeys.length,
    scalarsMismatched: mismatches.filter((m) => m.kind === 'scalar').length,
    mismatches,
  };
}

/** Every allowed difference the records actually show, with both sides' values. */
function expectedDifferencesOf(records: readonly PlatformRecord[]): ExpectedDifference[] {
  const out: ExpectedDifference[] = [];
  const add = (
    category: ExpectedDifference['category'],
    field: string,
    why: string,
    read: (r: PlatformRecord) => string,
  ): void => {
    const values = valuesOf(records, read);
    if (!allAgree(values)) out.push({ category, field, why, values });
  };

  add('host', 'os', 'The operating system and its release are properties of the host, not of the analysis.', (r) => envText(r.environment.os));
  add('host', 'arch', 'The instruction set is a property of the host. Byte order is the part that must match, and it is checked as a precondition.', (r) => envText(r.environment.arch));
  add('host', 'cpuModel', 'The CPU model changes timing and nothing else; every science-scoped value is deterministic arithmetic.', (r) => envText(r.environment.cpuModel));
  add('host', 'logicalCpuCount', 'Core count is a property of the runner. The pipeline is single-threaded here.', (r) => envText(r.environment.logicalCpuCount));
  add('host', 'totalMemoryBytes', 'Installed memory is a property of the runner.', (r) => envText(r.environment.totalMemoryBytes));
  add('host', 'loadAverage', 'Host load at the moment of writing. It moves the timing column and nothing else.', (r) => envText(r.environment.loadAverage));
  add('runtime', 'nodeVersion', 'Node patch metadata differs between runner images. The major version is pinned by the workflow.', (r) => envText(r.environment.nodeVersion));
  add('runtime', 'v8Version', 'V8 supplies the transcendental functions the generator uses. Recorded because a difference here is the first thing to check if the fixture ever stops matching.', (r) => envText(r.environment.v8Version));
  add('runtime', 'npmVersion', 'The npm version does not affect an installed tree that came from the committed lockfile.', (r) => envText(r.environment.npmVersion));

  const buildNames = [...new Set(records.flatMap((r) => Object.keys(r.buildScopedHashes)))].sort();
  for (const name of buildNames) {
    add(
      'build-scoped-hash',
      name,
      'This artifact embeds the build identity, which carries the commit and the runtime that produced it. Two platforms are expected to differ here and it says nothing about the science.',
      (r) => r.buildScopedHashes[name] ?? 'absent',
    );
  }

  add('timing', 'medianAnalysisMs', 'Execution time is a property of the machine. Reported per platform and never pooled.', (r) =>
    r.timing.medianAnalysisMs.value === null ? 'unavailable' : String(r.timing.medianAnalysisMs.value),
  );
  add('timing', 'peakRssBytes', 'Memory high-water observations track the allocator and the host, not the outputs.', (r) =>
    r.timing.peakRssBytes.value === null ? 'unavailable' : String(r.timing.peakRssBytes.value),
  );

  return out;
}

function timingRow(r: PlatformRecord): PlatformTimingRow {
  return {
    platformId: r.platformId,
    medianAnalysisMs: r.timing.medianAnalysisMs.value,
    medianAnalysisUnavailableReason: r.timing.medianAnalysisMs.reason,
    analysisCv: r.timing.analysisCv.value,
    analysisCvUnavailableReason: r.timing.analysisCv.reason,
    peakRssBytes: r.timing.peakRssBytes.value,
    peakRssUnavailableReason: r.timing.peakRssBytes.reason,
    recordedRuns: r.internal.recordedRuns,
  };
}
