/**
 * formatProbes.test.ts
 *
 * The scored probe registry behind "open any point cloud": each probe, level
 * assignment, progressive widening, byte statistics, the failure report and
 * its redaction, and the byte-for-byte regression against `sniffFormat` over
 * every fixture.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { sniffFormat } from '../src/io/sniffFormat';
import {
  byteEntropy,
  chooseFormat,
  compareLevels,
  detectStride,
  foreignSignature,
  isDecisive,
  looksLikeText,
  runProbes,
  type ProbeInput,
} from '../src/io/probe/formatProbes';
import { MAX_PROBE_BYTES, PROBE_WINDOWS, PROBE_WORKER_TIME_CAP_MS, probeProgressively } from '../src/io/probe/progressiveProbe';
import {
  buildOpenFailureFacts,
  openFailureReportText,
  openFailureSummary,
} from '../src/io/probe/openFailureReport';
import {
  __setProbeWorkerFactoryForTests,
  ProbeCancelledError,
  resolveUnknownBuffer,
  resolveUnknownFormat,
} from '../src/io/probe/formatProbeWorkerClient';
import { LoadError, describeLoadError } from '../src/io/loadErrors';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const inp = (bytes: Uint8Array, ext = '', complete = true): ProbeInput => ({ bytes, ext, complete });

/** Deterministic pseudo-random bytes (xorshift). */
function noise(n: number, seed = 12345): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function lasHeader(compressed: boolean): Uint8Array {
  const b = new Uint8Array(400);
  b.set(enc('LASF'));
  b[104] = compressed ? 0x83 : 0x03;
  return b;
}

const xyzText = Array.from({ length: 20 }, (_, i) => `${i}.5 ${i * 2}.25 ${-i}.125`).join('\n') + '\n';

function levelOf(bytes: Uint8Array, format: string, ext = ''): string {
  return runProbes(inp(bytes, ext)).find((r) => r.decoderId === format)!.level;
}

