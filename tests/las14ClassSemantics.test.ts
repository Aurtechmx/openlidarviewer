/**
 * Class numbers that mean different things in LAS 1.0 to 1.3 and LAS 1.4 are
 * translated or reported on conversion. Every source is a hand-built LAS file
 * and every result is parsed with the independent reader in helpers/rawLas.ts,
 * not with the application's decoder.
 *
 * Spec tables relied on: LAS 1.2 Table 4 (8 Model Key-point, 12 Overlap Points,
 * 10, 11 and 13 to 31 reserved), LAS 1.4 R15 Table 17 (8 and 12 reserved, 10
 * Rail, 11 Road Surface, 13 to 22 defined), and the Classification Flags field
 * (bit 1 key-point, bit 3 overlap).
 */

import { describe, it, expect } from 'vitest';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';
import { PointCloud } from '../src/model/PointCloud';
import { DIFFERING_CLASS_CODES } from '../src/convert/classSemantics';
import { buildLas, readLas, type RawPoint } from './helpers/rawLas';

const SYNTHETIC = 1;
const KEY_POINT = 2;
const WITHHELD = 4;
const OVERLAP = 8;

async function decode(bytes: Uint8Array) {
  return loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las', 'src.las', 1, undefined, true);
}

async function convert(source: Uint8Array, format: 'las' | 'las14', allowWrap = false) {
  const cloud = await decode(source);
  const result = convertCloud(cloud, { format, allowLegacyClassWrap: allowWrap });
  expect(result.file).not.toBeNull();
  return { cloud, report: result.report, out: readLas(result.file!.bytes) };
}

const legacy = (cls: number[], flags: number[] = []): Uint8Array =>
  buildLas({ version: '1.2', pdrf: 3, points: cls.map((c, i): RawPoint => ({ cls: c, flags: flags[i] ?? 0 })) });
const extended = (cls: number[], flags: number[] = []): Uint8Array =>
  buildLas({ version: '1.4', pdrf: 6, points: cls.map((c, i): RawPoint => ({ cls: c, flags: flags[i] ?? 0 })) });

describe('legacy to LAS 1.4', () => {
  it('writes legacy class 8 as class 1 with the key-point flag', async () => {
    const { out, report, cloud } = await convert(legacy([8, 2]), 'las14');
    expect(out.pdrf).toBeGreaterThanOrEqual(6);
    expect(out.cls).toEqual([1, 2]);
    expect(out.flags).toEqual([KEY_POINT, 0]);
    expect(report.log.some((e) => /1 point carried legacy class 8/.test(e.message) && /key-point flag/.test(e.message))).toBe(true);
    // The live arrays are untouched.
    expect(Array.from(cloud.classification!)).toEqual([8, 2]);
    expect(Array.from(cloud.classificationFlags!)).toEqual([0, 0]);
  });

  it('keeps synthetic and withheld flags beside the translated flag, for classes 8 and 12 together', async () => {
    const { out } = await convert(legacy([8, 12, 8, 2], [SYNTHETIC, WITHHELD, KEY_POINT | WITHHELD, 0]), 'las14');
    expect(out.cls).toEqual([1, 1, 1, 2]);
    expect(out.flags).toEqual([SYNTHETIC | KEY_POINT, WITHHELD | OVERLAP, KEY_POINT | WITHHELD, 0]);
  });

  it('leaves ordinary classes alone and reports nothing', async () => {
    const { out, report } = await convert(legacy([0, 1, 2, 3, 4, 5, 6, 7, 9]), 'las14');
    expect(out.cls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    expect(report.log.filter((e) => e.level !== 'info' || /class/i.test(e.message)).length).toBe(0);
  });

  it('does not translate class 8 or 12 that is already an extended-format code', async () => {
    const { out, report } = await convert(extended([8, 12]), 'las14');
    expect(out.cls).toEqual([8, 12]);
    expect(out.flags).toEqual([0, 0]);
    expect(report.log.some((e) => /legacy class/.test(e.message))).toBe(false);
  });

  it('does not translate when the source format is unknown', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      classification: Uint8Array.from([8, 12]),
      classificationFlags: Uint8Array.from([0, 0]),
      sourceFormat: 'las', name: 'x.las', origin: [0, 0, 0],
    });
    const { file } = convertCloud(cloud, { format: 'las14' });
    expect(readLas(file!.bytes).cls).toEqual([8, 12]);
  });

  it('reports a legacy reserved code that LAS 1.4 names, per class with counts', async () => {
    const { out, report } = await convert(legacy([10, 10, 19, 2]), 'las14');
    expect(out.cls).toEqual([10, 10, 19, 2]);
    const warns = report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warns.some((m) => /^Class 10 \(2 points\)/.test(m) && /Rail/.test(m) && /reserved/.test(m))).toBe(true);
    expect(warns.some((m) => /^Class 19 \(1 point\)/.test(m) && /Overhead Structure/.test(m))).toBe(true);
  });
});

