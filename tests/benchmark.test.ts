import { buildBenchmarkResult, formatBenchmarkResult } from '../src/io/benchmark';
import type { LoadTelemetry } from '../src/io/loadTelemetry';

const TELEMETRY: LoadTelemetry = {
  sniffMs: 2,
  fileReadMs: 10,
  transferMs: 5,
  parseMs: 8,
  decodeMs: 40,
  totalLoadMs: 70,
  gpuUploadMs: 12,
  firstRenderMs: 6,
};

test('time-to-first-render sums the load span, GPU upload and first render', () => {
  const r = buildBenchmarkResult('scan.las', 'las', 100_000, TELEMETRY);
  expect(r.file).toBe('scan.las');
  expect(r.format).toBe('las');
  expect(r.pointCount).toBe(100_000);
  expect(r.timeToFirstRenderMs).toBeCloseTo(70 + 12 + 6);
});

test('missing stage timings are treated as zero', () => {
  const r = buildBenchmarkResult('a.ply', 'ply', 10, {});
  expect(r.timeToFirstRenderMs).toBe(0);
  expect(r.stages).toEqual({});
});

test('the stages field is a copy — a later mutation of the input is not reflected', () => {
  const input: LoadTelemetry = { totalLoadMs: 50 };
  const r = buildBenchmarkResult('a.las', 'las', 1, input);
  input.totalLoadMs = 999;
  expect(r.stages.totalLoadMs).toBe(50);
});

test('the formatted report carries the headline figures and a stage block', () => {
  const text = formatBenchmarkResult(
    buildBenchmarkResult('scan.las', 'las', 1_234_567, TELEMETRY),
  );
  expect(text).toContain('scan.las');
  expect(text).toContain('las');
  expect(text).toContain('1,234,567');
  expect(text).toContain('88.0 ms'); // 70 + 12 + 6
  expect(text).toContain('decode'); // a stage row from formatTelemetry
});

test('sourcePointCount is preserved when supplied', () => {
  const r = buildBenchmarkResult('huge.copc.laz', 'copc', 4_000_000, TELEMETRY, 100_000_000);
  expect(r.sourcePointCount).toBe(100_000_000);
});

test('the formatter discloses budget-capped loads as "X of Y (Z%)"', () => {
  // Regression: previously the formatter printed only the rendered
  // count, making a 4M-rendered-of-100M-source benchmark read as fast
  // as a 4M-rendered-of-4M-source benchmark. The audit flagged this
  // as misleading-by-omission.
  const text = formatBenchmarkResult(
    buildBenchmarkResult('huge.copc.laz', 'copc', 4_000_000, TELEMETRY, 100_000_000),
  );
  expect(text).toContain('4,000,000');
  expect(text).toContain('100,000,000');
  expect(text).toMatch(/4\.0%/);
});

test('the formatter omits the "of" suffix when the full file fits the budget', () => {
  const text = formatBenchmarkResult(
    buildBenchmarkResult('small.las', 'las', 1_000_000, TELEMETRY, 1_000_000),
  );
  expect(text).toContain('1,000,000');
  expect(text).not.toContain(' of ');
});

test('the formatter omits the "of" suffix when sourcePointCount is unknown', () => {
  const text = formatBenchmarkResult(
    buildBenchmarkResult('unknown.ply', 'ply', 1_000, TELEMETRY),
  );
  expect(text).toContain('1,000');
  expect(text).not.toContain(' of ');
});