describe('probe registry: each probe', () => {
  it('verifies signatures', () => {
    const e57 = new Uint8Array(48); e57.set(enc('ASTM-E57')); e57[8] = 1; e57[41] = 4;
    expect(levelOf(e57, 'e57')).toBe('VERIFIED');
    expect(levelOf(enc('ASTM-E57\0\0\0\0'), 'e57')).toBe('COMPATIBLE');
    expect(levelOf(enc('ply\nformat ascii 1.0\nelement vertex 1\nend_header\n'), 'ply')).toBe('VERIFIED');
    expect(levelOf(enc('ply\nformat ascii 1.0\n'), 'ply')).toBe('COMPATIBLE');
    expect(levelOf(lasHeader(false), 'las')).toBe('COMPATIBLE');
    expect(levelOf(lasHeader(true), 'laz')).toBe('COMPATIBLE');
    expect(levelOf(lasHeader(true), 'las')).toBe('OPAQUE');
    const glb = new Uint8Array(20); glb.set(enc('glTF')); glb[4] = 2; glb[8] = 20;
    expect(levelOf(glb, 'glb')).toBe('VERIFIED');
    const pnts = new Uint8Array(28); pnts.set(enc('pnts')); pnts[4] = 1; pnts[8] = 28;
    expect(levelOf(pnts, 'pnts')).toBe('VERIFIED');
    expect(levelOf(enc('# .PCD\nVERSION 0.7\nFIELDS x y z\nDATA ascii\n'), 'pcd')).toBe('VERIFIED');
    expect(levelOf(enc('# .PCD\nVERSION 0.7\nFIELDS x y z\n'), 'pcd')).toBe('COMPATIBLE');
  });

  it('finds compatible content structure for text formats', () => {
    expect(levelOf(enc(xyzText), 'xyz')).toBe('PROBABLE');
    expect(levelOf(enc('3\n1 2 3 4 5 6 7\n1 2 3 4 5 6 7\n1 2 3 4 5 6 7\n'), 'pts')).toBe('PROBABLE');
    expect(levelOf(enc('# mesh\nv 1 2 3\nv 4 5 6\nv 7 8 9\nf 1 2 3\n'), 'obj')).toBe('PROBABLE');
    expect(levelOf(enc('{ "asset": { "version": "2.0" } }'), 'gltf')).toBe('PROBABLE');
    const ptx = ['2', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1', '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1', '1 2 3 0.5', '1 2 3 0.5'].join('\n') + '\n';
    expect(levelOf(enc(ptx), 'ptx')).toBe('PROBABLE');
  });

  it('treats the extension as weak evidence', () => {
    // Extension alone reaches PROBABLE for a signature format (legacy routing,
    // the decoder refuses by name) but never overrides contradicting content.
    expect(levelOf(noise(2048), 'e57', 'e57')).toBe('PROBABLE');
    expect(levelOf(noise(2048), 'xyz', 'xyz')).toBe('OPAQUE');
    expect(levelOf(noise(2048), 'xyz', 'bin')).toBe('OPAQUE');
    const withExt = runProbes(inp(enc(xyzText), 'xyz')).find((r) => r.decoderId === 'xyz')!;
    const without = runProbes(inp(enc(xyzText), 'dat')).find((r) => r.decoderId === 'xyz')!;
    expect(withExt.confidence).toBeGreaterThan(without.confidence);
  });

  it('separates a validated header from a signature alone', () => {
    const valid = lasHeader(false);
    valid[24] = 1; valid[25] = 2; valid[94] = 227; valid[96] = 227;
    expect(levelOf(valid, 'las')).toBe('VERIFIED');
    expect(levelOf(lasHeader(false), 'las')).toBe('COMPATIBLE');
    const truncated = runProbes(inp(enc('LASF0000'), 'las')).find((r) => r.decoderId === 'las')!;
    expect(truncated.level).toBe('COMPATIBLE');
    expect(truncated.requiredBytes).toBe(375);
  });

  it('rejects inconsistent numeric tables', () => {
    expect(levelOf(enc('1 2 3\n1 2\n1 2 3\n1 2 3\n'), 'xyz')).toBe('OPAQUE');
    expect(levelOf(enc('hello world\nthis is prose\n'), 'xyz')).toBe('OPAQUE');
  });
});

describe('level assignment and the decision', () => {
  it('orders levels without numbers', () => {
    expect(compareLevels('VERIFIED', 'COMPATIBLE')).toBeGreaterThan(0);
    expect(compareLevels('PROBABLE', 'COMPATIBLE')).toBeLessThan(0);
    expect(compareLevels('RECOVERED', 'PREVIEW_ONLY')).toBeGreaterThan(0);
    expect(compareLevels('OPAQUE', 'NOT_POINT_CLOUD')).toBeGreaterThan(0);
    expect(isDecisive('COMPATIBLE')).toBe(true);
    expect(isDecisive('NOT_POINT_CLOUD')).toBe(true);
    expect(isDecisive('PROBABLE')).toBe(false);
    expect(isDecisive('OPAQUE')).toBe(false);
  });

  it('opens a renamed LAS by signature whatever the extension', () => {
    const d = chooseFormat(inp(lasHeader(false), 'bin'));
    expect(d).toMatchObject({ decoderId: 'las', level: 'COMPATIBLE' });
  });

  it('opens unknown-extension text by content', () => {
    expect(chooseFormat(inp(enc(xyzText), 'dat'))).toMatchObject({ decoderId: 'xyz', level: 'PROBABLE' });
  });

  it('marks known non point cloud signatures NOT_POINT_CLOUD', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const d = chooseFormat(inp(png, 'png'));
    expect(d.level).toBe('NOT_POINT_CLOUD');
    expect(d.decoderId).toBeNull();
    // No extension overrides a contradicting signature.
    expect(chooseFormat(inp(png, 'xyz'))).toMatchObject({ decoderId: null, level: 'NOT_POINT_CLOUD' });
    expect(foreignSignature(new Uint8Array([0x1f, 0x8b, 8]))?.kind).toBe('compressed');
    expect(foreignSignature(enc('%PDF-1.7'))?.kind).toBe('document');
  });

  it('leaves a packet capture OPAQUE (recognised, not decodable)', () => {
    const cap = new Uint8Array(64);
    cap.set([0xd4, 0xc3, 0xb2, 0xa1]);
    const d = chooseFormat(inp(cap, 'pcap'));
    expect(d.decoderId).toBeNull();
    expect(d.level).toBe('OPAQUE');
    expect(d.foreign?.kind).toBe('capture');
  });

  it('random bytes decide nothing', () => {
    expect(chooseFormat(inp(noise(4096), 'bin'))).toMatchObject({ decoderId: null, level: 'OPAQUE' });
  });
});

