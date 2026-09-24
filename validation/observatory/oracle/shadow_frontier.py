#!/usr/bin/env python3
"""OB-SH-01/02 shadow frontier, written independently of the viewer (analytic-truth).

A second implementation of docs/observatory/SPEC.md SS2.4/SS5.4's frontier
definition ("the set of SURFACE or OBSERVED_EMPTY voxels 6-adjacent to a
SHADOWED, UNADDRESSED or NO_RETURN_PATH voxel"), derived from that prose
alone, not from src/observation/shadowFrontier.ts. It walks a small, fully
explicit 3D grid of states (state-grid.json) and freezes, for every voxel,
whether it is a frontier voxel and which of the three neighbour kinds it
touches.

tests/observatoryFixturesO5.test.ts does not re-enumerate the grid: it reads
the frozen output this script writes and replays the same grid through
computeShadowFrontier, so the two implementations are compared on results
only, matching state_table.py's own pattern (see that file's docstring for
the same "not external validation" caveat, which applies here identically:
both implementations mirror this project's own SPEC prose).

Standard library only. No OpenLiDARViewer code is imported.

Usage:
  shadow_frontier.py --write   regenerate the frozen expectation
  shadow_frontier.py --check   recompute and compare against it
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRID = HERE / "shadow-frontier-grid.json"
EXPECTED = HERE.parent / "expected" / "shadow-frontier-grid.expected.json"

SHADOW_ADJACENT = {"SHADOWED", "UNADDRESSED", "NO_RETURN_PATH"}
FRONTIER_CANDIDATE = {"SURFACE", "OBSERVED_EMPTY"}

NEIGHBOUR_OFFSETS = [
    (1, 0, 0), (-1, 0, 0),
    (0, 1, 0), (0, -1, 0),
    (0, 0, 1), (0, 0, -1),
]


def compute(grid_def):
    nx, ny, nz = grid_def["nx"], grid_def["ny"], grid_def["nz"]
    cells = grid_def["cells"]  # list of {ix, iy, iz, state}
    state_by_coord = {(c["ix"], c["iy"], c["iz"]): c["state"] for c in cells}

    frontier_keys = []
    adjacent_to_shadowed = 0
    adjacent_to_unaddressed = 0
    adjacent_to_no_return_path = 0
    exposed_face_count = 0

    for c in cells:
        if c["state"] not in FRONTIER_CANDIDATE:
            continue
        ix, iy, iz = c["ix"], c["iy"], c["iz"]
        touches_shadowed = touches_unaddressed = touches_no_return = False
        for dx, dy, dz in NEIGHBOUR_OFFSETS:
            nx2, ny2, nz2 = ix + dx, iy + dy, iz + dz
            if not (0 <= nx2 < nx and 0 <= ny2 < ny and 0 <= nz2 < nz):
                continue
            neighbour_state = state_by_coord.get((nx2, ny2, nz2))
            if neighbour_state not in SHADOW_ADJACENT:
                continue
            exposed_face_count += 1
            if neighbour_state == "SHADOWED":
                touches_shadowed = True
            elif neighbour_state == "UNADDRESSED":
                touches_unaddressed = True
            else:
                touches_no_return = True
        if touches_shadowed or touches_unaddressed or touches_no_return:
            frontier_keys.append(ix + nx * (iy + ny * iz))
            adjacent_to_shadowed += touches_shadowed
            adjacent_to_unaddressed += touches_unaddressed
            adjacent_to_no_return_path += touches_no_return

    frontier_keys.sort()
    return {
        "frontierVoxelKeys": frontier_keys,
        "exposedFaceCount": exposed_face_count,
        "adjacentToShadowed": adjacent_to_shadowed,
        "adjacentToUnaddressed": adjacent_to_unaddressed,
        "adjacentToNoReturnPath": adjacent_to_no_return_path,
    }


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()

    grid_def = json.loads(GRID.read_text())
    result = compute(grid_def)

    if args.write:
        EXPECTED.write_text(json.dumps(result, indent=2) + "\n")
        print(f"wrote {EXPECTED}")
        return 0

    frozen = json.loads(EXPECTED.read_text())
    if result != frozen:
        print("MISMATCH between recomputed and frozen shadow-frontier result", file=sys.stderr)
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 1
    print("OK: shadow frontier matches frozen expectation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
