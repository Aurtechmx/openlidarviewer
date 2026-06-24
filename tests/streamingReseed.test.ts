/**
 * streamingReseed.test.ts — pins the race-correct colour-range seeding decision.
 *
 * Under concurrent COPC decode the first node to *arrive* may be a deep node
 * covering a sliver of the cloud; seeding the elevation/intensity ramp off it
 * tints the whole stream wrong. shouldReseedColorRange only (re)seeds from a
 * non-empty node strictly shallower than the last seed, converging to the
 * depth-0 root that spans the full extent.
 */

import { describe, it, expect } from 'vitest';
import { shouldReseedColorRange } from '../src/render/streaming/StreamingRenderer';

describe('shouldReseedColorRange', () => {
  it('seeds on the first non-empty node (depth < Infinity)', () => {
    expect(shouldReseedColorRange(Number.POSITIVE_INFINITY, 3, 100)).toBe(true);
  });

  it('reseeds when a shallower (closer-to-root) node arrives later', () => {
    expect(shouldReseedColorRange(3, 1, 100)).toBe(true); // a deep node seeded first
    expect(shouldReseedColorRange(1, 0, 100)).toBe(true); // then the root lands
  });

  it('does NOT reseed from an equal or deeper node', () => {
    expect(shouldReseedColorRange(1, 1, 100)).toBe(false);
    expect(shouldReseedColorRange(1, 4, 100)).toBe(false);
  });

  it('never seeds from an empty node', () => {
    expect(shouldReseedColorRange(Number.POSITIVE_INFINITY, 0, 0)).toBe(false);
  });

  it('once the root (depth 0) has seeded, nothing can reseed', () => {
    expect(shouldReseedColorRange(0, 0, 100)).toBe(false);
    expect(shouldReseedColorRange(0, 1, 100)).toBe(false);
  });
});
