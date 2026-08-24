import { describe, it, expect } from 'vitest';
import {
  assertCoordinate,
  childCoordinates,
  parentCoordinate,
  tileIdFor,
  mortonIndex,
  tileIndexWithinSubtree,
  isAvailable,
  subdivideBoundingVolume,
  geometricErrorForLevel,
  MAX_LEVEL,
  type SubdivisionScheme,
  type TileCoordinate,
} from '../src/io/tiles3d/implicitCoordinates';
import type { BoundingVolume } from '../src/io/tiles3d/tileset';

/**
 * Every expected number below is hand-computed from the stated rule, not read
 * back from the implementation.
 *
 * Bit order under test: Morton interleaves LSB-first with x in the lowest bit of
 * each group, then y, then (OCTREE) z. So QUADTREE (x=1,y=0) is 1, (x=0,y=1) is
 * 2, and OCTREE (z=1) alone is 4.
 */

const TOL = 1e-12;

/** Axis-aligned interval form of a box volume, for coverage checks. */
function boxExtent(volume: BoundingVolume): { min: number[]; max: number[] } {
  const b = volume.box as readonly number[];
  const centre = [b[0] as number, b[1] as number, b[2] as number];
  // Only axis-aligned boxes are used in these tests, so each half-axis
  // contributes to exactly one component.
  const half = [
    Math.abs(b[3] as number) + Math.abs(b[6] as number) + Math.abs(b[9] as number),
    Math.abs(b[4] as number) + Math.abs(b[7] as number) + Math.abs(b[10] as number),
    Math.abs(b[5] as number) + Math.abs(b[8] as number) + Math.abs(b[11] as number),
  ];
  return {
    min: centre.map((c, i) => c - (half[i] as number)),
    max: centre.map((c, i) => c + (half[i] as number)),
  };
}

function regionExtent(volume: BoundingVolume): { min: number[]; max: number[] } {
  const r = volume.region as readonly number[];
  return {
    min: [r[0] as number, r[1] as number, r[4] as number],
    max: [r[2] as number, r[3] as number, r[5] as number],
  };
}

function volumeSize(e: { min: number[]; max: number[] }): number {
  return [0, 1, 2].reduce((acc, i) => acc * ((e.max[i] as number) - (e.min[i] as number)), 1);
}

function overlaps(a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }): boolean {
  return [0, 1, 2].every(
    (i) =>
      Math.min(a.max[i] as number, b.max[i] as number) - Math.max(a.min[i] as number, b.min[i] as number) >
      TOL,
  );
}

