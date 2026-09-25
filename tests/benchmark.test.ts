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
  framingMs: 2,
  firstDrawMs: 6,
};

test('time-to-first-render sums the load span, GPU upload and first draw', () => {
  const r = buildBenchmarkResult('scan.las', 'las', 100_000, TELEMETRY);
  expect(r.file).toBe('scan.las');
  expect(r.format).toBe('las');
  expect(r.pointCount).toBe(100_000);
  expect(r.timeToFirstRenderMs).toBeCloseTo(70 + 12 + 6);
});

test('framing stands in for the first draw when no draw was measured', () => {
  const r = buildBenchmarkResult('a.las', 'las', 1, { totalLoadMs: 10, gpuUploadMs: 3, framingMs: 2 });
  expect(r.timeToFirstRenderMs).toBeCloseTo(15);
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

test('the serialised result carries the load identity and the read ledger', () => {
  const r = buildBenchmarkResult('ladder-5M.laz', 'laz', 1_250_000, {
    ...TELEMETRY,
    fileName: 'ladder-5M.laz',
    fileBytes: 9_900_000,
    declaredPointCount: 5_000_000,
    pointFormat: 6,
    lazChunkCount: 100,
    decodeStride: 4,
    previewBudget: 250_000,
    rangeRequests: 41,
    requestedBytes: 10_100_000,
    uniqueBytesRead: 9_900_000,
    rereadBytes: 200_000,
    compressedBytesBeforePreview: 2_400_000,
    compressedBytesRead: 9_800_000,
  });
  // The header count stands in for a source count the caller did not pass.
  expect(r.sourcePointCount).toBe(5_000_000);
  const json = JSON.parse(JSON.stringify(r)) as { stages: Record<string, unknown> };
  expect(json.stages.fileName).toBe('ladder-5M.laz');
  expect(json.stages.fileBytes).toBe(9_900_000);
  expect(json.stages.pointFormat).toBe(6);
  expect(json.stages.lazChunkCount).toBe(100);
  expect(json.stages.decodeStride).toBe(4);
  expect(json.stages.previewBudget).toBe(250_000);
  expect(json.stages.uniqueBytesRead).toBe(9_900_000);
  expect(json.stages.rereadBytes).toBe(200_000);
  expect(json.stages.compressedBytesBeforePreview).toBe(2_400_000);
});

test('an explicit source count still wins over the header count', () => {
  const r = buildBenchmarkResult('a.laz', 'laz', 10, { declaredPointCount: 500 }, 900);
  expect(r.sourcePointCount).toBe(900);
});
