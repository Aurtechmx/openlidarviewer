/**
 * Upgrading a legacy LAS (point formats 0 to 5) to LAS 1.4 must translate the
 * legacy overlap code. Legacy files mark overlap as class 12; the extended
 * formats reserve class 12 and mark overlap with a flag bit. The written file
 * is read back with the project's own decoder.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';

const OVERLAP = 0x8;

function legacyCloud(pointFormat: number | undefined): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    classification: Uint8Array.from([2, 12, 12]),
    // Point 2 is also withheld; that flag must survive the translation.
    classificationFlags: Uint8Array.from([0, 0, 0x4]),
    origin: [500000, 4100000, 10],
    sourceFormat: 'las',
    name: 'legacy.las',
    metadata: pointFormat === undefined ? undefined : { pointFormat },
  });
}

async function decode(bytes: Uint8Array): Promise<PointCloud> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return loadLas(buf, 'las', 'out.las', 1, undefined, true);
}

describe('LAS 1.4 upgrade of legacy class 12', () => {
  it('writes legacy overlap as class 1 with the overlap flag, and says so', async () => {
    const cloud = legacyCloud(3);
    const { file, report } = convertCloud(cloud, { format: 'las14' });
    const out = await decode(file!.bytes);
    expect(Array.from(out.classification ?? [])).toEqual([2, 1, 1]);
    expect(Array.from(out.classificationFlags ?? [])).toEqual([0, OVERLAP, OVERLAP | 0x4]);
    expect(report.log.some((e) => /2 points/.test(e.message) && /overlap flag/i.test(e.message))).toBe(true);
    // The live cloud is untouched.
    expect(Array.from(cloud.classification ?? [])).toEqual([2, 12, 12]);
    expect(Array.from(cloud.classificationFlags ?? [])).toEqual([0, 0, 0x4]);
  });

  it('leaves class 12 alone when the source was already an extended format', async () => {
    const { file, report } = convertCloud(legacyCloud(6), { format: 'las14' });
    const out = await decode(file!.bytes);
    expect(Array.from(out.classification ?? [])).toEqual([2, 12, 12]);
    expect(Array.from(out.classificationFlags ?? [])).toEqual([0, 0, 0x4]);
    expect(report.log.some((e) => /overlap flag/i.test(e.message))).toBe(false);
  });

  it('round-trips: the upgraded file written back to LAS 1.2 refuses, and warns once the overlap drop is allowed', async () => {
    const { file } = convertCloud(legacyCloud(3), { format: 'las14' });
    const up = await decode(file!.bytes);
    expect(convertCloud(up, { format: 'las' }).file).toBeNull();
    const { report } = convertCloud(up, { format: 'las', allowLegacyOverlapDrop: true });
    expect(report.ok).toBe(true);
    expect(report.log.some((e) => e.level === 'warn' && /overlap flag/.test(e.message))).toBe(true);
  });

  it('translates class 12 in a real LAS 1.2 file decoded from bytes', async () => {
    const { file: legacy } = convertCloud(legacyCloud(undefined), { format: 'las' });
    const decoded = await decode(legacy!.bytes);
    expect(decoded.metadata?.pointFormat).toBeLessThan(6);
    const { file } = convertCloud(decoded, { format: 'las14' });
    const out = await decode(file!.bytes);
    expect(Array.from(out.classification ?? [])).toEqual([2, 1, 1]);
    expect(Array.from(out.classificationFlags ?? [])).toEqual([0, OVERLAP, OVERLAP | 0x4]);
  });
});