describe('3D Tiles implicit tiling: coordinates', () => {
  it('QUADTREE has four children at level+1 with doubled x and y', () => {
    const kids = childCoordinates('QUADTREE', { level: 2, x: 1, y: 3 });
    expect(kids).toHaveLength(4);
    // x doubles to 2, y doubles to 6, level rises to 3.
    expect(kids).toEqual([
      { level: 3, x: 2, y: 6 },
      { level: 3, x: 3, y: 6 },
      { level: 3, x: 2, y: 7 },
      { level: 3, x: 3, y: 7 },
    ]);
  });

  it('OCTREE has eight children with doubled x, y and z', () => {
    const kids = childCoordinates('OCTREE', { level: 1, x: 1, y: 0, z: 1 });
    expect(kids).toHaveLength(8);
    expect(kids).toEqual([
      { level: 2, x: 2, y: 0, z: 2 },
      { level: 2, x: 3, y: 0, z: 2 },
      { level: 2, x: 2, y: 1, z: 2 },
      { level: 2, x: 3, y: 1, z: 2 },
      { level: 2, x: 2, y: 0, z: 3 },
      { level: 2, x: 3, y: 0, z: 3 },
      { level: 2, x: 2, y: 1, z: 3 },
      { level: 2, x: 3, y: 1, z: 3 },
    ]);
  });

  it('parent halves the ordinates and is null at level 0', () => {
    expect(parentCoordinate('QUADTREE', { level: 3, x: 5, y: 2 })).toEqual({ level: 2, x: 2, y: 1 });
    expect(parentCoordinate('OCTREE', { level: 2, x: 3, y: 0, z: 1 })).toEqual({
      level: 1,
      x: 1,
      y: 0,
      z: 0,
    });
    expect(parentCoordinate('QUADTREE', { level: 0, x: 0, y: 0 })).toBeNull();
    expect(parentCoordinate('OCTREE', { level: 0, x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('parent of every child is the original coordinate, in both schemes', () => {
    const seeds: { scheme: SubdivisionScheme; coord: TileCoordinate }[] = [];
    for (let level = 0; level <= 4; level += 1) {
      const size = 2 ** level;
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          seeds.push({ scheme: 'QUADTREE', coord: { level, x, y } });
          for (let z = 0; z < size; z += 1) {
            seeds.push({ scheme: 'OCTREE', coord: { level, x, y, z } });
          }
        }
      }
    }
    expect(seeds.length).toBeGreaterThan(400);
    for (const { scheme, coord } of seeds) {
      for (const child of childCoordinates(scheme, coord)) {
        expect(parentCoordinate(scheme, child)).toEqual(coord);
      }
    }
  });

  it('rejects malformed coordinates rather than addressing another tile', () => {
    expect(() => assertCoordinate('QUADTREE', { level: 1, x: 2, y: 0 })).toThrow(/outside/);
    expect(() => assertCoordinate('QUADTREE', { level: 1, x: 0, y: 0, z: 0 })).toThrow(/must not carry a z/);
    expect(() => assertCoordinate('OCTREE', { level: 1, x: 0, y: 0 })).toThrow(/needs a non-negative integer z/);
    expect(() => assertCoordinate('QUADTREE', { level: 1, x: -1, y: 0 })).toThrow();
    expect(() => assertCoordinate('QUADTREE', { level: 1, x: 0.5, y: 0 })).toThrow();
    expect(() => assertCoordinate('QUADTREE', { level: MAX_LEVEL.QUADTREE + 1, x: 0, y: 0 })).toThrow(
      /exact-integer limit/,
    );
    expect(() => assertCoordinate('OCTREE', { level: MAX_LEVEL.OCTREE + 1, x: 0, y: 0, z: 0 })).toThrow(
      /exact-integer limit/,
    );
  });
});

describe('3D Tiles implicit tiling: tile ids', () => {
  it('is stable across repeated calls', () => {
    const coord = { level: 5, x: 17, y: 3 };
    expect(tileIdFor('QUADTREE', coord)).toBe(tileIdFor('QUADTREE', { ...coord }));
    const oct = { level: 4, x: 9, y: 2, z: 15 };
    expect(tileIdFor('OCTREE', oct)).toBe(tileIdFor('OCTREE', { ...oct }));
  });

  it('never collides across several hundred coordinates in both schemes', () => {
    const ids = new Set<string>();
    let count = 0;
    for (let level = 0; level <= 3; level += 1) {
      const size = 2 ** level;
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          ids.add(tileIdFor('QUADTREE', { level, x, y }));
          count += 1;
          for (let z = 0; z < size; z += 1) {
            ids.add(tileIdFor('OCTREE', { level, x, y, z }));
            count += 1;
          }
        }
      }
    }
    expect(count).toBeGreaterThan(400);
    expect(ids.size).toBe(count);
  });

  it('distinguishes the two schemes at the same level, x and y', () => {
    expect(tileIdFor('QUADTREE', { level: 1, x: 1, y: 0 })).not.toBe(
      tileIdFor('OCTREE', { level: 1, x: 1, y: 0, z: 0 }),
    );
  });
});

describe('3D Tiles implicit tiling: Morton index', () => {
  it('QUADTREE interleaves x into the low bit of each pair', () => {
    // x contributes bits 0, 2, 4...; y contributes bits 1, 3, 5...
    expect(mortonIndex('QUADTREE', { level: 1, x: 0, y: 0 })).toBe(0);
    expect(mortonIndex('QUADTREE', { level: 1, x: 1, y: 0 })).toBe(1);
    expect(mortonIndex('QUADTREE', { level: 1, x: 0, y: 1 })).toBe(2);
    expect(mortonIndex('QUADTREE', { level: 1, x: 1, y: 1 })).toBe(3);
    // x=2 is binary 10: its bit 1 lands at position 2, so the index is 4.
    expect(mortonIndex('QUADTREE', { level: 2, x: 2, y: 0 })).toBe(4);
    expect(mortonIndex('QUADTREE', { level: 2, x: 0, y: 2 })).toBe(8);
    // x=3 -> bits 0 and 2 (1+4=5); y=1 -> bit 1 (2). Total 7.
    expect(mortonIndex('QUADTREE', { level: 2, x: 3, y: 1 })).toBe(7);
    // x=2 -> 4; y=3 -> bits 1 and 3 (2+8=10). Total 14.
    expect(mortonIndex('QUADTREE', { level: 2, x: 2, y: 3 })).toBe(14);
  });

  it('OCTREE interleaves x, y and z into the low, middle and high bit of each triple', () => {
    expect(mortonIndex('OCTREE', { level: 1, x: 1, y: 0, z: 0 })).toBe(1);
    expect(mortonIndex('OCTREE', { level: 1, x: 0, y: 1, z: 0 })).toBe(2);
    expect(mortonIndex('OCTREE', { level: 1, x: 0, y: 0, z: 1 })).toBe(4);
    expect(mortonIndex('OCTREE', { level: 1, x: 1, y: 1, z: 1 })).toBe(7);
    // x=2 is binary 10: its bit 1 lands at position 1*3+0 = 3, so 8.
    expect(mortonIndex('OCTREE', { level: 2, x: 2, y: 0, z: 0 })).toBe(8);
    // z=2: bit 1 lands at position 1*3+2 = 5, so 32.
    expect(mortonIndex('OCTREE', { level: 2, x: 0, y: 0, z: 2 })).toBe(32);
    // x=3 -> positions 0 and 3 (1+8=9); y=2 -> position 4 (16); z=1 -> position 2 (4). Total 29.
    expect(mortonIndex('OCTREE', { level: 2, x: 3, y: 2, z: 1 })).toBe(29);
  });

  it('covers each level exactly once with no gaps', () => {
    const quad = new Set<number>();
    for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) quad.add(mortonIndex('QUADTREE', { level: 3, x, y }));
    expect(quad.size).toBe(64);
    expect(Math.max(...quad)).toBe(63);
    const oct = new Set<number>();
    for (let x = 0; x < 4; x += 1)
      for (let y = 0; y < 4; y += 1)
        for (let z = 0; z < 4; z += 1) oct.add(mortonIndex('OCTREE', { level: 2, x, y, z }));
    expect(oct.size).toBe(64);
    expect(Math.max(...oct)).toBe(63);
  });

  it('stays exact at the documented level limit', () => {
    // QUADTREE level 26: all ordinates 2^26-1 fills 52 bits, which is 2^52-1.
    const q = mortonIndex('QUADTREE', { level: 26, x: 2 ** 26 - 1, y: 2 ** 26 - 1 });
    expect(q).toBe(2 ** 52 - 1);
    expect(Number.isSafeInteger(q)).toBe(true);
    // OCTREE level 17: 51 bits, which is 2^51-1.
    const o = mortonIndex('OCTREE', { level: 17, x: 2 ** 17 - 1, y: 2 ** 17 - 1, z: 2 ** 17 - 1 });
    expect(o).toBe(2 ** 51 - 1);
    expect(Number.isSafeInteger(o)).toBe(true);
  });
});

