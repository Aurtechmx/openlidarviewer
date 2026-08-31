/**
 * incrementalSha256.test.ts — the streaming SHA-256 is FIPS-correct, matches the
 * platform Web Crypto, and is invariant to how the input is chunked.
 *
 * The last property is the one the OOC cache depends on: a file fed a window at
 * a time must produce the same digest as the whole file at once, or a persisted
 * source-content digest would depend on the read size and never match.
 */

import { describe, it, expect } from 'vitest';
import { IncrementalSha256, incrementalSha256Hex } from '../src/io/heavy/incrementalSha256';

const enc = new TextEncoder();

/** Published FIPS 180-4 / NIST example vectors. */
const VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

describe('IncrementalSha256', () => {
  it('matches the published FIPS 180-4 vectors', () => {
    for (const [msg, want] of VECTORS) {
      expect(incrementalSha256Hex(enc.encode(msg))).toBe(want);
    }
  });

  it('matches Web Crypto for random inputs of many lengths', async () => {
    // Lengths straddling block boundaries (55/56/64/65) and the length-suffix
    // edge, plus a large multi-block input.
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 100_003];
    for (const n of lengths) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 2654435761) & 0xff;
      const ref = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      let refHex = '';
      for (const b of ref) refHex += b.toString(16).padStart(2, '0');
      expect(incrementalSha256Hex(bytes), `len ${n}`).toBe(refHex);
    }
  });

  it('is invariant to chunk boundaries', () => {
    const n = 5000;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 40503) & 0xff;
    const whole = incrementalSha256Hex(bytes);
    for (const chunk of [1, 7, 63, 64, 65, 500, 4096]) {
      const h = new IncrementalSha256();
      for (let i = 0; i < n; i += chunk) h.update(bytes.subarray(i, Math.min(i + chunk, n)));
      expect(h.digestHex(), `chunk ${chunk}`).toBe(whole);
    }
  });

  it('refuses update after digest', () => {
    const h = new IncrementalSha256();
    h.update(enc.encode('abc'));
    h.digestHex();
    expect(() => h.update(enc.encode('x'))).toThrow(/after digest/);
  });

  it('refuses a second digest', () => {
    const h = new IncrementalSha256();
    h.update(enc.encode('abc'));
    h.digestHex();
    expect(() => h.digestHex()).toThrow(/twice/);
  });
});
