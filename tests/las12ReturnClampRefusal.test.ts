/**
 * LAS 1.2 holds the return number and number of returns in 3 bits each, so a
 * value above 7 cannot be written. Writing it clamped changes which return a
 * point is (return 8 of 12 reads back as 7 of 7), so the write is refused
 * unless the request opts in. Bytes are read back with the project's decoder.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';
import { LEGACY_RETURN_CLAMP_OPT_IN } from '../src/convert/types';

function multiReturnCloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    returnNumber: Uint8Array.from([1, 8, 3]),
    returnCount: Uint8Array.from([12, 12, 9]),
    origin: [500000, 4100000, 10],
    sourceFormat: 'las',
    name: 'multi.las',
  });
}

async function decode(bytes: Uint8Array): Promise<PointCloud> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return loadLas(buf, 'las', 'out.las');
}

describe('LAS 1.2 return clamp', () => {
  it('refuses by default, naming the count, LAS 1.4 and the opt-in', () => {
    const { file, report } = convertCloud(multiReturnCloud(), { format: 'las' });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    const msg = report.log.find((e) => e.level === 'error')!.message;
    expect(msg).toMatch(/3 points/);
    expect(msg).toMatch(/LAS 1\.4/);
    expect(msg).toContain(LEGACY_RETURN_CLAMP_OPT_IN);
  });

  it('opted in, writes the clamped values, warns, and records it in the file', async () => {
    const { file, report } = convertCloud(multiReturnCloud(), { format: 'las', allowLegacyReturnClamp: true });
    expect(report.ok).toBe(true);
    expect(report.log.some((e) => e.level === 'warn' && /3 points/.test(e.message))).toBe(true);
    const out = await decode(file!.bytes);
    expect(Array.from(out.returnNumber ?? [])).toEqual([1, 7, 3]);
    expect(Array.from(out.returnCount ?? [])).toEqual([7, 7, 7]);
    expect(new TextDecoder().decode(file!.bytes)).toMatch(/returns above 7 clamped/);
  });

  it('LAS 1.4 keeps returns up to 15 and needs no opt-in', async () => {
    const { file, report } = convertCloud(multiReturnCloud(), { format: 'las14' });
    expect(report.ok).toBe(true);
    const out = await decode(file!.bytes);
    expect(Array.from(out.returnNumber ?? [])).toEqual([1, 8, 3]);
    expect(Array.from(out.returnCount ?? [])).toEqual([12, 12, 9]);
  });

  it('writes returns of 7 or fewer with no refusal', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0]),
      returnNumber: Uint8Array.from([7]),
      returnCount: Uint8Array.from([7]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'ok.las',
    });
    expect(convertCloud(cloud, { format: 'las' }).report.ok).toBe(true);
  });
});