describe('3D Tiles implicit tiling: subtree index', () => {
  it('adds the tiles of the levels above to the Morton index', () => {
    // QUADTREE, subtree root at level 0. Levels 0 and 1 hold 1+4 = 5 tiles.
    // Morton of (x=3,y=1) at level 2 is 7, so the index is 12.
    expect(tileIndexWithinSubtree('QUADTREE', { level: 2, x: 3, y: 1 }, 0)).toBe(12);
    // The subtree root itself is index 0 in both schemes.
    expect(tileIndexWithinSubtree('QUADTREE', { level: 4, x: 5, y: 5 }, 4)).toBe(0);
    expect(tileIndexWithinSubtree('OCTREE', { level: 3, x: 1, y: 2, z: 3 }, 3)).toBe(0);
    // OCTREE, subtree root at level 0: level 0 holds 1 tile; (1,1,1) is Morton 7.
    expect(tileIndexWithinSubtree('OCTREE', { level: 1, x: 1, y: 1, z: 1 }, 0)).toBe(8);
  });

  it('uses the position within the subtree, not the global grid', () => {
    // Depth 2 under a level-1 root: 1+4 = 5 tiles above.
    // Global (x=5,y=2) is local (1,2): Morton 1 + 8 = 9, so the index is 14.
    expect(tileIndexWithinSubtree('QUADTREE', { level: 3, x: 5, y: 2 }, 1)).toBe(14);
    // The same local position under a different subtree gets the same index.
    expect(tileIndexWithinSubtree('QUADTREE', { level: 3, x: 1, y: 2 }, 1)).toBe(14);
  });

  it('refuses a level above the subtree root', () => {
    expect(() => tileIndexWithinSubtree('QUADTREE', { level: 1, x: 0, y: 0 }, 2)).toThrow(/above the subtree root/);
  });
});

