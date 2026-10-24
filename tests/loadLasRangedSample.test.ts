/**
 * loadLasRangedSample.test.ts: a heavy LAS or LAZ opened as a sample is read
 * by ranges and never whole.
 *
 * When the out-of-core index cannot be built, the loader keeps a stratified
 * stride of every record in the file. For an uncompressed LAS the ranged read
 * must keep exactly the records the whole-file decode keeps, at any stride and
 * whether it reads a window at a time or one record at a time. The plan for
 * such a read leaves the file's bytes out of the memory estimate and does not
 * route it out of core again, and a LAZ past the whole-file cap is refused
 * rather than read whole when its chunks cannot be decoded separately.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadLas, loadLasFromFile, loadLazFromFile } from '../src/io/loadLas';
import { planLoad, MAX_WHOLE_FILE_BYTES } from '../src/io/loadPlan';
import { LoadError } from '../src/io/loadErrors';
import { lasBytes } from './support/heavyLasFakes';

vi.mock('../src/io/heavy/worker/lazChunkWorkerClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/io/heavy/worker/lazChunkWorkerClient')>();
  // No pool here, as in a browser that could not start one.
  return { ...real, decodeLazPooledFromSource: async () => null };
});

function fileOf(buffer: ArrayBuffer, name: string): File {
  return new File([buffer], name);
}

describe('ranged LAS sample', () => {
  it.each([1, 7, 64])('keeps the same records as the whole-file decode at stride %i', async (stride) => {
    const buffer = lasBytes(20_000);
    const whole = await loadLas(buffer, 'las', 'grid.las', stride);
    const ranged = await loadLasFromFile(fileOf(buffer, 'grid.las'), 'grid.las', stride);
    expect(ranged.pointCount).toBe(whole.pointCount);
    expect(Array.from(ranged.positions)).toEqual(Array.from(whole.positions));
    expect(Array.from(ranged.intensity ?? [])).toEqual(Array.from(whole.intensity ?? []));
    expect(Array.from(ranged.classification ?? [])).toEqual(Array.from(whole.classification ?? []));
    expect(ranged.origin).toEqual(whole.origin);
  });

  it('reads one record at a time when a bucket is wider than a window, with the same result', async () => {
    // Over 8 MiB of records, at a stride wider than one window holds.
    const buffer = lasBytes(600_000);
    const stride = 300_000;
    const whole = await loadLas(buffer, 'las', 'wide.las', stride);
    const file = fileOf(buffer, 'wide.las');
    const slice = vi.spyOn(file, 'slice');
    const ranged = await loadLasFromFile(file, 'wide.las', stride);
    expect(Array.from(ranged.positions)).toEqual(Array.from(whole.positions));
    // Every read is bounded: no slice spans the point data.
    const largest = Math.max(...slice.mock.calls.map(([from = 0, to = file.size]) => to - from));
    expect(largest).toBeLessThan(buffer.byteLength / 2);
  });
});

describe('ranged sample plan', () => {
  const input = {
    sourceCount: 210_887_303,
    fileBytes: 3_100_000_000,
    budget: 3_000_000,
    isMobile: false,
    deviceMemoryGB: 8,
    attributes: { hasColor: true, hasIntensity: true, hasClassification: true, hasNormals: false, hasLasExtras: true },
    format: 'laz' as const,
  };

  it('routes a resident whole-file load out of core, as before', () => {
    const plan = planLoad(input);
    expect(plan.buildThenStream).toBe(true);
    expect(plan.rangedRead).toBe(false);
  });

  it('keeps a stride of the file and does not count its bytes when it is read by ranges', () => {
    const plan = planLoad({ ...input, fileResident: false });
    expect(plan.buildThenStream).toBe(false);
    expect(plan.rangedRead).toBe(true);
    expect(plan.mode).toBe('stride');
    expect(plan.stride).toBeGreaterThan(1);
    // The file's 3.1 GB is not in the estimate: only the decoded points and scratch are.
    expect(plan.memoryEstimateBytes).toBeLessThan(input.fileBytes);
    expect(plan.mayExceedCeiling).toBe(false);
  });
});

describe('LAZ past the whole-file cap', () => {
  it('is refused rather than read whole when its chunks cannot be decoded separately', async () => {
    const bytes = readFileSync('tests/fixtures/multichunk.laz');
    const file = fileOf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'huge.laz');
    Object.defineProperty(file, 'size', { value: MAX_WHOLE_FILE_BYTES + 1 });
    const whole = vi.spyOn(file, 'arrayBuffer');
    await expect(loadLazFromFile(file, 'huge.laz', 50)).rejects.toBeInstanceOf(LoadError);
    expect(whole).not.toHaveBeenCalled();
  });

  it('is refused, not read whole, under a ranged plan that left the file out of its memory estimate', async () => {
    const bytes = readFileSync('tests/fixtures/multichunk.laz');
    const file = fileOf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'sampled.laz');
    const whole = vi.spyOn(file, 'arrayBuffer');
    await expect(
      loadLazFromFile(file, 'sampled.laz', 1, undefined, undefined, undefined, undefined, undefined, undefined, false),
    ).rejects.toThrow(/planned as a sample read in pieces/);
    expect(whole).not.toHaveBeenCalled();
  });

  it('is still read whole below the cap when the chunks cannot be decoded separately', async () => {
    const bytes = readFileSync('tests/fixtures/multichunk.laz');
    const file = fileOf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'small.laz');
    const cloud = await loadLazFromFile(file, 'small.laz', 1);
    expect(cloud.pointCount).toBeGreaterThan(0);
  });
});
