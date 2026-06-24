/**
 * convertBatch.test.ts — store-only ZIP writer + batch runner.
 */

import { describe, it, expect } from 'vitest';
import { buildZip } from '../src/convert/zipStore';
import { runBatch, dedupeName, summariseBatch, type DecodeFn } from '../src/convert/convertRunner';
import { PointCloud } from '../src/model/PointCloud';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);

describe('buildZip', () => {
  it('writes a valid store-only archive that round-trips an entry', () => {
    const zip = buildZip([
      { name: 'a.txt', bytes: utf8('hello') },
      { name: 'b.txt', bytes: utf8('world!') },
    ]);

    // First local file header signature "PK\x03\x04".
    expect(u32(zip, 0)).toBe(0x04034b50);
    // CRC-32 of "hello" is a fixed, well-known value.
    expect(u32(zip, 14)).toBe(0x3610a686);
    expect(u32(zip, 22)).toBe(5); // uncompressed size of "hello"

    // Extract the first entry's data and compare.
    const nameLen = u16(zip, 26);
    const dataStart = 30 + nameLen;
    const data = zip.slice(dataStart, dataStart + 5);
    expect(new TextDecoder().decode(data)).toBe('hello');

    // End-of-central-directory says 2 entries.
    const eocd = zip.length - 22;
    expect(u32(zip, eocd)).toBe(0x06054b50);
    expect(u16(zip, eocd + 10)).toBe(2);
  });

  it('handles an empty archive', () => {
    const zip = buildZip([]);
    expect(u32(zip, 0)).toBe(0x06054b50); // EOCD only
    expect(zip.length).toBe(22);
  });
});

describe('dedupeName', () => {
  it('appends an index before the extension on collision', () => {
    const seen = new Set<string>();
    expect(dedupeName('scan.las', seen)).toBe('scan.las');
    expect(dedupeName('scan.las', seen)).toBe('scan (2).las');
    expect(dedupeName('scan.las', seen)).toBe('scan (3).las');
    expect(dedupeName('noext', seen)).toBe('noext');
    expect(dedupeName('noext', seen)).toBe('noext (2)');
  });
});

function tinyCloud(name: string): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
    origin: [0, 0, 0],
    sourceFormat: 'xyz',
    name,
  });
}

describe('runBatch', () => {
  const decodeOk: DecodeFn = async (_buf, name) => tinyCloud(name);

  it('converts every input, de-duplicates colliding output names, and reports phases', async () => {
    const phases: string[] = [];
    const results = await runBatch(
      [
        { name: 'a.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) },
        { name: 'a.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) }, // same output stem
      ],
      { format: 'xyz' },
      decodeOk,
      (p) => phases.push(`${p.index}:${p.phase}`),
    );
    expect(results).toHaveLength(2);
    expect(results[0].file?.filename).toBe('a.xyz');
    expect(results[1].file?.filename).toBe('a (2).xyz');
    expect(summariseBatch(results)).toEqual({ ok: 2, failed: 0, points: 4 });
    expect(phases).toContain('0:decoding');
    expect(phases).toContain('0:converting');
    expect(phases).toContain('1:done');
  });

  it('isolates a decode failure and continues the batch', async () => {
    const decode: DecodeFn = async (_buf, name) => {
      if (name === 'bad.las') throw new Error('corrupt header');
      return tinyCloud(name);
    };
    const results = await runBatch(
      [
        { name: 'bad.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) },
        { name: 'good.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) },
      ],
      { format: 'las' },
      decode,
    );
    expect(results[0].report.ok).toBe(false);
    expect(results[0].report.log[0].message).toMatch(/corrupt header/);
    expect(results[1].report.ok).toBe(true);
    expect(summariseBatch(results)).toEqual({ ok: 1, failed: 1, points: 2 });
  });

  it('reads each input lazily — one bytes() call per file, in order (bounded memory)', async () => {
    const reads: string[] = [];
    const input = (name: string) => ({
      name,
      sizeBytes: 8,
      bytes: async () => {
        reads.push(name);
        return new ArrayBuffer(8);
      },
    });
    await runBatch([input('a.las'), input('b.las'), input('c.las')], { format: 'las' }, decodeOk);
    // Each file's bytes are materialised exactly once, in order — never all up
    // front. This is what keeps a big multi-file batch from holding every buffer.
    expect(reads).toEqual(['a.las', 'b.las', 'c.las']);
  });

  it('isolates a file whose bytes() read fails', async () => {
    const results = await runBatch(
      [
        { name: 'unreadable.las', sizeBytes: 8, bytes: async () => { throw new Error('read error'); } },
        { name: 'ok.las', sizeBytes: 8, bytes: async () => new ArrayBuffer(8) },
      ],
      { format: 'las' },
      decodeOk,
    );
    expect(results[0].report.ok).toBe(false);
    expect(results[0].report.log[0].message).toMatch(/read error/);
    expect(results[1].report.ok).toBe(true);
  });
});
