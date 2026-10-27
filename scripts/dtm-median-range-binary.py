"""Exact binary inputs for the DTM median range study, protocol v5.

Run from the repository root:  python3 -I scripts/dtm-median-range-binary.py
Reads range/fixtures/draw-NN.csv (shortest round-trip decimals, which Python
parses exactly) and writes range/fixtures/draw-NN.f64: little-endian float64
triples x, y, z in file order. Checks that every value read back from the
binary is bit-identical to the parsed decimal.
"""
import struct

F = 'validation/cross-implementation/dtm-median/range/fixtures/'
for d in range(50):
    rows = open(f'{F}draw-{d:02d}.csv').read().strip().split('\n')[1:]
    vals = [float(v) for r in rows for v in r.split(',')]
    blob = struct.pack(f'<{len(vals)}d', *vals)
    back = struct.unpack(f'<{len(vals)}d', blob)
    assert all(struct.pack('<d', a) == struct.pack('<d', b) for a, b in zip(vals, back)), d
    open(f'{F}draw-{d:02d}.f64', 'wb').write(blob)

# The cell sizes are inputs too: cellsizes.f64 holds the 50 sizes from
# draws.csv as little-endian float64, in draw order, checked the same way.
sizes = [float(r.split(',')[1]) for r in open(F + 'draws.csv').read().strip().split('\n')[1:]]
blob = struct.pack(f'<{len(sizes)}d', *sizes)
assert list(struct.unpack(f'<{len(sizes)}d', blob)) == sizes
open(F + 'cellsizes.f64', 'wb').write(blob)
