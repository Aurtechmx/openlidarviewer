/**
 * loaderComparison.ts
 *
 * Benchmark 3: OLV's own loader against a standard web point-cloud loader on
 * identical files.
 *
 * THE CLAIM AND ITS SHAPE. Two cases, each a deterministically generated
 * uncompressed LAS file: one LAS 1.2 the competitor reads, one LAS 1.4 it
 * refuses. Each case is decoded `recordedRuns` times after `warmupRuns`
 * warm-ups, and every run records OLV's wall-clock, the competitor's wall-clock
 * where it applies, and their ratio. The pass condition is about CORRECTNESS,
 * not speed: OLV must decode the file, and the competitor must behave as the
 * case declares — read the 1.2, refuse the 1.4. A competitor that suddenly
 * reads a file it should refuse, or refuses one it should read, fails the suite,
 * because the capability split is a measured result the numbers rest on.
 *
 * WHY TIMINGS DO NOT GATE. On one machine over one input this is a wall-clock
 * race, and a race is summarised and summarised only — a threshold here would
 * turn a slow CI runner into a red build for a reason that is not about the
 * software. The medians and the coefficient of variation are published so a
 * reader can see the spread; nothing depends on them.
 *
 * WHY THE COMPETITOR IS INJECTED. Every module under `benchmarks/` may import
 * only `node:` builtins and repo-relative paths, so a bare `@loaders.gl/las`
 * import here would fail the source guard and break the browser barrel. The
 * decoder is therefore passed in by the Node entry point (which lives outside
 * the guarded tree) as a {@link CompetitorProbe}; this module never names the
 * competitor package, and records the version the entry point captured. Absent
 * a probe the OLV column is still measured and the competitor column is reported
 * unavailable with the reason — never a fabricated number.
 *
 * Strictly sequential: two decodes sharing a core would make every duration a
 * measurement of the scheduler.
 */

import { writeLas, writeLas14 } from '../../src/convert/writeLas';
import type { GlobalPoints } from '../../src/convert/globalPoints';
import { loadLas } from '../../src/io/loadLas';
import { generateSyntheticCloud } from '../fixtures/syntheticCloud';
import { readMonotonicNs } from '../framework/clock';
import {
  BENCHMARK_PACKAGE_VERSION,
  BENCHMARK_SCHEMA_VERSION,
  type LoaderCase,
  type LoaderComparisonConfig,
} from './config';
import {
  SERIES_COMPETITOR_LOAD_MS,
  SERIES_LOADER_SPEEDUP,
  SERIES_OLV_LOAD_MS,
  type RunSeries,
} from './series';
import { QUANTILE_CONVENTION } from './stats';
import { summariseRuns, type SummarisedSeries } from './summarise';

/** A version string used when the entry point could not read the competitor's. */
export const COMPETITOR_VERSION_UNAVAILABLE = 'unavailable';

/**
 * The competitor decoder, injected from outside the guarded tree.
 *
 * `decode` resolves with the point count it read, or THROWS when it cannot read
 * the file — which is exactly the signal a capability-gap case is checking for.
 * The buffer is shared across runs and must be read, not mutated or transferred;
 * a decoder that detaches it fails its next call rather than corrupting a run.
 */
export interface CompetitorProbe {
  readonly name: string;
  readonly version: string;
  decode(buffer: ArrayBuffer): Promise<number>;
}

export interface LoaderComparisonOptions {
  /** The competitor decoder. Absent ⇒ the competitor column is unavailable. */
  readonly competitor?: CompetitorProbe;
  /** Injected monotonic clock, for a deterministic timing test. */
  readonly nowNs?: () => bigint | null;
}

/**
 * What the competitor did on a case.
 *
 * `measured` and `rejected-as-expected` are the two healthy outcomes; the other
 * three are recorded verbatim, and `unexpectedly-read` and `error` fail the
 * case because the competitor contradicted the capability the case declares.
 */
export type CompetitorStatus =
  | 'measured'
  | 'rejected-as-expected'
  | 'unexpectedly-read'
  | 'error'
  | 'probe-absent';

