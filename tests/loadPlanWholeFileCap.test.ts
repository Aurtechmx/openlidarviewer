/**
 * loadPlanWholeFileCap.test.ts
 *
 * Pins the whole-file allocation cap: a hard byte limit on reading a file into
 * one ArrayBuffer, independent of `navigator.deviceMemory`. A LAS/LAZ over the
 * cap routes to the out-of-core build; any other format over the cap is refused
 * before the read. The secondary whole-file readers (full-resolution export,
 * reload, batch conversion and the loader itself) refuse before `arrayBuffer()`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  planLoad,
  exceedsWholeFileCap,
  MAX_WHOLE_FILE_BYTES,
  WHOLE_FILE_TOO_LARGE_MESSAGE,
  wholeFileTooLargeMessage,
} from '../src/io/loadPlan';
import type { LoadPlanInput, PointAttributes } from '../src/io/loadPlan';
import type { SourceFormat } from '../src/io/sniffFormat';
import { assessFullFile, assessReload, type FullFileLayerFacts } from '../src/app/fullFileActions';
import { guardedBatchInput } from '../src/convert/convertRunner';
import { loadFile } from '../src/io/loadFile';

vi.mock('../src/ui/Modal', () => ({ openConfirm: vi.fn(async () => true) }));

const FOUR_GB = 4_000_000_000;
const FOUR_GIB = 4 * 1024 * 1024 * 1024;

const RGB_I_CLASS: PointAttributes = {
  hasColor: true,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
};

function input(over: Partial<LoadPlanInput> = {}): LoadPlanInput {
  return {
    sourceCount: 120_000_000,
    fileBytes: FOUR_GB,
    budget: 4_000_000,
    isMobile: false,
    deviceMemoryGB: 8,
    attributes: RGB_I_CLASS,
    format: 'las',
    ...over,
  };
}

describe('planLoad — whole-file cap independent of device memory', () => {
  it('routes a 4,000,000,000-byte LAS out-of-core even when the estimate is under the device ceiling', () => {
    const plan = planLoad(input());
    // The device-memory ceiling alone (8 GB x 0.6) admits this estimate.
    expect(plan.memoryEstimateBytes).toBe(4_288_000_000);
    expect(plan.buildThenStream).toBe(true);
    expect(plan.wholeFileRefused).toBe(false);
  });

  it.each([
    ['las', FOUR_GB],
    ['las', FOUR_GIB],
    ['laz', FOUR_GB],
    ['laz', FOUR_GIB],
  ] as const)('routes %s at %d bytes out-of-core', (format, fileBytes) => {
    const plan = planLoad(input({ format, fileBytes }));
    expect(plan.buildThenStream).toBe(true);
    expect(plan.wholeFileRefused).toBe(false);
  });

  it.each([FOUR_GB, FOUR_GIB, MAX_WHOLE_FILE_BYTES + 1])('refuses a PLY at %d bytes', (fileBytes) => {
    const plan = planLoad(input({ format: 'ply', fileBytes, deviceMemoryGB: 64 }));
    expect(plan.wholeFileRefused).toBe(true);
    expect(plan.buildThenStream).toBe(false);
  });

  it('admits a non-LAS file at or under the cap', () => {
    expect(planLoad(input({ format: 'ply', fileBytes: MAX_WHOLE_FILE_BYTES })).wholeFileRefused).toBe(false);
    expect(planLoad(input({ format: 'pcd', fileBytes: 200_000_000 })).wholeFileRefused).toBe(false);
  });

  it('does not truncate sizes at 32 bits', () => {
    expect(exceedsWholeFileCap(FOUR_GIB)).toBe(true);
    expect(exceedsWholeFileCap(FOUR_GIB + 1)).toBe(true);
    expect(exceedsWholeFileCap(2 * FOUR_GIB)).toBe(true);
    expect(exceedsWholeFileCap(MAX_WHOLE_FILE_BYTES)).toBe(false);
    expect(exceedsWholeFileCap(MAX_WHOLE_FILE_BYTES + 1)).toBe(true);
  });

  it('the cap sits between 1 and 1.5 GiB', () => {
    expect(MAX_WHOLE_FILE_BYTES).toBeGreaterThanOrEqual(1024 ** 3);
    expect(MAX_WHOLE_FILE_BYTES).toBeLessThanOrEqual(1.5 * 1024 ** 3);
  });

  it('leaves a small file exactly as before', () => {
    const small = planLoad(input({ sourceCount: 2_000_000, fileBytes: 60_000_000 }));
    expect(small.mode).toBe('all');
    expect(small.buildThenStream).toBe(false);
    expect(small.wholeFileRefused).toBe(false);
    expect(small.memoryGuardTriggered).toBe(false);
  });

  it('a LAS just under the cap still loads whole on a roomy device', () => {
    const plan = planLoad(input({ sourceCount: 30_000_000, fileBytes: MAX_WHOLE_FILE_BYTES }));
    expect(plan.buildThenStream).toBe(false);
  });

  it('names a LAS or LAZ version only for other formats', () => {
    expect(wholeFileTooLargeMessage('las')).toBe(WHOLE_FILE_TOO_LARGE_MESSAGE);
    expect(wholeFileTooLargeMessage('ply')).toBe(
      'This file is too large to load whole in the browser. Open a LAS or LAZ version of it instead.',
    );
  });
});

// --- secondary whole-file readers -------------------------------------------

function facts(format: SourceFormat, fileBytes: number): FullFileLayerFacts {
  return {
    id: 'layer', hasSource: true, reduced: true, truncated: false,
    resident: 1_000_000, declared: 20_000_000, fileBytes, format,
    attributes: RGB_I_CLASS, hasClassEdits: false, includeClassification: true,
  };
}

const roomy = { deviceMemoryGB: 64, isMobile: false };

describe('full-resolution export and reload refuse over the cap', () => {
  it.each(['las', 'laz', 'ply'] as const)('full export refuses an over-cap %s', (format) => {
    const a = assessFullFile(facts(format, MAX_WHOLE_FILE_BYTES + 1), roomy);
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe(WHOLE_FILE_TOO_LARGE_MESSAGE);
  });

  it('full export still allows an under-cap file', () => {
    expect(assessFullFile(facts('las', 600_000_000), roomy).allowed).toBe(true);
  });

  it.each(['las', 'ply'] as const)('reload refuses an over-cap %s', (format) => {
    const r = assessReload(facts(format, FOUR_GB), { ...roomy, tier: 'high' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain(WHOLE_FILE_TOO_LARGE_MESSAGE);
  });

  it('the full-resolution read refuses before the confirm and before arrayBuffer()', async () => {
    const { readFullExportSource } = await import('../src/convert/confirmFullExport');
    const { openConfirm } = await import('../src/ui/Modal');
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = { name: 'big.las', size: FOUR_GIB, arrayBuffer } as unknown as File;
    await expect(readFullExportSource(file)).rejects.toThrow(WHOLE_FILE_TOO_LARGE_MESSAGE);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(openConfirm).not.toHaveBeenCalled();
  });

  it('the full-resolution read still reads an under-cap file', async () => {
    const { readFullExportSource } = await import('../src/convert/confirmFullExport');
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(4));
    const file = { name: 'small.las', size: 4, arrayBuffer } as unknown as File;
    expect((await readFullExportSource(file))?.byteLength).toBe(4);
  });
});

describe('batch conversion refuses over the cap whatever the device ceiling', () => {
  it('rejects before arrayBuffer() even with a larger device ceiling', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const b = guardedBatchInput({ name: 'big.ply', size: FOUR_GB, arrayBuffer }, 8_000_000_000);
    await expect(b.bytes()).rejects.toThrow(/larger than/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads an under-cap file', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8));
    const b = guardedBatchInput({ name: 'ok.ply', size: 8, arrayBuffer }, 8_000_000_000);
    expect((await b.bytes()).byteLength).toBe(8);
  });
});

describe('the loader refuses an over-cap file before the whole-file read', () => {
  function fakePly(size: number): { file: File; bodyReads: () => number } {
    const head = new TextEncoder().encode(
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n',
    );
    let reads = 0;
    const file = {
      name: 'big.ply',
      size,
      slice: () => ({ arrayBuffer: async () => head.buffer.slice(0) }),
      arrayBuffer: async () => {
        reads++;
        return head.buffer.slice(0);
      },
    } as unknown as File;
    return { file, bodyReads: () => reads };
  }

  it.each([FOUR_GB, FOUR_GIB])('refuses a %d-byte PLY with the neutral message', async (size) => {
    const { file, bodyReads } = fakePly(size);
    const err = await loadFile(file, {}, { deviceMemoryGB: 64 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(wholeFileTooLargeMessage('ply'));
    expect(bodyReads()).toBe(0);
  });
});