describe('3D Tiles implicit tiling: availability', () => {
  it('reads a constant 0 as all-unavailable and a constant 1 as all-available', () => {
    expect(isAvailable({ constant: 0 }, 0)).toBe(false);
    expect(isAvailable({ constant: 0 }, 12345)).toBe(false);
    expect(isAvailable({ constant: 1 }, 0)).toBe(true);
    expect(isAvailable({ constant: 1 }, 12345)).toBe(true);
  });

  it('reads a bitstream LSB-first within each byte', () => {
    // Byte 0 = 0b0000_0101 -> bits 0 and 2 set (tiles 0 and 2).
    // Byte 1 = 0b1000_0000 -> bit 7 set (tile 15).
    const bits = new Uint8Array([0b0000_0101, 0b1000_0000]);
    const av = { bitstream: bits };
    expect(isAvailable(av, 0)).toBe(true); // first bit of the first byte
    expect(isAvailable(av, 1)).toBe(false);
    expect(isAvailable(av, 2)).toBe(true);
    for (const i of [3, 4, 5, 6]) expect(isAvailable(av, i)).toBe(false);
    expect(isAvailable(av, 7)).toBe(false); // last bit of the first byte
    expect(isAvailable(av, 8)).toBe(false);
    expect(isAvailable(av, 15)).toBe(true); // last bit of the last byte
  });

  it('sets the last bit of a byte when that bit alone is set', () => {
    expect(isAvailable({ bitstream: new Uint8Array([0b1000_0000]) }, 7)).toBe(true);
    expect(isAvailable({ bitstream: new Uint8Array([0b0000_0001]) }, 0)).toBe(true);
    expect(isAvailable({ bitstream: new Uint8Array([0b0000_0001]) }, 7)).toBe(false);
  });

  it('refuses an out-of-range index instead of reporting a real tile as missing', () => {
    const av = { bitstream: new Uint8Array([0xff, 0xff]) };
    expect(() => isAvailable(av, 16)).toThrow(/outside/);
    expect(() => isAvailable(av, 999)).toThrow(/outside/);
    expect(() => isAvailable(av, -1)).toThrow(/non-negative integer/);
    expect(() => isAvailable({ constant: 1, length: 5 }, 5)).toThrow(/outside/);
    expect(isAvailable({ constant: 1, length: 5 }, 4)).toBe(true);
    // A declared length longer than the buffer is a malformed subtree.
    expect(() => isAvailable({ bitstream: new Uint8Array([0xff]), length: 9 }, 0)).toThrow(/exceeds the bitstream/);
  });
});

