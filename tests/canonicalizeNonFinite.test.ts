/**
 * canonicalizeNonFinite.test.ts
 *
 * `canonicalize` is the one serializer behind every scientific digest the
 * project writes: the processing manifest chain, the live-DTM descriptor, the
 * DTM product digest, the report manifest, the classifier run and the staged
 * artifact passport. JSON renders NaN, Infinity and -Infinity all as `null`,
 * so without a guard a digest cannot distinguish a failed measurement from an
 * absent one, and two different failures hash alike.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize, sha256 } from '../src/render/measure/auditLog';

describe('canonicalize refuses non-finite numbers', () => {
  it.each([NaN, Infinity, -Infinity])('refuses %s at the top level', (v) => {
    expect(() => canonicalize(v)).toThrow(/not a finite number/);
  });

  it('refuses one nested in an object or an array, at any depth', () => {
    expect(() => canonicalize({ rmseZM: NaN })).toThrow(/not a finite number/);
    expect(() => canonicalize({ accuracy: { nested: { v: Infinity } } })).toThrow(/not a finite number/);
    expect(() => canonicalize([1, 2, -Infinity])).toThrow(/not a finite number/);
    expect(() => canonicalize({ rows: [{ z: NaN }] })).toThrow(/not a finite number/);
  });

  it('states what to do instead', () => {
    expect(() => canonicalize({ v: NaN })).toThrow(/Record the absence explicitly/);
  });

  it('leaves every finite value, null and undefined-key behaviour unchanged', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ crs: null })).toBe('{"crs":null}');
    expect(canonicalize({ crs: undefined, a: 1 })).toBe('{"a":1}');
    expect(canonicalize([0, -0, 1e-7, 1.5, -2])).toBe('[0,0,1e-7,1.5,-2]');
    expect(canonicalize('text')).toBe('"text"');
    expect(canonicalize(true)).toBe('true');
  });

  it('the digest a null field gets is no longer reachable by a non-finite one', () => {
    const withNull = sha256(canonicalize({ rmseZM: null }));
    expect(() => sha256(canonicalize({ rmseZM: NaN }))).toThrow();
    // Pinned so the guard cannot be removed without this reading as a pass.
    expect(withNull).toBe(sha256('{"rmseZM":null}'));
  });
});