export interface LoaderCaseRunRecord {
  readonly index: number;
  readonly olvLoadMs: number;
  readonly olvPointCount: number;
  readonly competitorLoadMs: number | null;
  readonly competitorPointCount: number | null;
  readonly series: RunSeries;
}

export interface LoaderCaseResult {
  readonly case: LoaderCase;
  readonly status: 'ok' | 'failed';
  readonly failureReason: string | null;
  readonly warmupRunsCompleted: number;
  readonly fixtureBytes: number;
  readonly olvPointCount: number | null;
  readonly competitorStatus: CompetitorStatus;
  readonly competitorPointCount: number | null;
  /** The competitor's message when it refused the file, verbatim. */
  readonly competitorRejectionMessage: string | null;
  readonly runs: readonly LoaderCaseRunRecord[];
  readonly series: SummarisedSeries;
}

export interface LoaderComparisonRaw {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'loaderComparison';
  readonly quantileConvention: string;
  readonly config: LoaderComparisonConfig;
  /** The competitor library version the entry point captured, or 'unavailable'. */
  readonly competitorVersion: string;
  readonly cases: readonly LoaderCaseResult[];
}

export interface LoaderCaseSummary {
  readonly id: string;
  readonly lasVersion: '1.2' | '1.4';
  readonly requestedPointCount: number;
  readonly status: 'ok' | 'failed';
  readonly failureReason: string | null;
  readonly runCount: number;
  readonly fixtureBytes: number;
  readonly olvPointCount: number | null;
  readonly competitorReadable: boolean;
  readonly competitorStatus: CompetitorStatus;
  readonly competitorPointCount: number | null;
  readonly competitorRejectionMessage: string | null;
  readonly series: SummarisedSeries;
}

export interface LoaderComparisonSummary {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'loaderComparison';
  readonly quantileConvention: string;
  readonly config: LoaderComparisonConfig;
  readonly competitorVersion: string;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly cases: readonly LoaderCaseSummary[];
}

export interface LoaderComparisonResult {
  readonly raw: LoaderComparisonRaw;
  readonly summary: LoaderComparisonSummary;
}

/**
 * The fixture's backing ArrayBuffer, shared across every run and both loaders.
 *
 * Neither `loadLas` (which reads through a DataView) nor loaders.gl's LASLoader
 * detaches its input, so one buffer serves every decode with no per-run copy —
 * the fixture at 1M points is tens of megabytes, and copying it per run per
 * loader was pure allocator churn. A future loader that DID transfer the buffer
 * would fail its next decode visibly (a thrown "detached ArrayBuffer"), which
 * the case records as an error rather than a silently corrupted run.
 */
function bufferOf(fixture: Uint8Array): ArrayBuffer {
  return fixture.buffer as ArrayBuffer;
}

/** Deterministic classification codes cycled across the cloud (ASPRS 2/3/4/5/6). */
const CLASSIFICATIONS = [2, 3, 4, 5, 6];

/**
 * The deterministic LAS bytes for a case, from the seeded synthetic cloud.
 *
 * The cloud is given a FULL attribute set — intensity, returns, classification,
 * point-source id, GPS time and RGB — so the writer emits point format 3 (LAS
 * 1.2) or 7 (LAS 1.4), the attribute-rich records real airborne LiDAR ships. A
 * bare XYZ file (format 0) would let OLV skip attribute decode the competitor
 * still does and flatter the ratio; a representative comparison decodes what a
 * real file carries. The attributes are derived from the point index, not a
 * random source, so the bytes stay reproducible (the source guard bans
 * `Math.random` here regardless).
 */
