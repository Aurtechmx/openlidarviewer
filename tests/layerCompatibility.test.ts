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

  it('two different horizontal CRSs cannot both be in the frame', () => {
    // WHICH of a tied pair becomes the reference is arbitrary — the tie is
    // broken on the key so the answer is stable, not on array order so it is
    // reproducible. What must hold is that they are not both in the project
    // frame, because they are not in the same frame.
    const at = classify([layer(), layer({ id: 'b', epsg: 25829, crsName: 'ETRS89 / UTM zone 29N' })]);
    const states = [at('a'), at('b')];
    expect(states).toContain('incompatible');
    expect(states.filter((s) => s === 'incompatible')).toHaveLength(1);
  });

  it('a MINORITY horizontal CRS is the incompatible one', () => {
    // With a real majority there is no arbitrariness left: two layers agree,
    // the odd one out is the one excluded.
    const at = classify([
      layer({ id: 'a' }), layer({ id: 'b' }),
      layer({ id: 'odd', epsg: 25829, crsName: 'ETRS89 / UTM zone 29N' }),
    ]);
    expect(at('odd')).toBe('incompatible');
    expect(at('a')).not.toBe('incompatible');
    expect(at('b')).not.toBe('incompatible');
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

/**
 * The project's vertical reference cannot depend on load order.
 *
 * The reference datum was taken from the FIRST layer found in the reference
 * horizontal group, so the same three files classified differently depending
 * on which one happened to be listed first — with an undeclared layer leading,
 * every layer fell to horizontal-only; with a declared one leading, two became
 * verified. Nothing about the data changed. Array order is not evidence about
 * datums, and a result that moves when you reorder your inputs is not one you
 * can publish.
 *
 * The rule is unanimity among the group: a project vertical reference exists
 * only when EVERY layer sharing the horizontal frame declares the SAME datum.
 * Anything else is unresolved, and unresolved means horizontal-only for all —
 * the same answer whichever order they arrive in.
 */
describe('vertical reference is order-independent', () => {
  const v = (id: string, verticalDatum: string | null) =>
    layer({ id, verticalDatum });

  const states = (ls: CompatibilityInput[]) => {
    const m = classifyLayerCompatibility(ls);
    return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
  };

  it('gives the same verdict whichever layer is listed first', () => {
    const none = v('none', null);
    const v1 = v('v1', 'EPSG:5703');
    const v2 = v('v2', 'EPSG:5703');
    const a = states([none, v1, v2]);
    const b = states([v1, v2, none]);
    const c = states([v2, none, v1]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('one undeclared layer leaves the whole group unresolved', () => {
    const s = states([v('v1', 'EPSG:5703'), v('v2', 'EPSG:5703'), v('none', null)]);
    expect(s).toEqual({ none: 'horizontal-only', v1: 'horizontal-only', v2: 'horizontal-only' });
  });

  it('unanimous declarations verify the whole group', () => {
    const s = states([v('v1', 'EPSG:5703'), v('v2', 'EPSG:5703')]);
    expect(s).toEqual({ v1: 'verified', v2: 'verified' });
  });

  it('two different declared datums leave everyone horizontal-only', () => {
    const s = states([v('a', 'EPSG:5703'), v('b', 'EPSG:4979')]);
    expect(s).toEqual({ a: 'horizontal-only', b: 'horizontal-only' });
  });
});

/**
 * The same vertical datum has more than one spelling.
 *
 * Vertical references arrive from different resolution paths: a GeoTIFF key
 * yields the catalog NAME ("NAVD88"), a WKT or an unmapped code yields
 * "EPSG:5703". Comparing those as raw strings meant one datum failed to match
 * itself, so two scans genuinely on NAVD88 were demoted to horizontal-only —
 * refusing work that is perfectly valid. Fails safe, but wrongly.
 *
 * Matching is on IDENTITY, not spelling: an EPSG code when one is known,
 * otherwise a normalised name. What must never collapse is a genuine
 * difference — height and depth are opposite axes, not a formatting variant.
 */
describe('vertical reference identity', () => {
  const withVertical = (id: string, verticalDatum: string | null, verticalEpsg?: number) =>
    layer({ id, verticalDatum, verticalEpsg });

  const at = (ls: CompatibilityInput[]) => {
    const m = classifyLayerCompatibility(ls);
    return (id: string) => m.get(id)!;
  };

  it('matches the catalog name against its EPSG code', () => {
    const s = at([withVertical('a', 'NAVD88'), withVertical('b', 'EPSG:5703')]);
    expect(s('a')).toBe('verified');
    expect(s('b')).toBe('verified');
  });

  it('matches a code carried alongside a name', () => {
    const s = at([withVertical('a', 'NAVD88', 5703), withVertical('b', 'EPSG:5703')]);
    expect(s('a')).toBe('verified');
  });

  it('ignores case and surrounding whitespace', () => {
    const s = at([withVertical('a', '  navd88 '), withVertical('b', 'NAVD88')]);
    expect(s('a')).toBe('verified');
  });

  it('keeps HEIGHT and DEPTH apart — they are opposite axes', () => {
    // EPSG:5714 is mean sea level height, 5715 is mean sea level depth. A
    // formatter could make these look alike; they differ by a sign.
    const s = at([withVertical('a', 'MSL height', 5714), withVertical('b', 'MSL depth', 5715)]);
    expect(s('a')).toBe('horizontal-only');
    expect(s('b')).toBe('horizontal-only');
  });

  it('keeps genuinely different datums apart', () => {
    const s = at([withVertical('a', 'NAVD88'), withVertical('b', 'EGM2008 height')]);
    expect(s('a')).toBe('horizontal-only');
  });

  it('an unrecognised name still matches itself', () => {
    const s = at([withVertical('a', 'Site benchmark A'), withVertical('b', 'Site benchmark A')]);
    expect(s('a')).toBe('verified');
  });
});
