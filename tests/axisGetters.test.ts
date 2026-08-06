/**
 * axisGetters — the one place H1/H2/V projection is defined, so the ground
 * filter, DTM rasteriser, DSM builder and hold-out validation cannot drift on
 * which source axis is "up". Both conventions are exercised: 'z'-up (the
 * common case) and 'y'-up (glTF/Three-style sources), because the vertical
 * choice swaps which of y/z is horizontal and which is height.
 */
import { describe, it, expect } from 'vitest';
import { axisGetters } from '../src/terrain/ground/axisGetters';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const P: TerrainPoint = { x: 1, y: 2, z: 3 };

describe('axisGetters', () => {
  it("'z'-up keeps y horizontal and z vertical", () => {
    const g = axisGetters('z');
    expect(g.getH1(P)).toBe(1);
    expect(g.getH2(P)).toBe(2);
    expect(g.getV(P)).toBe(3);
  });

  it("'y'-up swaps: z becomes the second horizontal, y becomes height", () => {
    const g = axisGetters('y');
    expect(g.getH1(P)).toBe(1);
    expect(g.getH2(P)).toBe(3);
    expect(g.getV(P)).toBe(2);
  });

  it('H1 is the x axis under either convention', () => {
    expect(axisGetters('z').getH1(P)).toBe(axisGetters('y').getH1(P));
  });
});