describe('LAS 1.4 to legacy', () => {
  it('reports class 19 with its count, and keeps the number', async () => {
    const { out, report } = await convert(extended([19, 19, 2]), 'las');
    expect(out.version).toBe('1.2');
    expect(out.cls).toEqual([19, 19, 2]);
    const warns = report.log.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/^Class 19 \(2 points\)/);
    expect(warns[0].message).toMatch(/Overhead Structure in LAS 1\.4 and reserved in LAS 1\.0 to 1\.3/);
  });

  it('reports high noise (18) as having no legacy equivalent and does not remap it', async () => {
    const { out, report } = await convert(extended([18, 7]), 'las');
    expect(out.cls).toEqual([18, 7]);
    const warns = report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^Class 18 \(1 point\)/);
    expect(warns[0]).toMatch(/High Noise/);
  });

  it('reports extended reserved 8 and 12, which a legacy reader reads as key-point and overlap', async () => {
    const { out, report } = await convert(extended([8, 12]), 'las');
    expect(out.cls).toEqual([8, 12]);
    const warns = report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warns.some((m) => /^Class 8 /.test(m) && /Model Key-Point/.test(m))).toBe(true);
    expect(warns.some((m) => /^Class 12 /.test(m) && /Overlap Points/.test(m))).toBe(true);
  });

  it('carries the key-point flag in the legacy class byte instead of rewriting the class to 8', async () => {
    const { out } = await convert(extended([2, 1], [KEY_POINT, KEY_POINT | WITHHELD]), 'las');
    expect(out.cls).toEqual([2, 1]);
    expect(out.flags).toEqual([KEY_POINT, KEY_POINT | WITHHELD]);
  });

  it('says nothing about classes that mean the same in both tables', async () => {
    const { out, report } = await convert(extended([0, 1, 2, 3, 4, 5, 6, 7, 9]), 'las');
    expect(out.cls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    expect(report.log.some((e) => e.level === 'warn')).toBe(false);
  });

  it('does not warn about reserved-in-both codes 23 to 31', async () => {
    const { report } = await convert(extended([23, 31]), 'las');
    expect(report.log.some((e) => e.level === 'warn')).toBe(false);
  });

  it('keeps refusing class numbers above 31 unless wrapping is allowed', async () => {
    const cloud = await decode(extended([64]));
    expect(convertCloud(cloud, { format: 'las' }).file).toBeNull();
  });

  it('reports a code from a derived classification that the legacy table cannot name', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      classification: Uint8Array.from([18, 8]),
      classificationFlags: Uint8Array.from([0, 0]),
      sourceFormat: 'las', name: 'x.las', origin: [0, 0, 0],
    });
    const { report } = convertCloud(cloud, { format: 'las' });
    const warns = report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warns.some((m) => /^Class 18 /.test(m))).toBe(true);
    // The source meaning of 8 is unknown, so nothing is asserted about it.
    expect(warns.some((m) => /^Class 8 /.test(m))).toBe(false);
  });
});

describe('the shared table', () => {
  it('lists exactly the codes whose meaning differs: 8, 10 to 22', () => {
    expect([...DIFFERING_CLASS_CODES]).toEqual([8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });

  it.each(DIFFERING_CLASS_CODES.filter((c) => c !== 8 && c !== 12))('class %i is reported in both directions', async (code) => {
    const down = await convert(extended([code]), 'las');
    expect(down.out.cls).toEqual([code]);
    expect(down.report.log.filter((e) => e.level === 'warn' && e.message.startsWith(`Class ${code} (`))).toHaveLength(1);
    const up = await convert(legacy([code]), 'las14');
    expect(up.out.cls).toEqual([code]);
    expect(up.report.log.filter((e) => e.level === 'warn' && e.message.startsWith(`Class ${code} (`))).toHaveLength(1);
  });
});

describe('message wording', () => {
  it('says what a legacy reader reads for extended-reserved 8 and 12, in the singular for one point', async () => {
    const { report } = await convert(extended([8, 12, 12]), 'las');
    const warns = report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    const eight = warns.find((m) => m.startsWith('Class 8 ('))!;
    const twelve = warns.find((m) => m.startsWith('Class 12 ('))!;
    expect(eight).toMatch(/LAS 1\.2 readers will read it as Model Key-Point/);
    expect(twelve).toMatch(/LAS 1\.2 readers will read them as Overlap Points/);
    expect(eight).not.toMatch(/will not read/);
  });

  it('uses the singular in the overlap-flag warning for one point and the plural for two', async () => {
    const one = await convert(extended([2, 2], [OVERLAP, 0]), 'las');
    const two = await convert(extended([2, 2], [OVERLAP, OVERLAP]), 'las');
    const text = (r: typeof one) => r.report.log.find((e) => /overlap flag/.test(e.message) && e.level === 'warn')!.message;
    expect(text(one)).toMatch(/ 1 point carries it /);
    expect(text(two)).toMatch(/ 2 points carry it /);
  });
});
