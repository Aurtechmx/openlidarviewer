/**
 * record.ts
 *
 * One platform's leg of the cross-platform comparison, reduced to the record
 * the comparator reads.
 *
 * WHY A SEPARATE RECORD RATHER THAN THE WHOLE RESULT TREE. The comparator's
 * inputs are what decide whether the published finding is honest, so they are
 * named in one place and nowhere else. A comparator handed two `raw.json` files
 * would be free to reach for any field in them, and the difference between a
 * science-scoped hash and a build-scoped one — the whole distinction the claim
 * rests on — would live in whichever line of the comparator happened to touch
 * it. Here the record itself is sorted into four blocks: what must match
 * exactly, what is compared first, what is expected to differ, and what is
 * summarised per platform and never pooled.
 *
 * EVERY FIELD IS DERIVED FROM A RECORDED RUN. Nothing on this record is entered
 * by hand or defaulted. A field the run did not produce is `null` next to the
 * reason it is null, in the same shape the rest of the framework uses.
 *
 * Pure data + a builder over an already-completed suite result. No I/O, no
 * clock.
 */

import type { EnvValue } from '../framework';
import type { ReproducibilityConfig } from '../runner/config';
import type { RunScalars } from '../runner/observe';
import type { ReproducibilityRaw, ReproducibilitySummary } from '../runner/reproducibility';
import { SERIES_ANALYSIS_MS, SERIES_PEAK_RSS_BYTES, SERIES_PIPELINE_TOTAL_MS } from '../runner/series';
import type { Endianness } from './preconditions';

/** Bumped when any field below changes meaning. Mixed versions never compare. */
export const PORTABILITY_SCHEMA_VERSION = 1;

/** The artifact carrying the seeded source cloud itself, compared first. */
export const SOURCE_CLOUD_ARTIFACT = 'pointBytes';
/** The artifact carrying the generator's own description of that cloud. */
export const FIXTURE_DESCRIPTOR_ARTIFACT = 'fixture';

/**
 * The host block. Everything here is ALLOWED to differ between platforms and is
 * reported as an expected difference rather than dropped.
 */
export interface PlatformEnvironment {
  readonly platformId: string;
  readonly endianness: Endianness;
  readonly os: EnvValue;
  readonly arch: EnvValue;
  readonly cpuModel: EnvValue;
  readonly logicalCpuCount: EnvValue;
  readonly totalMemoryBytes: EnvValue;
  readonly loadAverage: EnvValue;
  readonly nodeVersion: EnvValue;
  readonly npmVersion: EnvValue;
  /** V8's own version, which is what actually supplies `Math.sin`. */
  readonly v8Version: EnvValue;
}

/**
 * What every platform must agree on before its outputs are comparable at all.
 *
 * A commit or a lockfile that differs makes a hash comparison meaningless: two
 * platforms would be running two programs. These are checked before any science
 * is looked at, so the report never says "the science diverged" about two
 * different programs agreeing to disagree.
 */
export interface EvaluatedIdentity {
  readonly commit: EnvValue;
  readonly commitShort: EnvValue;
  readonly workingTree: EnvValue;
  readonly releaseVersion: EnvValue;
  /** SHA-256 of the committed `package-lock.json` as the run resolved it. */
  readonly lockfileSha256: EnvValue;
  readonly config: ReproducibilityConfig;
  readonly benchmarkPackageVersion: string;
}

/** The generator's output, compared before anything downstream of it. */
export interface FixtureIdentity {
  readonly datasetId: string;
  readonly seed: number;
  readonly requestedPointCount: number;
  readonly generatedPointCount: number | null;
  /** SHA-256 of the seeded cloud's raw coordinate bytes. */
  readonly sourceCloudHash: string | null;
  /** SHA-256 of the generator's own descriptor of that cloud. */
  readonly descriptorHash: string | null;
}

/** The scientific outputs, all of which must match exactly. */
export interface ScienceIdentity {
  /** Science-scoped artifact hashes, keyed by artifact name. */
  readonly hashes: Readonly<Record<string, string>>;
  readonly scalars: RunScalars;
  /** The application's own content hash, taken over the science alone. */
  readonly applicationContentHash: string | null;
}

/** This platform's own reproducibility verdict, before any comparison. */
export interface InternalCheck {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly scienceHashesStable: boolean;
  readonly scalarsStable: boolean;
  readonly manifestVerifiedOnEveryRun: boolean;
  readonly recordedRuns: number;
  readonly warmupRunsCompleted: number;
}

/** A statistic that was taken, or the reason it was not. */
export interface PlatformStatistic {
  readonly value: number | null;
  readonly unit: string | null;
  readonly reason: string | null;
}

/**
 * Timing and memory, summarised PER PLATFORM and never pooled.
 *
 * Two platforms' runtimes are two samples from two machines. A median over the
 * union of them describes no machine that exists, and the question this suite
 * answers is whether the outputs are identical, not which host is faster. The
 * comparator has no code path that combines these.
 */
