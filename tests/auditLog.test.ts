import { describe, test, expect } from 'vitest';
import {
  canonicalize,
  fnv1a,
  AuditLog,
  verifyAuditChain,
  type AuditEntry,
} from '../src/render/measure/auditLog';

describe('canonicalize', () => {
  test('is independent of object key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  test('preserves array order (it is meaningful)', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  test('handles nesting, null, and strings', () => {
    expect(canonicalize({ x: [{ b: null, a: 'hi' }] })).toBe('{"x":[{"a":"hi","b":null}]}');
  });

  test('skips undefined-valued keys, matching JSON.stringify', () => {
    // A key set to undefined is dropped by JSON.stringify when written to a file,
    // so canonicalize must ignore it too — otherwise a digest computed before the
    // write would not verify after a read.
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('AuditLog hash chain', () => {
  test('each entry links to the previous, and an intact chain verifies', () => {
    const log = new AuditLog();
    log.append('reclassify', { cloud: 'a', from: 1, to: 6, changed: 1200 });
    log.append('measure.volume', { value: 1254, sigma: 41, confidence: 'medium' });
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].hash).not.toBe(log.entries[1].hash);
    expect(verifyAuditChain(log.entries)).toBe(-1);
  });

  test('tampering with any entry breaks the chain from that point', () => {
    const log = new AuditLog();
    log.append('measure.volume', { value: 1254, sigma: 41 });
    log.append('export', { format: 'las' });
    // Forge a smaller uncertainty on entry 0, keeping its old hash.
    const forged: AuditEntry[] = [
      { ...log.entries[0], data: { value: 1254, sigma: 5 } },
      log.entries[1],
    ];
    expect(verifyAuditChain(forged)).toBe(0);
  });

  test('reordering entries is detected', () => {
    const log = new AuditLog();
    log.append('a', { n: 1 });
    log.append('b', { n: 2 });
    const swapped = [log.entries[1], log.entries[0]];
    expect(verifyAuditChain(swapped)).toBe(0); // seq mismatch at index 0
  });

  test('the same sequence of appends is deterministic across logs', () => {
    const a = new AuditLog();
    const b = new AuditLog();
    for (const log of [a, b]) {
      log.append('reclassify', { to: 2 });
      log.append('measure.area', { value: 318.4, sigma: 6 });
    }
    expect(a.serialize()).toBe(b.serialize());
    expect(a.head).toBe(b.head);
  });

  test('an empty log has the genesis head and verifies', () => {
    const log = new AuditLog();
    expect(log.head).toBe('0');
    expect(verifyAuditChain(log.entries)).toBe(-1);
  });

  test('an injected hash function is used end-to-end', () => {
    const tag: typeof fnv1a = (s) => `H(${s.length})`;
    const log = new AuditLog(tag);
    const e = log.append('x', { a: 1 });
    expect(e.hash.startsWith('H(')).toBe(true);
    expect(verifyAuditChain(log.entries, tag)).toBe(-1);
    // Verifying with the wrong hash function flags entry 0.
    expect(verifyAuditChain(log.entries, fnv1a)).toBe(0);
  });
});

import { sha256 as _sha256 } from '../src/render/measure/auditLog';
describe('sha256 (FIPS-180-4 vectors)', () => {
  test('empty string', () => {
    expect(_sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  test('"abc"', () => {
    expect(_sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('multi-block message', () => {
    expect(_sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});
