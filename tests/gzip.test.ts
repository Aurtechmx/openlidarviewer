/**
 * gzip.test.ts
 *
 * Pins the .las.gz export stop-gap: a real gzip → gunzip round-trip restores the
 * original bytes, and gzipConvertedFile rewrites name/MIME correctly (and is a
 * no-op when compression is off).
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { gzipBytes, gzipConvertedFile, gzipAvailable } from '../src/convert/gzip';
import type { ConvertedFile } from '../src/convert/types';

const sample = new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) & 0xff));

describe('gzipBytes', () => {
  it('is available in this runtime', () => {
    expect(gzipAvailable()).toBe(true);
  });

  it('round-trips: gunzip(gzip(x)) === x', async () => {
    const compressed = await gzipBytes(sample);
    const restored = new Uint8Array(gunzipSync(compressed));
    expect(restored).toEqual(sample);
  });

  it('actually compresses redundant data', async () => {
    const zeros = new Uint8Array(10_000); // all zero → highly compressible
    const compressed = await gzipBytes(zeros);
    expect(compressed.length).toBeLessThan(zeros.length);
  });
});

describe('gzipConvertedFile', () => {
  const file: ConvertedFile = { filename: 'scan.las', mime: 'application/octet-stream', bytes: sample };

  it('compress=false returns the file untouched', async () => {
    expect(await gzipConvertedFile(file, false)).toBe(file);
  });

  it('compress=true appends .gz, sets gzip MIME, and gzips the bytes', async () => {
    const out = await gzipConvertedFile(file, true);
    expect(out.filename).toBe('scan.las.gz');
    expect(out.mime).toBe('application/gzip');
    expect(new Uint8Array(gunzipSync(out.bytes))).toEqual(sample);
  });
});