export interface PlatformTiming {
  readonly medianAnalysisMs: PlatformStatistic;
  readonly analysisCv: PlatformStatistic;
  readonly medianPipelineTotalMs: PlatformStatistic;
  readonly peakRssBytes: PlatformStatistic;
}

export interface PlatformRecord {
  readonly portabilitySchemaVersion: number;
  readonly benchmarkSchemaVersion: number;
  readonly platformId: string;
  readonly environment: PlatformEnvironment;
  readonly evaluated: EvaluatedIdentity;
  readonly fixture: FixtureIdentity;
  readonly science: ScienceIdentity;
  /** Reported as expected differences. Never a pass condition. */
  readonly buildScopedHashes: Readonly<Record<string, string>>;
  readonly internal: InternalCheck;
  readonly timing: PlatformTiming;
}

function statisticFrom(
  summary: ReproducibilitySummary,
  key: string,
  field: 'median' | 'cv' | 'max',
  unit: string,
): PlatformStatistic {
  const block = summary.timing.available.find((b) => b.key === key);
  if (!block) {
    const missing = summary.timing.unavailable.find((b) => b.key === key);
    return {
      value: null,
      unit: null,
      reason: missing?.reason ?? `series ${key} was not recorded on this platform`,
    };
  }
  const value = block.summary[field];
  if (value === null) {
    return {
      value: null,
      unit: null,
      reason: block.summary.unavailable[field] ?? `${field} of ${key} was not computed`,
    };
  }
  // The coefficient of variation is a ratio, so it carries no unit of its own —
  // and the schema forbids a measured quantity without one, which is why the
  // unit is named here rather than left blank.
  return { value, unit, reason: null };
}

export interface BuildPlatformRecordOptions {
  readonly platformId: string;
  readonly endianness: Endianness;
  readonly environment: Omit<PlatformEnvironment, 'platformId' | 'endianness'>;
  readonly commit: EnvValue;
  readonly commitShort: EnvValue;
  readonly workingTree: EnvValue;
  readonly releaseVersion: EnvValue;
  readonly lockfileSha256: EnvValue;
  readonly benchmarkPackageVersion: string;
  readonly raw: ReproducibilityRaw;
  readonly summary: ReproducibilitySummary;
}

/**
 * Reduce a completed reproducibility run to one platform's record.
 *
 * Run 1 is the reference for the hashes and the scalars, which is the same
 * reference the reproducibility suite itself compared the other nine against —
 * so a record whose `internal.pass` is true carries values every run on that
 * platform agreed on, and one whose `internal.pass` is false carries run 1's
 * values next to the failures that make them unrepresentative.
 */
export function buildPlatformRecord(options: BuildPlatformRecordOptions): PlatformRecord {
  const { raw, summary } = options;
  const reference = raw.runs[0]?.observation ?? null;
  if (reference === null) {
    throw new Error('benchmark portability: the reproducibility suite recorded no runs');
  }

  return {
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    benchmarkSchemaVersion: summary.schemaVersion,
    platformId: options.platformId,
    environment: {
      platformId: options.platformId,
      endianness: options.endianness,
      ...options.environment,
    },
    evaluated: {
      commit: options.commit,
      commitShort: options.commitShort,
      workingTree: options.workingTree,
      releaseVersion: options.releaseVersion,
      lockfileSha256: options.lockfileSha256,
      config: raw.config,
      benchmarkPackageVersion: options.benchmarkPackageVersion,
    },
    fixture: {
      datasetId: reference.datasetId,
      seed: reference.seed,
      requestedPointCount: reference.requestedPointCount,
      generatedPointCount: reference.generatedPointCount,
      sourceCloudHash: reference.scienceHashes[SOURCE_CLOUD_ARTIFACT] ?? null,
      descriptorHash: reference.scienceHashes[FIXTURE_DESCRIPTOR_ARTIFACT] ?? null,
    },
    science: {
      hashes: summary.identity.referenceScienceHashes,
      scalars: reference.scalars,
      applicationContentHash: summary.identity.applicationContentHash,
    },
    buildScopedHashes: summary.identity.referenceBuildScopedHashes,
    internal: {
      pass: summary.pass,
      failures: summary.failures,
      scienceHashesStable: summary.identity.scienceHashesStable,
      scalarsStable: summary.identity.scalarsStable,
      manifestVerifiedOnEveryRun: summary.identity.manifestVerifiedOnEveryRun,
      recordedRuns: summary.runCount,
      warmupRunsCompleted: raw.warmupRunsCompleted,
    },
    timing: {
      medianAnalysisMs: statisticFrom(summary, SERIES_ANALYSIS_MS, 'median', 'ms'),
      analysisCv: statisticFrom(summary, SERIES_ANALYSIS_MS, 'cv', 'ratio'),
      medianPipelineTotalMs: statisticFrom(summary, SERIES_PIPELINE_TOTAL_MS, 'median', 'ms'),
      peakRssBytes: statisticFrom(summary, SERIES_PEAK_RSS_BYTES, 'max', 'bytes'),
    },
  };
}