describe('3D Tiles implicit tiling: bounding volume subdivision', () => {
  // Parent box: centre at the origin, half-extents 4 in x, 2 in y, 1 in z.
  const parentBox: BoundingVolume = { box: [0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0, 1] };
  // Parent region: 0.4 rad of longitude, 0.2 rad of latitude, 10..30 m height.
  const parentRegion: BoundingVolume = { region: [0, 0, 0.4, 0.2, 10, 30] };

  it('halves x and y of a box and leaves z whole for QUADTREE', () => {
    const child0 = subdivideBoundingVolume('QUADTREE', parentBox, 0) as BoundingVolume;
    // Half-axes halve to 2 and 1; the centre moves to (-2, -1, 0).
    expect(child0.box?.slice(0, 3)).toEqual([-2, -1, 0]);
    expect(child0.box?.slice(3, 6)).toEqual([2, 0, 0]);
    expect(child0.box?.slice(6, 9)).toEqual([0, 1, 0]);
    // z half-axis unchanged.
    expect(child0.box?.slice(9, 12)).toEqual([0, 0, 1]);

    const child3 = subdivideBoundingVolume('QUADTREE', parentBox, 3) as BoundingVolume;
    expect(child3.box?.slice(0, 3)).toEqual([2, 1, 0]);
    expect(child3.box?.slice(9, 12)).toEqual([0, 0, 1]);
  });

  it('keeps the z extent of every QUADTREE child identical to the parent', () => {
    const parent = boxExtent(parentBox);
    for (let i = 0; i < 4; i += 1) {
      const e = boxExtent(subdivideBoundingVolume('QUADTREE', parentBox, i) as BoundingVolume);
      expect(e.min[2] as number).toBeCloseTo(parent.min[2] as number, 12);
      expect(e.max[2] as number).toBeCloseTo(parent.max[2] as number, 12);
    }
    for (let i = 0; i < 4; i += 1) {
      const r = regionExtent(subdivideBoundingVolume('QUADTREE', parentRegion, i) as BoundingVolume);
      expect(r.min[2] as number).toBeCloseTo(10, 12);
      expect(r.max[2] as number).toBeCloseTo(30, 12);
    }
  });

  it('halves all three axes of a box for OCTREE', () => {
    // childIndex 5 is dx=1, dy=0, dz=1: centre (2, -1, 0.5).
    const child5 = subdivideBoundingVolume('OCTREE', parentBox, 5) as BoundingVolume;
    expect(child5.box?.slice(0, 3)).toEqual([2, -1, 0.5]);
    expect(child5.box?.slice(9, 12)).toEqual([0, 0, 0.5]);
    const child0 = subdivideBoundingVolume('OCTREE', parentBox, 0) as BoundingVolume;
    expect(child0.box?.slice(0, 3)).toEqual([-2, -1, -0.5]);
  });

  it('splits a region by longitude, latitude and (OCTREE only) height', () => {
    const q0 = subdivideBoundingVolume('QUADTREE', parentRegion, 0) as BoundingVolume;
    expect(q0.region).toEqual([0, 0, 0.2, 0.1, 10, 30]);
    const q3 = subdivideBoundingVolume('QUADTREE', parentRegion, 3) as BoundingVolume;
    expect(q3.region).toEqual([0.2, 0.1, 0.4, 0.2, 10, 30]);
    const o0 = subdivideBoundingVolume('OCTREE', parentRegion, 0) as BoundingVolume;
    expect(o0.region).toEqual([0, 0, 0.2, 0.1, 10, 20]);
    const o4 = subdivideBoundingVolume('OCTREE', parentRegion, 4) as BoundingVolume;
    expect(o4.region).toEqual([0, 0, 0.2, 0.1, 20, 30]);
  });

  const cases: { scheme: SubdivisionScheme; label: string; parent: BoundingVolume; extent: (v: BoundingVolume) => { min: number[]; max: number[] } }[] = [
    { scheme: 'QUADTREE', label: 'box', parent: parentBox, extent: boxExtent },
    { scheme: 'OCTREE', label: 'box', parent: parentBox, extent: boxExtent },
    { scheme: 'QUADTREE', label: 'region', parent: parentRegion, extent: regionExtent },
    { scheme: 'OCTREE', label: 'region', parent: parentRegion, extent: regionExtent },
  ];

  for (const { scheme, label, parent, extent } of cases) {
    it(`${scheme} children of a ${label} cover the parent exactly and do not overlap`, () => {
      const parentE = extent(parent);
      const count = scheme === 'QUADTREE' ? 4 : 8;
      const children: { min: number[]; max: number[] }[] = [];
      for (let i = 0; i < count; i += 1) {
        children.push(extent(subdivideBoundingVolume(scheme, parent, i) as BoundingVolume));
      }
      // Contained in the parent.
      for (const c of children) {
        for (const i of [0, 1, 2]) {
          expect(c.min[i] as number).toBeGreaterThanOrEqual((parentE.min[i] as number) - TOL);
          expect(c.max[i] as number).toBeLessThanOrEqual((parentE.max[i] as number) + TOL);
        }
      }
      // Pairwise disjoint interiors.
      for (let a = 0; a < children.length; a += 1) {
        for (let b = a + 1; b < children.length; b += 1) {
          expect(overlaps(children[a] as { min: number[]; max: number[] }, children[b] as { min: number[]; max: number[] })).toBe(false);
        }
      }
      // Disjoint pieces summing to the parent volume means the union covers it.
      const total = children.reduce((acc, c) => acc + volumeSize(c), 0);
      expect(total).toBeCloseTo(volumeSize(parentE), 12);
      // The union's outer bounds equal the parent's on every axis.
      for (const i of [0, 1, 2]) {
        expect(Math.min(...children.map((c) => c.min[i] as number))).toBeCloseTo(parentE.min[i] as number, 12);
        expect(Math.max(...children.map((c) => c.max[i] as number))).toBeCloseTo(parentE.max[i] as number, 12);
      }
    });
  }

  it('returns null for a volume kind with no exact subdivision', () => {
    expect(subdivideBoundingVolume('QUADTREE', { sphere: [0, 0, 0, 5] }, 0)).toBeNull();
    expect(subdivideBoundingVolume('OCTREE', { sphere: [0, 0, 0, 5] }, 7)).toBeNull();
  });

  it('refuses a child index outside the scheme', () => {
    expect(() => subdivideBoundingVolume('QUADTREE', parentBox, 4)).toThrow(/childIndex/);
    expect(() => subdivideBoundingVolume('OCTREE', parentBox, 8)).toThrow(/childIndex/);
    expect(() => subdivideBoundingVolume('OCTREE', parentBox, -1)).toThrow(/childIndex/);
  });
});

describe('3D Tiles implicit tiling: geometric error', () => {
  it('halves once per level', () => {
    expect(geometricErrorForLevel(100, 0)).toBeCloseTo(100, 12);
    expect(geometricErrorForLevel(100, 1)).toBeCloseTo(50, 12);
    expect(geometricErrorForLevel(100, 3)).toBeCloseTo(12.5, 12);
    expect(geometricErrorForLevel(1024, 10)).toBeCloseTo(1, 12);
  });

  it('refuses a negative root error or a fractional level', () => {
    expect(() => geometricErrorForLevel(-1, 0)).toThrow();
    expect(() => geometricErrorForLevel(Number.NaN, 0)).toThrow();
    expect(() => geometricErrorForLevel(10, 1.5)).toThrow();
  });
});
