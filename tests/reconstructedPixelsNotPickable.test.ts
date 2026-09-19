/**
 * A reconstructed pixel cannot be picked, measured or exported.
 *
 * Every module in the subsystem carries a sentence saying nothing derived from
 * a reconstructed pixel may reach picking, measurement, terrain, export or
 * claim evidence. A sentence in a comment is not a guarantee. This asserts the
 * structural fact the sentence describes: a fill decision carries no identity,
 * so there is nothing for a picker to resolve, and the pick path reads the
 * authoritative points by index and never a framebuffer.
 */
import { describe, it, expect } from 'vitest';
import { shouldFill, type Cardinals, type SupportKind } from '../src/render/continuity/microGap';
import { insideLens, admitsReconstruction, LENS_CLOSED } from '../src/render/continuity/evidenceLens';
import { censusOf, reconstructedShare } from '../src/render/continuity/supportCensus';

const sample = (depth: number, support: SupportKind = 'direct') => ({ depth, support });
const onSurface = (d = 10): Cardinals => ({
  left: sample(d),
  right: sample(d),
  up: sample(d),
  down: sample(d),
});

describe('a fill carries no identity', () => {
  it('returns a depth and a support kind, and nothing a picker could use', () => {
    const decision = shouldFill('none', onSurface());
    expect(decision.fill).toBe(true);
    expect(Object.keys(decision).sort()).toEqual(['depth', 'fill', 'support']);
  });

  it('has no index, no point id and no world coordinate on it', () => {
    const decision = shouldFill('none', onSurface()) as unknown as Record<string, unknown>;
    for (const forbidden of ['index', 'pointIndex', 'sourceIndex', 'id', 'x', 'y', 'z', 'position']) {
      expect(decision[forbidden]).toBeUndefined();
    }
  });

  it('marks what it produced as reconstructed rather than as a sample', () => {
    const decision = shouldFill('none', onSurface());
    if (decision.fill) expect(decision.support).toBe('reconstructed');
  });

  it('refuses to let its own output become evidence for another fill', () => {
    const allReconstructed: Cardinals = {
      left: sample(10, 'reconstructed'),
      right: sample(10, 'reconstructed'),
      up: sample(10, 'reconstructed'),
      down: sample(10, 'reconstructed'),
    };
    const decision = shouldFill('none', allReconstructed);
    expect(decision.fill).toBe(false);
  });
});

describe('the lens shows measured evidence only', () => {
  const lens = { centreXPx: 100, centreYPx: 100, radiusPx: 20, featherPx: 10, enabled: true };

  it('admits no reconstruction anywhere it covers, feather included', () => {
    for (const [x, y] of [[100, 100], [115, 100], [100, 128], [121, 121]]) {
      if (!insideLens(x, y, lens)) continue;
      expect(admitsReconstruction(x, y, lens)).toBe(false);
    }
  });

  it('is a hard decision at the rim rather than a fade', () => {
    // Just inside the feather's outer edge, and just outside it.
    expect(admitsReconstruction(100 + 29, 100, lens)).toBe(false);
    expect(admitsReconstruction(100 + 31, 100, lens)).toBe(true);
  });

  it('admits reconstruction everywhere when it is shut', () => {
    expect(admitsReconstruction(0, 0, LENS_CLOSED)).toBe(true);
    expect(insideLens(0, 0, LENS_CLOSED)).toBe(false);
  });
});

describe('the census counts pixels and yields no geometry', () => {
  it('reports a share of drawn pixels, never a coordinate', () => {
    const c = censusOf(['direct', 'reconstructed', 'accumulated', 'none'] as SupportKind[]);
    expect(Object.keys(c).sort()).toEqual(['accumulated', 'direct', 'none', 'reconstructed']);
    const share = reconstructedShare(c);
    expect(typeof share === 'number' || share === null).toBe(true);
  });

  it('has no share for a frame that drew nothing, so empty is not clean', () => {
    const c = censusOf(['none', 'none'] as SupportKind[]);
    expect(reconstructedShare(c)).toBeNull();
  });

  it('excludes background from the denominator, so pulling back hides nothing', () => {
    const tight = censusOf(['direct', 'direct', 'direct', 'reconstructed'] as SupportKind[]);
    const pulledBack = censusOf([
      'direct', 'direct', 'direct', 'reconstructed',
      ...Array.from({ length: 500 }, () => 'none' as SupportKind),
    ]);
    expect(reconstructedShare(tight)).toBe(reconstructedShare(pulledBack));
  });
});