function buildFixture(seed: number, c: LoaderCase): Uint8Array {
  const cloud = generateSyntheticCloud({ seed, pointCount: c.pointCount });
  const n = cloud.pointCount;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const classification = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  const gpsTime = new Float64Array(n);
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    x[i] = cloud.positions[i * 3];
    y[i] = cloud.positions[i * 3 + 1];
    z[i] = cloud.positions[i * 3 + 2];
    intensity[i] = (i * 37) & 0xffff;
    const rc = (i % 3) + 1;
    returnCount[i] = rc;
    returnNumber[i] = (i % rc) + 1;
    classification[i] = CLASSIFICATIONS[i % CLASSIFICATIONS.length];
    pointSourceId[i] = 1;
    gpsTime[i] = 100000 + i * 1e-4;
    colors[i * 3] = i & 0xff;
    colors[i * 3 + 1] = (i >> 8) & 0xff;
    colors[i * 3 + 2] = (i >> 16) & 0xff;
  }
  const points: GlobalPoints = {
    count: n,
    x,
    y,
    z,
    intensity,
    returnNumber,
    returnCount,
    classification,
    pointSourceId,
    gpsTime,
    colors,
  };
  return c.lasVersion === '1.4' ? writeLas14(points) : writeLas(points);
}

/** Time an async decode against the monotonic clock, in milliseconds. */
async function timeMs(nowNs: () => bigint | null, decode: () => Promise<void>): Promise<number> {
  const start = nowNs();
  await decode();
  const end = nowNs();
  if (start === null || end === null) {
    throw new Error('the monotonic clock is unavailable, so no loader duration could be measured');
  }
  return Number(end - start) / 1e6;
}

async function decodeOlv(fixture: Uint8Array): Promise<number> {
  const cloud = await loadLas(bufferOf(fixture), 'las', 'benchmark.las');
  return cloud.decodedPointCount ?? cloud.pointCount;
}

/** One recorded run: OLV always, the competitor when the case says it can read. */
async function recordRun(
  index: number,
  fixture: Uint8Array,
  c: LoaderCase,
  probe: CompetitorProbe | null,
  nowNs: () => bigint | null,
): Promise<{ record: LoaderCaseRunRecord; competitorError: string | null }> {
  let olvPointCount = 0;
  const olvLoadMs = await timeMs(nowNs, async () => {
    olvPointCount = await decodeOlv(fixture);
  });

  let competitorLoadMs: number | null = null;
  let competitorPointCount: number | null = null;
  let competitorError: string | null = null;
  if (probe && c.competitorReadable) {
    try {
      competitorLoadMs = await timeMs(nowNs, async () => {
        competitorPointCount = await probe.decode(bufferOf(fixture));
      });
    } catch (err) {
      competitorError = err instanceof Error ? err.message : String(err);
      competitorLoadMs = null;
      competitorPointCount = null;
    }
  }

  const values: Record<string, number> = { [SERIES_OLV_LOAD_MS]: olvLoadMs };
  const unavailable: Record<string, string> = {};
  if (competitorLoadMs !== null) {
    values[SERIES_COMPETITOR_LOAD_MS] = competitorLoadMs;
    values[SERIES_LOADER_SPEEDUP] = competitorLoadMs / olvLoadMs;
  } else {
    const reason = !c.competitorReadable
      ? `the competitor does not read LAS ${c.lasVersion}`
      : competitorError !== null
        ? `the competitor threw: ${competitorError}`
        : 'no competitor decoder was provided to this run';
    unavailable[SERIES_COMPETITOR_LOAD_MS] = reason;
    unavailable[SERIES_LOADER_SPEEDUP] = reason;
  }

  return {
    record: {
      index,
      olvLoadMs,
      olvPointCount,
      competitorLoadMs,
      competitorPointCount,
      series: { values, unavailable },
    },
    competitorError,
  };
}

