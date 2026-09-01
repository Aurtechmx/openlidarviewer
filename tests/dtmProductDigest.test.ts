import { describe, it, expect } from 'vitest';
import {
  dtmProductDigest,
  DTM_PRODUCT_DIGEST_SCHEMA,
  type DtmProductInput,
} from '../src/science/dtmProductDigest';

/** A small, fully specified 2x2 Float64 surface. Cloned per test so a mutation
 *  in one case never leaks into another. */
function baseDtm(): DtmProductInput {
  return {
    z: Float64Array.from([10.0, 10.5, 11.0, 11.5]),
    coverage: Uint8Array.from([2, 2, 1, 0]),
    cols: 2,
    rows: 2,
    cellSizeM: 0.5,
    originH1: 1000,
    originH2: 2000,
    horizontalEpsg: 32610,
    verticalEpsg: 5703,
  };
}

describe('dtmProductDigest', () => {
  it('is a lowercase 64-char hex string', () => {
    expect(dtmProductDigest(baseDtm())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives two structurally identical surfaces the same digest', () => {
    // Different array instances, same values — same product, same digest.
    expect(dtmProductDigest(baseDtm())).toBe(dtmProductDigest(baseDtm()));
  });

  it('treats an undefined CRS code and an explicit null as one surface', () => {
    const a = { ...baseDtm(), horizontalEpsg: undefined, verticalEpsg: undefined };
    const b = { ...baseDtm(), horizontalEpsg: null, verticalEpsg: null };
    expect(dtmProductDigest(a)).toBe(dtmProductDigest(b));
  });

  it('moves when a single Z cell changes', () => {
    const changed = baseDtm();
    changed.z[2] = 11.0001;
    expect(dtmProductDigest(changed)).not.toBe(dtmProductDigest(baseDtm()));
  });

  it('moves when a coverage state changes', () => {
    const changed = baseDtm();
    changed.coverage[3] = 1; // was 0 (gap) → now interpolated
    expect(dtmProductDigest(changed)).not.toBe(dtmProductDigest(baseDtm()));
  });

  it('moves on a grid-geometry change (origin, cell size, and shape)', () => {
    const ref = dtmProductDigest(baseDtm());
    expect(dtmProductDigest({ ...baseDtm(), originH1: 1000.5 })).not.toBe(ref);
    expect(dtmProductDigest({ ...baseDtm(), cellSizeM: 1.0 })).not.toBe(ref);
    // Same 4 cells, transposed grid shape (2x2 → 4x1) — a different surface.
    expect(dtmProductDigest({ ...baseDtm(), cols: 4, rows: 1 })).not.toBe(ref);
  });

  it('moves when the CRS codes change', () => {
    const ref = dtmProductDigest(baseDtm());
    expect(dtmProductDigest({ ...baseDtm(), horizontalEpsg: 32611 })).not.toBe(ref);
    expect(dtmProductDigest({ ...baseDtm(), verticalEpsg: 5705 })).not.toBe(ref);
  });

  it('binds the surface to methodDigest', () => {
    const noMethod = dtmProductDigest(baseDtm());
    const withA = dtmProductDigest(baseDtm(), 'aaaa');
    const withB = dtmProductDigest(baseDtm(), 'bbbb');
    expect(withA).not.toBe(noMethod);
    expect(withA).not.toBe(withB);
    // Same surface + same method digest ⇒ stable.
    expect(dtmProductDigest(baseDtm(), 'aaaa')).toBe(withA);
  });

  it('captures the float width: equal values as Float32 vs Float64 differ', () => {
    // Values chosen so the two widths agree exactly at every cell (0.5-steps
    // are representable in both), isolating the dtype tag + element width as the
    // sole difference rather than a float-rounding difference.
    const asF64 = baseDtm();
    const asF32: DtmProductInput = { ...baseDtm(), z: Float32Array.from([10.0, 10.5, 11.0, 11.5]) };
    expect(Array.from(asF32.z)).toEqual(Array.from(asF64.z)); // values identical
    expect(dtmProductDigest(asF32)).not.toBe(dtmProductDigest(asF64)); // digests are not
  });

  it('rejects a z array whose length disagrees with cols*rows', () => {
    expect(() => dtmProductDigest({ ...baseDtm(), z: Float64Array.from([1, 2, 3]) })).toThrow(
      /cols\*rows/,
    );
  });

  it('rejects a coverage array whose length disagrees with cols*rows', () => {
    expect(() =>
      dtmProductDigest({ ...baseDtm(), coverage: Uint8Array.from([2, 2, 1]) }),
    ).toThrow(/cols\*rows/);
  });

  it('rejects a non-float z array', () => {
    // A caller passing an integer array would silently lose the vertical
    // precision the digest is meant to prove; refuse it.
    const bad = { ...baseDtm(), z: new Int32Array(4) } as unknown as DtmProductInput;
    expect(() => dtmProductDigest(bad)).toThrow(TypeError);
  });

  it('exposes a stable schema version', () => {
    expect(DTM_PRODUCT_DIGEST_SCHEMA).toBe(1);
  });
});
