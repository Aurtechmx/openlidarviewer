/**
 * profileSectionSnapshot.test.ts
 *
 * A section over a streaming source is a snapshot, and these hold the three
 * things that makes true: the read order does not depend on the network, the
 * completeness claim is refused when it cannot be supported, and a slow
 * extraction cannot overwrite a newer one.
 */
import { describe, it, expect } from 'vitest';
import {
  orderResidentNodes,
  streamingIsComplete,
  resolveSectionScope,
  describeSectionScope,
  SectionGeneration,
  type ResidentNodeRef,
} from '../src/render/measure/profileSectionSnapshot';

const node = (key: string, pointCount = 1): ResidentNodeRef => ({ key, pointCount });
const keys = (ns: readonly ResidentNodeRef[]): string[] => ns.map((n) => n.key);

/** Deterministic shuffle, so a failure reproduces. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('resident nodes read in a fixed order', () => {
  const set = [
    node('0-0-0-0'),
    node('1-0-0-0'),
    node('1-1-0-0'),
    node('2-3-1-0'),
    node('2-3-0-1'),
    node('10-0-0-0'),
    node('9-511-511-511'),
    node('2-0-0-0'),
  ];

  it('sorts by depth then x then y then z', () => {
    expect(keys(orderResidentNodes(set))).toEqual([
      '0-0-0-0',
      '1-0-0-0',
      '1-1-0-0',
      '2-0-0-0',
      '2-3-0-1',
      '2-3-1-0',
      '9-511-511-511',
      '10-0-0-0',
    ]);
  });

  it('puts depth 10 after depth 9, which a string compare would not', () => {
    const ordered = keys(orderResidentNodes([node('10-0-0-0'), node('9-0-0-0')]));
    expect(ordered).toEqual(['9-0-0-0', '10-0-0-0']);
    // The failure this guards against.
    expect(['10-0-0-0', '9-0-0-0'].slice().sort()).toEqual(['10-0-0-0', '9-0-0-0']);
  });

  it('gives the same order whatever order the nodes arrived in', () => {
    const want = keys(orderResidentNodes(set));
    for (let seed = 1; seed <= 40; seed++) {
      expect(keys(orderResidentNodes(shuffle(set, seed)))).toEqual(want);
    }
  });

  it('orders an unparseable key after every parseable one, still fixed', () => {
    const mixed = [node('zeta'), node('2-0-0-0'), node('alpha'), node('0-0-0-0')];
    const want = keys(orderResidentNodes(mixed));
    expect(want).toEqual(['0-0-0-0', '2-0-0-0', 'alpha', 'zeta']);
    for (let seed = 1; seed <= 20; seed++) {
      expect(keys(orderResidentNodes(shuffle(mixed, seed)))).toEqual(want);
    }
  });

  it('does not modify the caller array', () => {
    const input = [node('2-0-0-0'), node('1-0-0-0')];
    const before = keys(input);
    orderResidentNodes(input);
    expect(keys(input)).toEqual(before);
  });

  it('handles an empty set', () => {
    expect(orderResidentNodes([])).toEqual([]);
  });
});

describe('completeness is refused when it cannot be supported', () => {
  it('is unknown when the node count is unknown', () => {
    expect(streamingIsComplete({ knownNodeCount: null, residentNodeCount: 40 })).toBeNull();
  });

  it('is false when nodes are known to be missing', () => {
    expect(streamingIsComplete({ knownNodeCount: 100, residentNodeCount: 99 })).toBe(false);
  });

  it('is true only when every known node is resident', () => {
    expect(streamingIsComplete({ knownNodeCount: 100, residentNodeCount: 100 })).toBe(true);
    expect(streamingIsComplete({ knownNodeCount: 0, residentNodeCount: 0 })).toBe(true);
  });

  it('is unknown for a nonsensical count rather than defaulting either way', () => {
    for (const c of [
      { knownNodeCount: Number.NaN, residentNodeCount: 1 },
      { knownNodeCount: -1, residentNodeCount: 1 },
      { knownNodeCount: 10, residentNodeCount: Number.NaN },
      { knownNodeCount: 10, residentNodeCount: -3 },
    ]) {
      expect(streamingIsComplete(c)).toBeNull();
    }
  });
});

describe('scope names where the returns came from', () => {
  it('reports each combination', () => {
    expect(resolveSectionScope({ staticSourceCount: 2, streamingSourceCount: 0 })).toBe(
      'full-static-source',
    );
    expect(resolveSectionScope({ staticSourceCount: 1, streamingSourceCount: 1 })).toBe(
      'mixed-full-and-resident',
    );
    expect(resolveSectionScope({ staticSourceCount: 0, streamingSourceCount: 1 })).toBe(
      'resident-snapshot',
    );
    expect(resolveSectionScope({ staticSourceCount: 0, streamingSourceCount: 0 })).toBe('empty');
  });

  it('still says snapshot when a streaming source is fully resident', () => {
    const scope = resolveSectionScope({ staticSourceCount: 0, streamingSourceCount: 1 });
    expect(scope).toBe('resident-snapshot');
    expect(describeSectionScope(scope, true)).toMatch(/Resident snapshot/);
  });

  it('says coverage is unknown rather than implying an answer', () => {
    expect(describeSectionScope('resident-snapshot', null)).toBe(
      'Resident snapshot, coverage unknown',
    );
    expect(describeSectionScope('resident-snapshot', false)).toMatch(/incomplete/);
  });

  it('never calls a streaming scope full', () => {
    for (const complete of [true, false, null]) {
      for (const scope of ['resident-snapshot', 'mixed-full-and-resident'] as const) {
        expect(describeSectionScope(scope, complete)).not.toBe('Full static source');
      }
    }
  });
});

describe('a stale extraction cannot replace a newer one', () => {
  it('accepts only the newest token', () => {
    const gen = new SectionGeneration();
    const first = gen.next();
    expect(gen.accepts(first)).toBe(true);
    const second = gen.next();
    expect(gen.accepts(first)).toBe(false);
    expect(gen.accepts(second)).toBe(true);
  });

  it('refuses everything once abandoned, including the newest', () => {
    const gen = new SectionGeneration();
    const token = gen.next();
    gen.abandon();
    expect(gen.abandoned).toBe(true);
    expect(gen.accepts(token)).toBe(false);
    expect(gen.accepts(gen.current)).toBe(false);
  });

  it('refuses a token from before the first request', () => {
    const gen = new SectionGeneration();
    expect(gen.accepts(0)).toBe(false);
    gen.next();
    expect(gen.accepts(0)).toBe(false);
  });

  it('stays abandoned even after a later request', () => {
    // A closed measurement has no later state in which an extraction already
    // in flight becomes wanted again.
    const gen = new SectionGeneration();
    gen.next();
    gen.abandon();
    const later = gen.next();
    expect(gen.accepts(later)).toBe(false);
  });

  it('refuses a token that was never issued', () => {
    const gen = new SectionGeneration();
    gen.next();
    for (const t of [0, -1, 2, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gen.accepts(t)).toBe(false);
    }
    expect(gen.accepts(1)).toBe(true);
  });
});
