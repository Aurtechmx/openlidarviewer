/**
 * sha256.test.ts
 *
 * Pins the hand-rolled SHA-256 to the published FIPS 180-4 test vectors and the
 * integrity-manifest format. A hash that is even one bit wrong is worse than no
 * hash (it fails verification on a good file), so this is checked against the
 * canonical known-answer vectors, not just self-consistency.
 */

import { describe, it, expect } from 'vitest';
import { sha256Hex, sha256Bytes } from '../src/terrain/export/sha256';
import { buildSha256Manifest } from '../src/terrain/export/demPackage';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sha256 — FIPS 180-4 known-answer vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc"', () => {
    expect(sha256Hex(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the 56-byte NIST multi-block message (crosses the 64-byte boundary)', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(sha256Hex(enc(msg))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes a message longer than one block (1000 zero bytes)', () => {
    // Independently reproducible: sha256 of 1000 NUL bytes.
    expect(sha256Hex(new Uint8Array(1000))).toBe(
      '541b3e9daa09b20bf85fa273e5cbd3e80185aa4ec298e765db87742b70138a53',
    );
  });

  it('returns a 32-byte digest', () => {
    expect(sha256Bytes(enc('abc'))).toHaveLength(32);
  });
});

describe('SHA256SUMS integrity manifest', () => {
  it('emits one `<hex>␠␠<name>` line per entry, in order', () => {
    const entries = [
      { name: 'a.txt', bytes: enc('abc') },
      { name: 'b.txt', bytes: enc('') },
    ];
    const manifest = buildSha256Manifest(entries);
    const lines = manifest.trimEnd().split('\n');
    expect(lines).toEqual([
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.txt',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  b.txt',
    ]);
  });

  it('verifies: every listed digest matches a re-hash of the named bytes', () => {
    const entries = [
      { name: 'grid.asc', bytes: enc('ncols 3\nnrows 3\n1 2 3\n') },
      { name: 'README.txt', bytes: enc('OpenLiDARViewer DEM export\n') },
    ];
    const byName = new Map(entries.map((e) => [e.name, e.bytes]));
    for (const line of buildSha256Manifest(entries).trimEnd().split('\n')) {
      const [hex, name] = line.split('  ');
      expect(sha256Hex(byName.get(name)!)).toBe(hex);
    }
  });
});