describe('regression: identical to sniffFormat for every file it recognises', () => {
  const root = resolve(__dirname, 'fixtures');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);

  it('covers the fixture tree', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('chooses the same format on every fixture sniffFormat recognises', () => {
    let compared = 0;
    for (const f of files) {
      const buf = readFileSync(f);
      const head = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 16384)).slice();
      const legacy = sniffFormat(head.buffer, f);
      if (legacy === 'unknown') continue;
      const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase();
      expect(chooseFormat(inp(head, ext, head.length >= buf.byteLength)).decoderId, f).toBe(legacy);
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('matches sniffFormat for every known extension unless the content contradicts it', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = new Set(['obj', 'gltf', 'xyz', 'csv', 'asc', 'txt', 'ptx', 'pts']);
    for (const ext of ['obj', 'ply', 'las', 'laz', 'glb', 'gltf', 'xyz', 'csv', 'asc', 'txt', 'e57', 'pcd', 'ptx', 'pts', 'pnts']) {
      const legacy = (b: Uint8Array) => sniffFormat(b.slice().buffer, `a.${ext}`);
      expect(chooseFormat(inp(enc(xyzText), ext)).decoderId, ext).toBe(legacy(enc(xyzText)));
      // Binary noise under a text-only extension: contradicted, so refused.
      expect(chooseFormat(inp(noise(512), ext)).decoderId, ext).toBe(text.has(ext) ? null : legacy(noise(512)));
      // A non point cloud signature is never overridden by the extension.
      expect(chooseFormat(inp(png, ext)).decoderId, ext).toBeNull();
    }
    const shortLas = enc('LASF0000');
    for (const ext of ['laz', 'las', 'bin']) {
      expect(chooseFormat(inp(shortLas, ext)).decoderId).toBe(sniffFormat(shortLas.slice().buffer, `a.${ext}`));
    }
  });
});

describe('progressive widening', () => {
  function reader(bytes: Uint8Array) {
    const reads: number[] = [];
    return {
      reads,
      read: async (n: number) => {
        reads.push(n);
        return bytes.slice(0, n);
      },
    };
  }

  it('stops at the first window when a signature is decisive', async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set(lasHeader(false));
    const r = reader(bytes);
    const res = await probeProgressively(r.read, bytes.length, 'x.bin');
    expect(res.decision.decoderId).toBe('las');
    expect(r.reads).toEqual([PROBE_WINDOWS[0]]);
  });

  it('widens through every window to the 1 MiB cap when nothing decides', async () => {
    const bytes = noise(3 * 1024 * 1024);
    const r = reader(bytes);
    const res = await probeProgressively(r.read, bytes.length, 'x.bin');
    expect(r.reads).toEqual([...PROBE_WINDOWS]);
    expect(Math.max(...r.reads)).toBe(1024 * 1024);
    expect(res.sample.length).toBe(MAX_PROBE_BYTES);
    expect(res.bound).toBe('max-bytes');
  });

  it('turns a failed read into a bound, not an exception', async () => {
    const res = await probeProgressively(async () => { throw new Error('gone'); }, 1 << 20, 'x.bin', noise(16384));
    expect(res.bound).toBe('read-failed');
    expect(res.decision.level).toBe('OPAQUE');
  });

  it('never reads past the end of a small file and reuses a head already held', async () => {
    const bytes = noise(100 * 1024);
    const r = reader(bytes);
    await probeProgressively(r.read, bytes.length, 'x.bin', bytes.slice(0, 16384));
    expect(r.reads).toEqual([64 * 1024, 100 * 1024]);
  });

  it('decides on a wider window when structure starts past the head', async () => {
    // Content only becomes readable once the window reaches whole rows beyond
    // a long first line.
    const long = '#' + 'x'.repeat(20000) + '\n' + xyzText;
    const bytes = enc(long);
    const r = reader(bytes);
    const res = await probeProgressively(r.read, bytes.length, 'x.dat');
    expect(res.decision.decoderId).toBe('xyz');
    expect(r.reads.length).toBeGreaterThan(1);
  });
});

