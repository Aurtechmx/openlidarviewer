import { describe, it, expect } from 'vitest';
import {
  shouldFill,
  type Cardinals,
  type Neighbour,
  type SupportKind,
} from '../src/render/continuity/microGap';

const at = (depth: number, support: SupportKind = 'direct'): Neighbour => ({ depth, support });
const EMPTY: Neighbour = { depth: 0, support: 'none' };
const ring = (o: Partial<Cardinals> = {}): Cardinals => ({
  left: EMPTY,
  right: EMPTY,
  up: EMPTY,
  down: EMPTY,
  ...o,
});

describe('micro-gap fill', () => {
  it('never touches a pixel that already carries a sample', () => {
    const supported = ring({ left: at(10), right: at(10), up: at(10), down: at(10) });
    for (const centre of ['direct', 'accumulated', 'reconstructed'] as SupportKind[]) {
      expect(shouldFill(centre, supported)).toEqual({ fill: false, reason: 'occupied' });
    }
  });

  it('closes a gap bracketed left and right on one surface', () => {
    const d = shouldFill('none', ring({ left: at(10), right: at(10.05) }));
    expect(d.fill).toBe(true);
    if (d.fill) expect(d.support).toBe('reconstructed');
  });

  it('closes a gap bracketed above and below', () => {
    expect(shouldFill('none', ring({ up: at(10), down: at(10.05) })).fill).toBe(true);
  });

  it('closes a gap with three of four cardinals', () => {
    expect(shouldFill('none', ring({ left: at(10), up: at(10), down: at(10.02) })).fill).toBe(true);
  });

  // One neighbour, or two adjacent ones, is a corner or an edge. Nothing spans
  // the pixel, so there is no surface to borrow from.
  it('refuses a single neighbour', () => {
    expect(shouldFill('none', ring({ left: at(10) }))).toEqual({
      fill: false,
      reason: 'unsupported',
    });
  });

  it('refuses two adjacent neighbours', () => {
    expect(shouldFill('none', ring({ left: at(10), up: at(10) }))).toEqual({
      fill: false,
      reason: 'unsupported',
    });
  });

  it('refuses an empty neighbourhood', () => {
    expect(shouldFill('none', ring())).toEqual({ fill: false, reason: 'unsupported' });
  });

  // Neighbours at different depths mean a silhouette, a roof edge or a
  // foreground against a background. Filling would weld two surfaces that are
  // not touching.
  it('refuses a depth discontinuity across the pixel', () => {
    expect(shouldFill('none', ring({ left: at(10), right: at(400) }))).toEqual({
      fill: false,
      reason: 'discontinuity',
    });
  });

  it('checks every pair, not just the opposite one', () => {
    const d = shouldFill('none', ring({ left: at(10), right: at(10.02), up: at(900) }));
    expect(d).toEqual({ fill: false, reason: 'discontinuity' });
  });

  // Without this a fill seeds the next one and reconstruction creeps outward
  // across sparse geometry until a hole in the data has become a surface.
  it('never treats a reconstructed neighbour as evidence', () => {
    const both = ring({ left: at(10, 'reconstructed'), right: at(10, 'reconstructed') });
    expect(shouldFill('none', both)).toEqual({ fill: false, reason: 'unsupported' });
  });

  it('does not let a reconstructed neighbour complete a pair', () => {
    const mixed = ring({ left: at(10, 'direct'), right: at(10, 'reconstructed') });
    expect(shouldFill('none', mixed)).toEqual({ fill: false, reason: 'unsupported' });
  });

  it('accepts accumulated support, which traces back to samples', () => {
    const acc = ring({ left: at(10, 'accumulated'), right: at(10, 'accumulated') });
    expect(shouldFill('none', acc).fill).toBe(true);
  });

  it('ignores a neighbour whose depth is degenerate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shouldFill('none', ring({ left: at(bad), right: at(10) }))).toEqual({
        fill: false,
        reason: 'unsupported',
      });
    }
  });

  // The neighbours already agree within tolerance, so this barely moves the
  // value; taking the nearest keeps the filled pixel from sitting behind the
  // surface it belongs to and being overwritten by it.
  it('fills at the nearest supporting depth', () => {
    const d = shouldFill('none', ring({ left: at(10.1), right: at(10), up: at(10.05) }));
    expect(d.fill).toBe(true);
    if (d.fill) expect(d.depth).toBe(10);
  });
});
