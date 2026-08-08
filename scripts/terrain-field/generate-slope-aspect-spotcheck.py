#!/usr/bin/env python3
"""
generate-slope-aspect-spotcheck.py — an INDEPENDENT slope/aspect reference.

Reads the committed scipy point-in-cell DTM (whitesands-dune__bincell-dtm.asc)
and computes Horn 3x3 slope and aspect with NumPy, using the exact convention
OLV's terrainDerivatives.hornSlopeAspect uses:

    dzdx = (E + 2*E + E - (W + 2*W + W)) / (8*cellX)     # +east
    dzdy = (N + 2*N + N - (S + 2*S + S)) / (8*cellY)     # +north (row+1 = north)
    slope  = hypot(dzdx, dzdy)                            # gradient magnitude (m/m)
    aspect = atan2(-dzdy, -dzdx)                          # radians, downslope dir

It freezes ~120 deterministic INTERIOR cells whose full 3x3 neighbourhood is
populated (no nodata), so OLV's Horn and this Horn see identical finite inputs
and must agree to floating-point tolerance. This is a small complementary
real-data check; it does not replace the E4 cross-implementation studies.

The z grid is laid out SOUTH-UP (row 0 = south) to match OLV's readAsciiSouthUp,
so the frozen cell indices (row*cols + col) line up with OLV's grid.
"""
import json
import sys
import numpy as np

ASC = sys.argv[1] if len(sys.argv) > 1 else "validation/terrain-field/references/whitesands-dune__bincell-dtm.asc"
OUT = sys.argv[2] if len(sys.argv) > 2 else "validation/terrain-field/references/whitesands-dune__slope-aspect-spotcheck.json"
STRIDE = 27  # deterministic sampling stride over the eligible cells → ~120 cells


def read_asc(path):
    hdr = {}
    with open(path) as fh:
        lines = fh.read().split("\n")
    i = 0
    for i, ln in enumerate(lines):
        parts = ln.split()
        if len(parts) == 2 and parts[0].replace("_", "").isalpha():
            hdr[parts[0].lower()] = float(parts[1])
        else:
            break
    cols, rows = int(hdr["ncols"]), int(hdr["nrows"])
    nodata = hdr.get("nodata_value", -9999.0)
    nums = " ".join(lines[i:]).split()
    g = np.array(nums, dtype=np.float64).reshape(rows, cols)  # file row 0 = north
    z = np.flipud(g)  # row 0 = south, matching OLV
    z = np.where(z == nodata, np.nan, z)
    # OLV's DTM grid is Float32; its Horn kernel reads those float32 values and
    # does the gradient arithmetic in float64. Match that input precision exactly
    # (quantise to float32, compute in float64) so this compares the Horn
    # IMPLEMENTATION, not the grid's storage precision.
    z = z.astype(np.float32).astype(np.float64)
    return z, cols, rows


def main():
    z, cols, rows = read_asc(ASC)
    cellx = celly = 1.0
    cells = []
    for r in range(1, rows - 1):
        for c in range(1, cols - 1):
            w = z[r - 1:r + 2, c - 1:c + 2]
            if np.any(~np.isfinite(w)):
                continue
            a, b, cc = w[0, 0], w[0, 1], w[0, 2]  # south row (r-1)
            d, f = w[1, 0], w[1, 2]
            g, h, ii = w[2, 0], w[2, 1], w[2, 2]  # north row (r+1)
            dzdx = (cc + 2 * f + ii - (a + 2 * d + g)) / (8 * cellx)
            dzdy = (g + 2 * h + ii - (a + 2 * b + cc)) / (8 * celly)
            slope = float(np.hypot(dzdx, dzdy))
            aspect = 0.0 if (dzdx == 0 and dzdy == 0) else float(np.arctan2(-dzdy, -dzdx))
            cells.append({"index": r * cols + c, "slope": slope, "aspect": aspect})

    sampled = cells[::STRIDE]
    ref = {
        "tool": "numpy",
        "version": np.__version__,
        "method": "Horn 3x3 gradient; slope=hypot(dzdx,dzdy); aspect=atan2(-dzdy,-dzdx) rad",
        "input": "whitesands-dune__bincell-dtm.asc (scipy point-in-cell DTM)",
        "grid": {"cols": cols, "rows": rows, "cellSizeM": 1, "layout": "south-up"},
        "tolerance": {"slopeAbs": 1e-6, "aspectRad": 1e-6},
        "eligibleCells": len(cells),
        "cells": sampled,
    }
    with open(OUT, "w") as fh:
        json.dump(ref, fh, indent=2)
        fh.write("\n")
    print(f"wrote {len(sampled)} spot-check cells (of {len(cells)} eligible) to {OUT}")


if __name__ == "__main__":
    main()