describe('byte statistics', () => {
  it('entropy: 0 for constant bytes, near 8 for noise, low for text', () => {
    expect(byteEntropy(new Uint8Array(1000).fill(7))).toBe(0);
    expect(byteEntropy(noise(65536))).toBeGreaterThan(7.9);
    expect(byteEntropy(enc(xyzText))).toBeLessThan(4);
  });

  it('text vs binary', () => {
    expect(looksLikeText(enc(xyzText))).toBe(true);
    expect(looksLikeText(noise(1000))).toBe(false);
  });

  it('detects a fixed record size from autocorrelation', () => {
    for (const stride of [12, 28, 100]) {
      const n = 2000;
      const rnd = noise(stride * n, stride);
      const b = new Uint8Array(stride * n);
      for (let r = 0; r < n; r++) {
        const o = r * stride;
        b.set(rnd.subarray(o, o + stride), o);
        b[o] = 0xaa; b[o + 1] = 0x55; b[o + 2] = r & 0xff; b[o + 3] = 0;
      }
      expect(detectStride(b), `stride ${stride}`).toBe(stride);
    }
  });

  it('finds no stride in noise or in constant bytes', () => {
    expect(detectStride(noise(65536))).toBeNull();
    expect(detectStride(new Uint8Array(65536))).toBeNull();
  });
});

describe('failure report', () => {
  const name = '/Users/someone/private/site-A/scan 12.bin';

  it('reports size, content, entropy, stride and explanations for noise', () => {
    const sample = noise(65536);
    const facts = buildOpenFailureFacts(chooseFormat(inp(sample, 'bin', false)), sample, 5_000_000, name);
    expect(facts).toMatchObject({ verdict: 'OPAQUE', content: 'binary', extension: 'bin', signature: null, recordSizeBytes: null });
    expect(facts.entropyBitsPerByte).toBeGreaterThan(7.9);
    expect(facts.explanations.join(' ')).toMatch(/compressed or encrypted/);
    expect(facts.explanations.join(' ')).toMatch(/companion file/);
    const text = openFailureReportText(facts);
    expect(text).toMatch(/Size: .*\(5000000 bytes\)/);
    expect(text).toMatch(/Byte entropy: \d\.\d\d bits per byte/);
    expect(openFailureSummary(facts)).toMatch(/not recognised as a point cloud/);
    expect(openFailureSummary(facts)).not.toMatch(/%|confidence/i);
  });

  it('never carries the file name, path or content', () => {
    const sample = enc('secret 1 2\n'.repeat(50));
    const facts = buildOpenFailureFacts(chooseFormat(inp(sample, 'bin')), sample, sample.length, name);
    const all = openFailureReportText(facts) + openFailureSummary(facts);
    for (const bad of ['someone', 'private', 'site-A', 'scan 12', 'secret', '/Users']) expect(all).not.toContain(bad);
  });

  it('drops an extension that is not short and plain', () => {
    const facts = buildOpenFailureFacts(chooseFormat(inp(noise(64))), noise(64), 64, 'a.my-long.extension-name');
    expect(facts.extension).toBe('');
  });

  it('names a recognised stride', () => {
    const b = new Uint8Array(28 * 2000);
    const rnd = noise(b.length, 9);
    for (let r = 0; r < 2000; r++) { b.set(rnd.subarray(r * 28, r * 28 + 28), r * 28); b[r * 28] = 0xaa; b[r * 28 + 1] = 0x55; }
    const facts = buildOpenFailureFacts(chooseFormat(inp(b, 'bin')), b, b.length, 'x.bin');
    expect(facts.recordSizeBytes).toBe(28);
    expect(openFailureReportText(facts)).toMatch(/Fixed record size: 28 bytes/);
  });

  it('says what a non point cloud file is', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const facts = buildOpenFailureFacts(chooseFormat(inp(png, 'png')), png, png.length, 'photo.png');
    expect(openFailureSummary(facts)).toMatch(/PNG image, not a point cloud/);
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]);
    expect(openFailureSummary(buildOpenFailureFacts(chooseFormat(inp(zip, 'zip')), zip, 6, 'a.zip'))).toMatch(/Extract it/);
  });

  it('public prose has no em dashes', () => {
    const sample = noise(4096);
    const facts = buildOpenFailureFacts(chooseFormat(inp(sample, 'bin')), sample, 4096, 'a.bin');
    expect(openFailureReportText(facts) + openFailureSummary(facts)).not.toMatch(/\u2014/);
  });
});

