/**
 * zipStore.test.ts — the store-only ZIP writer and its overflow guard.
 *
 * The writer is classic (no ZIP64): 32-bit size/offset fields and a 16-bit
 * entry count. Exceeding any of those would silently corrupt the archive, so
 * `buildZip` throws and `assessZipDownload` lets the UI fall back to per-file
 * downloads before assembling a multi-gigabyte buffer in memory. These pins
 * cover a valid round-trip plus every overflow boundary — using length-only
 * stubs for the huge cases so no test allocates gigabytes.
 */

import { describe, it, expect } from 'vitest';
import {
  buildZip,
  assessZipDownload,
  ZIP_MAX_ENTRIES,
  type ZipEntry,
} from '../src/convert/zipStore';

const u8 = (...bytes: number[]) => new Uint8Array(bytes);

/** A length-only ZipEntry stub for the giant cases (no real allocation). */
function fakeEntry(name: string, length: number): ZipEntry {
  return { name, bytes: { length } as unknown as Uint8Array };
}

describe('buildZip — valid archives', () => {
  it('writes the local + central + EOCD structure for a small set', () => {
    const zip = buildZip([
      { name: 'a.txt', bytes: u8(1, 2, 3) },
      { name: 'b.bin', bytes: u8(9) },
    ]);
    const dv = new DataView(zip.buffer);
    // First local file header signature.
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    // End-of-central-directory record sits at the tail (22 bytes) and records
    // the entry count in its 16-bit field.
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2); // total entries
  });

  it('is deterministic for the same inputs', () => {
    const e = [{ name: 'x', bytes: u8(5, 6, 7) }];
    expect(Array.from(buildZip(e))).toEqual(Array.from(buildZip(e)));
  });
});

describe('assessZipDownload — safe small batch', () => {
  it('approves a normal batch and estimates a plausible size', () => {
    const a = assessZipDownload([
      { name: 'one.las', bytes: new Uint8Array(1000) },
      { name: 'two.las', bytes: new Uint8Array(2000) },
    ]);
    expect(a.ok).toBe(true);
    expect(a.entryCount).toBe(2);
    expect(a.totalBytes).toBeGreaterThan(3000);
    expect(a.reason).toBeUndefined();
  });
});

describe('assessZipDownload — overflow boundaries (no giant allocation)', () => {
  it('rejects more files than the 16-bit entry count allows', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => fakeEntry(`f${i}`, 1));
    const a = assessZipDownload(many);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/file ZIP limit/i);
  });

  it('rejects a single file over the 4 GiB per-file limit', () => {
    const a = assessZipDownload([fakeEntry('huge.las', 5 * 1024 ** 3)]);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/4 GiB/);
  });

  it('rejects a combined output too large to zip in memory', () => {
    // Three ~700 MiB outputs → ~2.1 GiB combined, over the 1.5 GiB safe ceiling
    // but each under the 4 GiB per-file limit.
    const big = Array.from({ length: 3 }, (_, i) => fakeEntry(`p${i}.las`, 700 * 1024 ** 2));
    const a = assessZipDownload(big);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/too large to zip in memory/i);
  });
});

describe('buildZip — refuses to emit a corrupt archive', () => {
  it('throws past the entry-count limit instead of wrapping the 16-bit field', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, () => ({ name: 'f', bytes: new Uint8Array(0) }));
    expect(() => buildZip(many)).toThrow(/at most/i);
  });

  it('throws on a single entry over the 4 GiB size field (before allocating)', () => {
    expect(() => buildZip([fakeEntry('huge.las', 5 * 1024 ** 3)])).toThrow(/4 GiB/);
  });
});