async function runCase(
  config: LoaderComparisonConfig,
  c: LoaderCase,
  probe: CompetitorProbe | null,
  nowNs: () => bigint | null,
): Promise<LoaderCaseResult> {
  const fixture = buildFixture(config.seed, c);
  const reasons: string[] = [];

  // Warm-ups: JIT compilation and first-touch faults belong to the runtime, not
  // the loader, so they are run and discarded but counted.
  let warmupRunsCompleted = 0;
  for (let i = 0; i < config.warmupRuns; i++) {
    await decodeOlv(fixture);
    if (probe && c.competitorReadable) {
      try {
        await probe.decode(bufferOf(fixture));
      } catch {
        /* a warm-up throw is judged from the recorded runs, not here */
      }
    }
    warmupRunsCompleted++;
  }

  const runs: LoaderCaseRunRecord[] = [];
  let competitorError: string | null = null;
  for (let i = 0; i < config.recordedRuns; i++) {
    const { record, competitorError: err } = await recordRun(i + 1, fixture, c, probe, nowNs);
    runs.push(record);
    if (err !== null) competitorError = err;
  }

  const olvPointCount = runs[0]?.olvPointCount ?? null;
  if (olvPointCount === null || olvPointCount < c.pointCount * 0.99) {
    reasons.push(
      `OLV decoded ${olvPointCount === null ? 'nothing' : String(olvPointCount)} of ${c.pointCount} points`,
    );
  }

  // The competitor's verdict against the capability the case declares.
  let competitorStatus: CompetitorStatus;
  let competitorPointCount: number | null = null;
  let competitorRejectionMessage: string | null = null;
  if (!probe) {
    competitorStatus = 'probe-absent';
  } else if (c.competitorReadable) {
    if (competitorError !== null) {
      competitorStatus = 'error';
      reasons.push(`the competitor should read LAS ${c.lasVersion} but threw: ${competitorError}`);
    } else {
      competitorStatus = 'measured';
      competitorPointCount = runs.find((r) => r.competitorPointCount !== null)?.competitorPointCount ?? null;
      if (competitorPointCount === null || competitorPointCount <= 0) {
        competitorStatus = 'error';
        reasons.push('the competitor read the file but reported no points');
      }
    }
  } else {
    // A capability-gap case: the competitor MUST refuse this file. A single
    // decode attempt outside the timed loop settles it.
    try {
      await probe.decode(bufferOf(fixture));
      competitorStatus = 'unexpectedly-read';
      reasons.push(`the competitor read a LAS ${c.lasVersion} file it is expected to refuse`);
    } catch (err) {
      competitorStatus = 'rejected-as-expected';
      competitorRejectionMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const series = summariseRuns(
    runs.map((r) => r.series),
    config.recordedRuns,
  );

  return {
    case: c,
    status: reasons.length === 0 ? 'ok' : 'failed',
    failureReason: reasons.length === 0 ? null : reasons.join(' | '),
    warmupRunsCompleted,
    fixtureBytes: fixture.byteLength,
    olvPointCount,
    competitorStatus,
    competitorPointCount,
    competitorRejectionMessage,
    runs,
    series,
  };
}

export async function runLoaderComparisonSuite(
  config: LoaderComparisonConfig,
  options: LoaderComparisonOptions = {},
): Promise<LoaderComparisonResult> {
  const nowNs = options.nowNs ?? readMonotonicNs;
  const probe = options.competitor ?? null;
  const competitorVersion = probe?.version ?? COMPETITOR_VERSION_UNAVAILABLE;

  const cases: LoaderCaseResult[] = [];
  for (const c of config.cases) {
    cases.push(await runCase(config, c, probe, nowNs));
  }

  const failures: string[] = [];
  for (const cr of cases) {
    if (cr.status === 'failed') {
      failures.push(`case ${cr.case.id}: ${cr.failureReason ?? 'no reason recorded'}`);
    }
  }

  const summary: LoaderComparisonSummary = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    suiteId: 'loaderComparison',
    quantileConvention: QUANTILE_CONVENTION,
    config,
    competitorVersion,
    pass: failures.length === 0,
    failures,
    cases: cases.map((cr) => ({
      id: cr.case.id,
      lasVersion: cr.case.lasVersion,
      requestedPointCount: cr.case.pointCount,
      status: cr.status,
      failureReason: cr.failureReason,
      runCount: cr.runs.length,
      fixtureBytes: cr.fixtureBytes,
      olvPointCount: cr.olvPointCount,
      competitorReadable: cr.case.competitorReadable,
      competitorStatus: cr.competitorStatus,
      competitorPointCount: cr.competitorPointCount,
      competitorRejectionMessage: cr.competitorRejectionMessage,
      series: cr.series,
    })),
  };

  return {
    raw: {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
      suiteId: 'loaderComparison',
      quantileConvention: QUANTILE_CONVENTION,
      config,
      competitorVersion,
      cases,
    },
    summary,
  };
}
