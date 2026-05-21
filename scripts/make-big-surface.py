#!/usr/bin/env python3
"""Generate a synthetic georeferenced LAS surface scan for render verification.

Stdlib only — writes an uncompressed LAS 1.2 (point format 0) file: a terrain
grid with sine-wave relief, varying intensity, and a few classification codes.
Used to confirm the viewer renders a real multi-thousand-point cloud as a
visible surface (not just the tiny bundled fixtures).

Usage: python3 scripts/make-big-surface.py [out.las] [grid]
"""
import math
import struct
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/big-surface.las"
grid = int(sys.argv[2]) if len(sys.argv) > 2 else 400  # grid x grid points

SCALE = (0.001, 0.001, 0.001)
OFFSET = (500000.0, 4100000.0, 100.0)  # UTM-like — exercises the coordinate bridge
N = grid * grid

# --- point records ---------------------------------------------------------
records = bytearray()
xs, ys, zs = [], [], []
for i in range(grid):
    for j in range(grid):
        gx = 500000.0 + i * 1.0
        gy = 4100000.0 + j * 1.0
        gz = 100.0 + 10.0 * math.sin(i / 40.0) * math.cos(j / 40.0)
        xs.append(gx); ys.append(gy); zs.append(gz)
        xi = round((gx - OFFSET[0]) / SCALE[0])
        yi = round((gy - OFFSET[1]) / SCALE[1])
        zi = round((gz - OFFSET[2]) / SCALE[2])
        intensity = (i * 31 + j * 17) % 65536
        classification = 2 if (gz < 100.0) else (5 if (gz > 106.0) else 3)
        records += struct.pack("<iiiHBBbBH", xi, yi, zi, intensity, 0,
                               classification, 0, 0, 0)

# --- public header (LAS 1.2, 227 bytes) ------------------------------------
h = bytearray(227)
h[0:4] = b"LASF"
h[24] = 1            # version major
h[25] = 2            # version minor
struct.pack_into("<H", h, 94, 227)    # header size
struct.pack_into("<I", h, 96, 227)    # offset to point data
struct.pack_into("<I", h, 100, 0)     # number of VLRs
h[104] = 0                            # point data record format 0
struct.pack_into("<H", h, 105, 20)    # point data record length
struct.pack_into("<I", h, 107, N)     # legacy point count
struct.pack_into("<ddd", h, 131, *SCALE)
struct.pack_into("<ddd", h, 155, *OFFSET)
struct.pack_into("<d", h, 179, max(xs)); struct.pack_into("<d", h, 187, min(xs))
struct.pack_into("<d", h, 195, max(ys)); struct.pack_into("<d", h, 203, min(ys))
struct.pack_into("<d", h, 211, max(zs)); struct.pack_into("<d", h, 219, min(zs))

with open(out, "wb") as f:
    f.write(h)
    f.write(records)

print(f"wrote {out}: {N} points, {227 + len(records)} bytes")
