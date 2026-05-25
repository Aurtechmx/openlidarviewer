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
