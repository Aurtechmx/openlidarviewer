/**
 * reportFixture.ts — one hand-built RunReport shared by the framework suites.
 *
 * Hand-built rather than produced by a real run: the reporter and schema tests
 * must assert on FIXED content (including a stage that failed and two metrics
 * that are unavailable for different reasons), which a live run cannot promise.
 * Nothing here is sampled from the machine, so the suites stay deterministic.
 */
import {
  BENCHMARK_SCHEMA_VERSION,
  capturedEnv,
  measured,
  unavailable,
  type RunReport,
} from '../../benchmarks/framework/types';
import { RAW_BYTES_NO_STRIP_REASON } from '../../benchmarks/framework/artifacts';

/** A fully-populated report: one clean stage, one failed stage, both metric statuses. */
export function fixtureReport(): RunReport {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suiteId: 'decode',
    datasetId: 'synthetic-grid-1m',
    environment: {
      os: capturedEnv('darwin 24.0.0'),
      cpuModel: capturedEnv('Apple M2 Pro'),
      arch: capturedEnv('arm64'),
      nodeVersion: capturedEnv('v22.17.1'),
      gitCommitShort: capturedEnv('5f452c7'),
      gitCommitFull: capturedEnv('5f452c7000000000000000000000000000000000'),
      gitDirty: capturedEnv('clean'),
      releaseVersion: capturedEnv('0.6.0'),
    },
    stages: [
      {
        name: 'decode',
        duration: measured(12.5, 'ms', { runtime: 'node', deterministic: false }),
        peakMemory: measured(1024, 'bytes', { runtime: 'node', deterministic: false }),
        status: 'ok',
      },
      {
        name: 'gpu upload',
        duration: measured(3, 'ms', { runtime: 'node', deterministic: false }),
        peakMemory: unavailable('process.memoryUsage is not exposed in this runtime', {
          runtime: 'browser',
          deterministic: false,
        }),
        status: 'failed',
        error: 'no GPU adapter',
      },
    ],
    artifacts: [
      {
        name: 'metrics',
        kind: 'json',
        algorithm: 'sha256',
        hash: 'a'.repeat(64),
        fingerprint: 'deadbeef',
        byteLength: 42,
        strippedFields: ['generatedAt'],
        volatilityStripped: true,
      },
      // A byte artifact too: it is the case where the strip CANNOT be applied,
      // and every reporter has to say so rather than print an empty exclusion
      // list that reads as "nothing volatile in here".
      {
        name: 'hillshade',
        kind: 'bytes',
        algorithm: 'sha256',
        hash: 'b'.repeat(64),
        fingerprint: 'feedface',
        byteLength: 4096,
        strippedFields: [],
        volatilityStripped: false,
        unstrippedReason: RAW_BYTES_NO_STRIP_REASON,
      },
    ],
    metrics: {
      pointsPerSecond: measured(1_000_000, 'points/s', { runtime: 'node', deterministic: false }),
      gpuFrameTime: unavailable('WebGPU timestamp queries need a browser runtime', {
        runtime: 'browser',
        deterministic: false,
      }),
    },
  };
}
