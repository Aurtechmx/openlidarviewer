"""Seeded fixtures for the DTM median range study (protocol v4).

Run from the repository root:  python3 -I scripts/dtm-median-range-fixtures.py
Protocol: validation/protocols/dtm-median-gridding-v4.md

Pure Python (no NumPy), so the draws depend only on the seed and IEEE double
arithmetic. Writes validation/cross-implementation/dtm-median/range/fixtures/
draw-NN.csv (local x, y, z as OLV holds them after ingest) and draws.csv.

Ingest rule, as OLV's LAS path applies it (src/io/lasDataOrigin.ts): world
coordinates are stored as integers at a 0.001 m scale with an integer offset,
decoded as int * 0.001 + offset in float64, the load origin is the floored
minimum on each axis, and local = float32(world - origin).
"""
import math, os, struct

SEED = 20261026
DRAWS_RANDOM = 48
NOMINAL_CELLS = 30          # nominal grid is 30 x 30 cells of the drawn size
OUT = 'validation/cross-implementation/dtm-median/range/fixtures/'
MASK64 = (1 << 64) - 1


class SplitMix64:
    def __init__(self, seed):
        self.s = seed & MASK64

    def next(self):
        self.s = (self.s + 0x9E3779B97F4A7C15) & MASK64
        z = self.s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def uniform(self):
        return (self.next() >> 11) * (2.0 ** -53)

    def below(self, n):
        return int(self.uniform() * n)


def f32(v):
    return struct.unpack('<f', struct.pack('<f', v))[0]


def ingest(values, offset):
    # LAS storage at 0.001 m: int = round((v - offset) / 0.001); world = int * 0.001 + offset.
    world = [round((v - offset) / 0.001) * 0.001 + offset for v in values]
    origin = math.floor(min(world))
    return [f32(w - origin) for w in world], origin


def main():
    rng = SplitMix64(SEED)
    sizes = [0.1 * 100.0 ** rng.uniform() for _ in range(DRAWS_RANDOM)] + [0.1, 10.0]
    os.makedirs(OUT, exist_ok=True)
    rows = ['draw,cellSize,large,baseE,baseN,originE,originN,originZ,points']
    for d, s in enumerate(sizes):
        large = d % 2 == 0
        # Random origin offset for every draw: a fractional base on both axes.
        base_e = (500000.0 + 1000.0 * rng.uniform()) if large else 100.0 * rng.uniform()
        base_n = (4000000.0 + 1000.0 * rng.uniform()) if large else 100.0 * rng.uniform()
        hole_i, hole_j = 3 + rng.below(NOMINAL_CELLS - 12), 3 + rng.below(NOMINAL_CELLS - 12)
        xs, ys, zs = [], [], []
        for i in range(NOMINAL_CELLS):
            for j in range(NOMINAL_CELLS):
                if hole_i <= i < hole_i + 6 and hole_j <= j < hole_j + 6:
                    continue  # a 6 x 6 empty block
                k = 0 if rng.uniform() < 0.15 else 1 + rng.below(5)
                for _ in range(k):
                    x = base_e + (i + rng.uniform()) * s
                    y = base_n + (j + rng.uniform()) * s
                    z = 100.0 + 8.0 * math.sin(i / 7.0) + 5.0 * math.cos(j / 5.0) + 0.5 * (rng.uniform() - 0.5)
                    xs.append(x); ys.append(y); zs.append(z)
        lx, ox = ingest(xs, math.floor(base_e))
        ly, oy = ingest(ys, math.floor(base_n))
        lz, oz = ingest(zs, 0.0)
        with open(f'{OUT}draw-{d:02d}.csv', 'w') as f:
            f.write('x,y,z\n')
            for a, b, c in zip(lx, ly, lz):
                f.write(f'{a!r},{b!r},{c!r}\n')
        rows.append(f'{d},{s!r},{int(large)},{base_e!r},{base_n!r},{ox},{oy},{oz},{len(lx)}')
    with open(OUT + 'draws.csv', 'w') as f:
        f.write('\n'.join(rows) + '\n')


main()