describe('resolving an unknown file', () => {
  const fileOf = (bytes: Uint8Array, name: string): File =>
    ({ name, size: bytes.length, slice: (s = 0, e = bytes.length) => ({ arrayBuffer: async () => bytes.slice(s, e).buffer }) }) as unknown as File;

  it('opens content-compatible text and throws the report otherwise (inline path)', async () => {
    __setProbeWorkerFactoryForTests(null);
    try {
      const t = enc(xyzText);
      await expect(resolveUnknownFormat(fileOf(t, 'a.dat'), t.slice().buffer)).resolves.toBe('xyz');
      const big = noise(300 * 1024);
      const err = await resolveUnknownFormat(fileOf(big, 'a.bin'), big.slice(0, 16384).buffer).catch((e) => e);
      expect(err).toBeInstanceOf(LoadError);
      expect(err.category).toBe('unsupported-format');
      expect(err.report).toMatch(/Sampled: 1048576 bytes|Sampled: 307200 bytes/);
      expect(describeLoadError(err)).toBe(err.message);
    } finally {
      __setProbeWorkerFactoryForTests();
    }
  });

  it('decides on a buffer already in memory', () => {
    expect(resolveUnknownBuffer(enc(xyzText).slice().buffer, 'a.dat')).toBe('xyz');
    expect(() => resolveUnknownBuffer(noise(1000).slice().buffer, 'a.bin')).toThrow(LoadError);
  });

  it('keeps the canned message for a LoadError without a report', () => {
    expect(describeLoadError(new LoadError('unsupported-format', 'x'))).toMatch(/supported/);
  });
});

