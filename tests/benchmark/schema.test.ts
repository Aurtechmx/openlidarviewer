/**
 * schema.test.ts — the benchmark report schema and its honesty contract.
 *
 * The reports become paper figures, so the schema has one job the reviewer must
 * be able to trust: a metric that was NOT measured never carries a number. A `0`
 * standing in for "we did not measure this" is the failure this suite prevents.
 */
import { describe, test, expect } from 'vitest';
import {
  BENCHMARK_SCHEMA_VERSION,
  measured,
  unavailable,
  isMeasured,
  isUnavailable,
  capturedEnv,
  unavailableEnv,
  type RunReport,
  type Metric,
} from '../../benchmarks/framework/types';
import { fixtureReport } from './reportFixture';

describe('schema round-trip', () => {
  test('a RunReport survives JSON serialize -> parse unchanged', () => {
    const report = fixtureReport();
    const round = JSON.parse(JSON.stringify(report)) as RunReport;
    expect(round).toEqual(report);
  });

  test('the schema version is an integer stamped on every report', () => {
    expect(fixtureReport().schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(Number.isInteger(BENCHMARK_SCHEMA_VERSION)).toBe(true);
  });
});

describe('the unavailable contract', () => {
  test('an unavailable metric carries a null value, a reason, and no unit', () => {
    const m = unavailable('no high-resolution clock', { runtime: 'browser', deterministic: false });
    expect(m.status).toBe('unavailable');
    expect(m.value).toBeNull();
    expect(m.reason).toBe('no high-resolution clock');
    expect('unit' in m).toBe(false);
  });

  test('unavailable() rejects an empty reason — "unavailable" alone explains nothing', () => {
    expect(() => unavailable('  ', { runtime: 'node', deterministic: false })).toThrow(/reason/i);
  });

  test('measured() rejects a non-finite value rather than serialising NaN as null', () => {
    // JSON.stringify(NaN) is `null`, which reads downstream as "no value" while
    // the record still claims status 'measured' — the exact ambiguity forbidden.
    expect(() => measured(NaN, 'ms', { runtime: 'node', deterministic: false })).toThrow(/finite/i);
    expect(() => measured(Infinity, 'ms', { runtime: 'node', deterministic: false })).toThrow(
      /finite/i,
    );
  });

  test('measured() rejects an empty unit — a bare number is not a measurement', () => {
    expect(() => measured(1, '', { runtime: 'node', deterministic: false })).toThrow(/unit/i);
  });

  test('every metric declares its runtime and whether it is deterministic', () => {
    const m = measured(1, 'ms', { runtime: 'node', deterministic: true });
    expect(m.runtime).toBe('node');
    expect(m.deterministic).toBe(true);
    const u = unavailable('why', { runtime: 'browser', deterministic: true });
    expect(u.runtime).toBe('browser');
    expect(u.deterministic).toBe(true);
  });

  test('the guards narrow the union both ways', () => {
    const ok: Metric = measured(2, 'ms', { runtime: 'node', deterministic: false });
    const no: Metric = unavailable('why', { runtime: 'node', deterministic: false });
    expect(isMeasured(ok)).toBe(true);
    expect(isUnavailable(ok)).toBe(false);
    expect(isMeasured(no)).toBe(false);
    expect(isUnavailable(no)).toBe(true);
  });

  test('no metric in a serialised report mixes a status with the wrong value', () => {
    const round = JSON.parse(JSON.stringify(fixtureReport())) as RunReport;
    const all: Metric[] = [
      ...round.stages.flatMap((s) => [s.duration, s.peakMemory]),
      ...Object.values(round.metrics),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      if (m.status === 'measured') expect(typeof m.value).toBe('number');
      else {
        expect(m.value).toBeNull();
        expect(m.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('environment fields', () => {
  test('an undeterminable field is unavailable with a reason, not an empty string', () => {
    const e = unavailableEnv('git is not on PATH');
    expect(e.status).toBe('unavailable');
    expect(e.value).toBeNull();
    expect(e.reason).toBe('git is not on PATH');
  });

  test('a captured field rejects an empty string', () => {
    expect(() => capturedEnv('')).toThrow(/empty/i);
  });
});
