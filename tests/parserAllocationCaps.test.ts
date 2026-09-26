/**
 * parserAllocationCaps.test.ts
 *
 * Fuzz-style refusal cases for every point-cloud parser. Each case is a small
 * buffer whose header inflates a count or length (point count, vertex count,
 * record length, chunk size, string length) far past what the bytes can hold.
 * A loader must refuse with a LoadError before it allocates for that claim, and
 * must never hang. Allocation is bounded by counting the bytes of every typed
 * array constructed while the loader runs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { LoadError } from '../src/io/loadErrors';
import { loadLas } from '../src/io/loadLas';
import { loadPly } from '../src/io/loadPly';
import { loadPcd } from '../src/io/loadPcd';
import { loadPts } from '../src/io/loadPts';
import { loadPtx } from '../src/io/loadPtx';
import { loadXyz } from '../src/io/loadXyz';
import { loadPnts } from '../src/io/loadPnts';
import { loadE57 } from '../src/io/loadE57';
import { parseE57Header } from '../src/io/e57/header';

const enc = new TextEncoder();
const ascii = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

/** Largest single typed-array allocation seen while `fn` runs, in bytes. */
async function peakAllocation(fn: () => Promise<unknown>): Promise<{ bytes: number; error: unknown }> {
  let peak = 0;
  const saved = new Map<string, unknown>();
  const names = ['Float64Array', 'Float32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int32Array', 'ArrayBuffer'] as const;
  for (const n of names) {
    const Orig = (globalThis as Record<string, unknown>)[n] as new (...a: unknown[]) => { byteLength: number };
    saved.set(n, Orig);
    const Wrapped = new Proxy(Orig, {
      construct(target, args, newTarget) {
        if (typeof args[0] === 'number') {
          const per = n === 'ArrayBuffer' ? 1 : (Orig as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
          peak = Math.max(peak, args[0] * per);
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    (globalThis as Record<string, unknown>)[n] = Wrapped;
  }
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    for (const [n, v] of saved) (globalThis as Record<string, unknown>)[n] = v;
  }
  return { bytes: peak, error };
}

/** Headroom over the input size an honest decode of these tiny buffers may use. */
const ALLOC_LIMIT = 1 << 20;

async function expectRefused(fn: () => Promise<unknown>): Promise<void> {
  const { bytes, error } = await peakAllocation(fn);
  expect(error, 'loader accepted an inflated header').toBeInstanceOf(LoadError);
  expect(bytes).toBeLessThan(ALLOC_LIMIT);
}

afterEach(() => undefined);

function lasHeader(opts: { pdrf: number; recordLength: number; count: number; extra?: number }): ArrayBuffer {
  const HEADER = 227;
  const buf = new ArrayBuffer(HEADER + (opts.extra ?? 40));
  const v = new DataView(buf);
  new Uint8Array(buf).set([0x4c, 0x41, 0x53, 0x46]);
  v.setUint8(24, 1);
  v.setUint8(25, 2);
  v.setUint16(94, HEADER, true);
  v.setUint32(96, HEADER, true);
  v.setUint8(104, opts.pdrf);
  v.setUint16(105, opts.recordLength, true);
  v.setUint32(107, opts.count, true);
  for (let a = 0; a < 3; a++) v.setFloat64(131 + a * 8, 0.001, true);
  return buf;
}

describe('LAS / LAZ', () => {
  it('never allocates for more points than an uncompressed body holds', async () => {
    // Uncompressed LAS clamps a short body to the records present (a truncated
    // download stays readable); the allocation must follow the bytes.
    const { bytes } = await peakAllocation(() =>
      loadLas(lasHeader({ pdrf: 0, recordLength: 20, count: 0xffffffff }), 'las'),
    );
    expect(bytes).toBeLessThan(ALLOC_LIMIT);
  });

  it('refuses an inflated record length', async () => {
    await expectRefused(() => loadLas(lasHeader({ pdrf: 0, recordLength: 0xffff, count: 5 }), 'las'));
  });

  it('refuses a LAZ header declaring billions of points behind a few bytes', async () => {
    await expectRefused(() => loadLas(lasHeader({ pdrf: 0x80, recordLength: 20, count: 0xffffffff }), 'laz'));
  }, 20_000);
});

describe('PLY', () => {
  it('refuses an ascii vertex count past the body', async () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 1000000000\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n4 5 6\n';
    await expectRefused(() => loadPly(ascii(text)));
  });

  it('refuses a binary vertex count past the body', async () => {
    const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 1000000000\nproperty double x\nproperty double y\nproperty double z\nend_header\n';
    const h = enc.encode(head);
    const buf = new Uint8Array(h.length + 48);
    buf.set(h);
    await expectRefused(() => loadPly(buf.buffer));
  });

  it('refuses a binary list whose length prefix runs past the body', async () => {
    const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 4000000000\nproperty list uint int vertex_indices\nend_header\n';
    const h = enc.encode(head);
    const buf = new Uint8Array(h.length + 16);
    buf.set(h);
    new DataView(buf.buffer).setUint32(h.length + 12, 0xffffffff, true);
    await expectRefused(() => loadPly(buf.buffer));
  });
});

describe('PCD', () => {
  const pcdHead = (data: string, points: number): string =>
    `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${points}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points}\nDATA ${data}\n`;

  it('refuses a binary POINTS count past the body', async () => {
    const h = enc.encode(pcdHead('binary', 1_000_000_000));
    const buf = new Uint8Array(h.length + 24);
    buf.set(h);
    await expectRefused(() => loadPcd(buf.buffer));
  });

  it('refuses a binary_compressed chunk whose sizes exceed the file', async () => {
    const h = enc.encode(pcdHead('binary_compressed', 1_000_000_000));
    const buf = new Uint8Array(h.length + 16);
    buf.set(h);
    const v = new DataView(buf.buffer);
    v.setUint32(h.length, 0xfffffff0, true); // compressed size
    v.setUint32(h.length + 4, 0xfffffff0, true); // decompressed size
    await expectRefused(() => loadPcd(buf.buffer));
  });

  it('refuses a binary_compressed chunk that would inflate past its bound', async () => {
    const h = enc.encode(pcdHead('binary_compressed', 1_000_000_000));
    const buf = new Uint8Array(h.length + 16);
    buf.set(h);
    const v = new DataView(buf.buffer);
    v.setUint32(h.length, 8, true);
    v.setUint32(h.length + 4, 0xfffffff0, true);
    await expectRefused(() => loadPcd(buf.buffer));
  });

  it('an ascii POINTS count past the body allocates only for the rows present', async () => {
    // Ascii degrades to the real rows (see loadPcd.test.ts) rather than refusing.
    const { bytes, error } = await peakAllocation(() => loadPcd(ascii(pcdHead('ascii', 1_000_000_000) + '1 2 3\n')));
    expect(error).toBeUndefined();
    expect(bytes).toBeLessThan(ALLOC_LIMIT);
  });
});

describe('PTS / PTX / XYZ', () => {
  it('PTS: an inflated declared count allocates only for the lines present', async () => {
    const { bytes, error } = await peakAllocation(() => loadPts(ascii('4000000000\n1 2 3\n4 5 6\n')));
    expect(error).toBeUndefined();
    expect(bytes).toBeLessThan(ALLOC_LIMIT);
  });

  it('PTX: an inflated grid is not allocated', async () => {
    const block = '100000 100000\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n1 2 3 0.5\n';
    const { bytes } = await peakAllocation(() => loadPtx(ascii(block)));
    expect(bytes).toBeLessThan(ALLOC_LIMIT);
  });

  it('XYZ: a very long token line does not hang or over-allocate', async () => {
    const { bytes } = await peakAllocation(() => loadXyz(ascii(`${'9'.repeat(200_000)} 1 2\n1 2 3\n`)));
    expect(bytes).toBeLessThan(ALLOC_LIMIT);
  });
});

function pntsWith(ft: Record<string, unknown>, binBytes: number, lengths?: Partial<Record<'ftJson' | 'ftBin' | 'btJson' | 'btBin', number>>): ArrayBuffer {
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const j = enc.encode(json);
  const total = 28 + j.length + binBytes;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  v.setUint32(0, 0x73746e70, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, total, true);
  v.setUint32(12, lengths?.ftJson ?? j.length, true);
  v.setUint32(16, lengths?.ftBin ?? binBytes, true);
  v.setUint32(20, lengths?.btJson ?? 0, true);
  v.setUint32(24, lengths?.btBin ?? 0, true);
  new Uint8Array(buf, 28, j.length).set(j);
  return buf;
}

describe('3D Tiles pnts', () => {
  it('refuses POINTS_LENGTH past the binary body', async () => {
    await expectRefused(() => loadPnts(pntsWith({ POINTS_LENGTH: 1_000_000_000, POSITION: { byteOffset: 0 } }, 24)));
  });

  it('refuses a feature-table JSON length past the tile', async () => {
    await expectRefused(() => loadPnts(pntsWith({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } }, 16, { ftJson: 0x7ffffff8 })));
  });

  it('refuses a batch-table length past the tile', async () => {
    await expectRefused(() => loadPnts(pntsWith({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } }, 16, { btBin: 0x7ffffff8 })));
  });
});

const E57_FIXTURE = fileURLToPath(new URL('./fixtures/synthetic.e57', import.meta.url));

describe('E57', () => {
  const base = (): Uint8Array => new Uint8Array(readFileSync(E57_FIXTURE));

  it('refuses a header whose file length exceeds the buffer', async () => {
    const b = base();
    new DataView(b.buffer).setBigUint64(16, 1n << 50n, true);
    await expectRefused(() => loadE57(b.buffer as ArrayBuffer));
  });

  it('refuses an XML section length past the file', async () => {
    const b = base();
    new DataView(b.buffer).setBigUint64(32, 1n << 40n, true);
    await expectRefused(() => loadE57(b.buffer as ArrayBuffer));
  });

  it('refuses an XML section offset past the file', async () => {
    const b = base();
    new DataView(b.buffer).setBigUint64(24, 1n << 40n, true);
    await expectRefused(() => loadE57(b.buffer as ArrayBuffer));
  });

  it('header parse throws LoadError on a lying length', () => {
    const b = base();
    new DataView(b.buffer).setBigUint64(16, 1n << 50n, true);
    expect(() => parseE57Header(b.buffer as ArrayBuffer)).toThrow(LoadError);
  });
});