describe('phase A fixture matrix', () => {
  const fixture = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', n)));
  /** A File stand-in that records every byte range read. */
  function trackedFile(size: number, name: string, bytesAt: (s: number, e: number) => Uint8Array) {
    const reads: Array<[number, number]> = [];
    const file = {
      name,
      size,
      slice: (s = 0, e = size) => {
        reads.push([s, e]);
        return { arrayBuffer: async () => bytesAt(s, Math.min(e, size)).slice().buffer };
      },
    } as unknown as File;
    return { file, reads };
  }
  const fileOf = (b: Uint8Array, name: string) => trackedFile(b.length, name, (s, e) => b.subarray(s, e));
  async function outcome(b: Uint8Array, name: string): Promise<string> {
    const { file } = fileOf(b, name);
    try {
      return await resolveUnknownFormat(file, b.slice(0, 16384).buffer);
    } catch (e) {
      return `refused: ${(e as LoadError).report?.match(/Verdict: (\w+)/)?.[1]}`;
    }
  }

  it('bounds hold as named constants', () => {
    expect(MAX_PROBE_BYTES).toBe(1024 * 1024);
    expect(PROBE_WORKER_TIME_CAP_MS).toBe(3000);
  });

  it('opens each case the way the spec says', async () => {
    __setProbeWorkerFactoryForTests(null);
    try {
      // Known format, wrong extension; and no extension at all.
      expect(await outcome(fixture('tiny.las'), 'tiny.bin')).toBe('las');
      expect(await outcome(fixture('tiny.ply'), 'scan')).toBe('ply');
      expect(await outcome(fixture('tiny.pcd'), 'cloud.dat')).toBe('pcd');
      // Truncated LAS header: still LAS by signature (COMPATIBLE); the decoder has the final word.
      const trunc = fixture('tiny.las').slice(0, 60);
      expect(chooseFormat(inp(trunc, 'las'))).toMatchObject({ decoderId: 'las', level: 'COMPATIBLE' });
      // Malformed header: signature present, fields out of range.
      const bad = fixture('tiny.las').slice();
      bad[24] = 9;
      expect(chooseFormat(inp(bad.subarray(0, 16384), 'las', false))).toMatchObject({ decoderId: 'las', level: 'COMPATIBLE' });
      expect(chooseFormat(inp(fixture('tiny.las').subarray(0, 16384), 'las', false)).level).toBe('VERIFIED');
      // Random binary, deflate data, PNG.
      expect(await outcome(noise(200 * 1024), 'x.bin')).toBe('refused: OPAQUE');
      const deflated = new Uint8Array(deflateRawSync(Buffer.from(noise(400 * 1024).map((v) => v % 16))));
      expect(await outcome(deflated, 'x.dat')).toBe('refused: OPAQUE');
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...noise(3000)]);
      expect(await outcome(png, 'image.png')).toBe('refused: NOT_POINT_CLOUD');
      // Text points route to the existing XYZ loader, whatever the name.
      expect(await outcome(enc(xyzText), 'points.dat')).toBe('xyz');
      expect(await outcome(enc(xyzText), 'points')).toBe('xyz');
    } finally {
      __setProbeWorkerFactoryForTests();
    }
  });

  it('reads at most 1 MiB of a large sparse file', async () => {
    __setProbeWorkerFactoryForTests(null);
    try {
      const size = 64 * 1024 ** 3;
      const { file, reads } = trackedFile(size, 'sparse.raw', (s, e) => new Uint8Array(e - s));
      const err = await resolveUnknownFormat(file, new Uint8Array(16384).buffer).catch((e) => e);
      expect(err).toBeInstanceOf(LoadError);
      expect(err.report).toMatch(/Verdict: OPAQUE/);
      expect(err.report).toMatch(/Probe limit reached: max-bytes/);
      const furthest = Math.max(...reads.map(([, e]) => e));
      expect(furthest).toBeLessThanOrEqual(MAX_PROBE_BYTES);
      expect(reads.every(([s]) => s === 0)).toBe(true);
    } finally {
      __setProbeWorkerFactoryForTests();
    }
  });

  it('a worker that exceeds the time cap yields OPAQUE with the reason, not an exception', async () => {
    const silent = { postMessage() {}, terminate() {}, onmessage: null, onerror: null } as unknown as Worker;
    __setProbeWorkerFactoryForTests(() => silent, 20);
    const hadWorker = 'Worker' in globalThis;
    (globalThis as { Worker?: unknown }).Worker ??= class {};
    try {
      const b = noise(200 * 1024);
      const err = await resolveUnknownFormat(fileOf(b, 'x.bin').file, b.slice(0, 16384).buffer).catch((e) => e);
      expect(err).toBeInstanceOf(LoadError);
      expect(err.report).toMatch(/Verdict: OPAQUE/);
      expect(err.report).toMatch(/Probe limit reached: time-cap/);
    } finally {
      if (!hadWorker) delete (globalThis as { Worker?: unknown }).Worker;
      __setProbeWorkerFactoryForTests();
    }
  });

  it('is cancellable', async () => {
    const silent = { postMessage() {}, terminate() {}, onmessage: null, onerror: null } as unknown as Worker;
    __setProbeWorkerFactoryForTests(() => silent, 10_000);
    const hadWorker = 'Worker' in globalThis;
    (globalThis as { Worker?: unknown }).Worker ??= class {};
    try {
      const b = noise(200 * 1024);
      const ac = new AbortController();
      const p = resolveUnknownFormat(fileOf(b, 'x.bin').file, b.slice(0, 16384).buffer, ac.signal);
      ac.abort();
      await expect(p).rejects.toBeInstanceOf(ProbeCancelledError);
    } finally {
      if (!hadWorker) delete (globalThis as { Worker?: unknown }).Worker;
      __setProbeWorkerFactoryForTests();
    }
  });
});
