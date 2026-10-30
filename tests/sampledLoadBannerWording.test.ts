/**
 * sampledLoadBannerWording.test.ts
 *
 * A multi-GB LAS/LAZ that opens as a display sample is read by ranges and
 * strided; it is never read into memory whole. The pre-decode banner has to
 * say what the load does, not the whole-file caution.
 */

import { describe, it, expect } from 'vitest';
import { fileMetadata } from '../src/io/loadFile';
import { lasHeaderBuffer } from './helpers/lasHeaderBytes';

const GIB = 1024 ** 3;

function fakeFile(name: string, size: number, head: ArrayBuffer): File {
  return {
    name,
    size,
    slice: () => ({ arrayBuffer: async () => head.slice(0) }),
  } as unknown as File;
}

describe('large LAS/LAZ opened as a display sample', () => {
  it('says the file is read as a sample, not fully into memory', async () => {
    const f = fakeFile('big.las', 1.6 * GIB, lasHeaderBuffer(210_887_303));
    const meta = await fileMetadata(f, { rangedSample: true, deviceMemoryGB: 8 });
    expect(meta.warning).toBeDefined();
    expect(meta.warning).not.toMatch(/read fully into memory/);
    expect(meta.warning).toMatch(/sample of one record in \d+/);
    expect(meta.warning).toMatch(/of 210\.9M points/);
    expect(meta.warning).toMatch(/COPC\/EPT/);
    // Densities on the report use the declared count, so only counts are said to describe the sample.
    expect(meta.warning).toContain('Counts describe the sample.');
    expect(meta.warning).not.toMatch(/densities/i);
  });

  it('keeps the whole-file caution for a resident read', async () => {
    const f = fakeFile('big.las', 1.6 * GIB, lasHeaderBuffer(2_000_000));
    const meta = await fileMetadata(f, { deviceMemoryGB: 64 });
    expect(meta.warning ?? '').toMatch(/read fully into memory|may fail/);
  });
});
