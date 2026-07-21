/**
 * Layer spatial compatibility — what a layer has PROVEN about its frame.
 *
 * The frame previously treated "no definite mismatch" as compatible, so a
 * cloud with no declared CRS at all (PLY, OBJ, GLB, XYZ, PCD, unresolved E57)
 * was mounted into a shared frame and merged into terrain, profile, volume and
 * lasso estimators alongside a georeferenced scan. Having an origin is not
 * evidence of sharing a coordinate system. Absence of proof is not proof.
 *
 * Four explicit states, because two of them behave differently in Z:
 * a pair that shares a horizontal CRS but cannot agree on a vertical datum is
 * genuinely alignable in X/Y and genuinely NOT alignable in height.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLayerCompatibility,
  participatesInSharedAnalysis,
  alignsVertically,
  type CompatibilityInput,
} from '../src/model/layerCompatibility';

const layer = (over: Partial<CompatibilityInput> = {}): CompatibilityInput => ({
  id: 'a', epsg: 32629, crsName: 'WGS 84 / UTM zone 29N', verticalDatum: 'EPSG:5703', ...over,
});

const classify = (ls: CompatibilityInput[]) => {
  const m = classifyLayerCompatibility(ls);
  return (id: string) => m.get(id)!;
};

describe('classifyLayerCompatibility', () => {
  it('a lone layer is verified — it IS the frame', () => {
    // The single-scan path must be untouched: there is nothing to reconcile
    // against, so nothing is unproven.
    expect(classify([layer()])('a')).toBe('verified');
  });

  it('a lone layer with no CRS at all is still verified', () => {
    expect(classify([layer({ epsg: undefined, crsName: undefined, verticalDatum: null })])('a')).toBe('verified');
  });

  it('two layers agreeing horizontally AND vertically are verified', () => {
    const at = classify([layer(), layer({ id: 'b' })]);
    expect(at('a')).toBe('verified');
    expect(at('b')).toBe('verified');
  });

  it('an undeclared CRS beside a georeferenced scan is UNKNOWN, not compatible', () => {
    // The reported defect: this layer used to mount and join the estimators.
    const at = classify([layer(), layer({ id: 'b', epsg: undefined, crsName: undefined, verticalDatum: null })]);
    expect(at('b')).toBe('unknown');
  });

  it('a different horizontal CRS is incompatible', () => {
    const at = classify([layer(), layer({ id: 'b', epsg: 25829, crsName: 'ETRS89 / UTM zone 29N' })]);
    expect(at('b')).toBe('incompatible');
  });

  it('same horizontal, DIFFERENT vertical datum is horizontal-only', () => {
    const at = classify([layer(), layer({ id: 'b', verticalDatum: 'EPSG:5773' })]);
    expect(at('b')).toBe('horizontal-only');
  });

  it('same horizontal, UNDECLARED vertical is horizontal-only, not verified', () => {
    // Undeclared height is not agreed height. Orthometric vs ellipsoidal
    // differs by tens of metres, and metres vs feet by a factor of three.
    const at = classify([layer(), layer({ id: 'b', verticalDatum: null })]);
    expect(at('b')).toBe('horizontal-only');
  });

  it('demotes the WHOLE set when the reference itself lacks a vertical datum', () => {
    const at = classify([layer({ verticalDatum: null }), layer({ id: 'b' })]);
    expect(at('a')).toBe('horizontal-only');
    expect(at('b')).toBe('horizontal-only');
  });
});

describe('what each state is allowed to do', () => {
  it('only a verified layer joins a combined estimator', () => {
    expect(participatesInSharedAnalysis('verified')).toBe(true);
    expect(participatesInSharedAnalysis('horizontal-only')).toBe(false);
    expect(participatesInSharedAnalysis('unknown')).toBe(false);
    expect(participatesInSharedAnalysis('incompatible')).toBe(false);
  });

  it('only a verified layer may be aligned in Z', () => {
    // Rebasing Z on a horizontal-only pair asserts a shared vertical datum
    // that was never established — the numbers would look fine and be wrong.
    expect(alignsVertically('verified')).toBe(true);
    expect(alignsVertically('horizontal-only')).toBe(false);
    expect(alignsVertically('unknown')).toBe(false);
    expect(alignsVertically('incompatible')).toBe(false);
  });
});
