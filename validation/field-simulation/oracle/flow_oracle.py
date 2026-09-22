#!/usr/bin/env python3
"""D8 flow routing and accumulation, written independently of the viewer.

This is a second implementation of the same two published methods, in another
language, derived from their definitions rather than from the TypeScript:

  D8 flow direction  - O'Callaghan & Mark (1984). Each cell drains to whichever
                       of its eight neighbours gives the steepest descent per
                       unit of horizontal distance, measured in metres.
  Flow accumulation  - the number of cells draining through each cell, itself
                       included, obtained here by walking downstream from every
                       cell rather than by the dependency-ordered pass the
                       viewer uses. A different algorithm for the same
                       quantity: if the two agree on every fixture, they are
                       unlikely to be wrong in the same way.

WHAT THIS IS AND IS NOT. Agreement between these two implementations catches
transcription slips, tie-break drift and axis-scaling mistakes. It is not
external validation: both were written in the same project, and a shared
misreading of the method would survive. The fixtures are deliberately small
enough that their expected fields can also be checked by hand.

Nothing here imports OpenLiDARViewer code, and nothing here reads its output.
Standard library only, so the check has no dependency to install or pin.

Usage:
  flow_oracle.py --write   regenerate the frozen expectations
  flow_oracle.py --check   recompute and compare against them
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"
EXPECTED = HERE.parent / "expected"

# Neighbour offsets in the order ties are broken. This ordering is part of the
# method as the project defines it: two neighbours can offer an identical drop
# per unit distance, and the first one listed wins. Written out here rather
# than imported so that a change on either side shows up as a disagreement.
NEIGHBOURS = [
    (1, 0),    # E
    (1, 1),    # SE
    (0, 1),    # S
    (-1, 1),   # SW
    (-1, 0),   # W
    (-1, -1),  # NW
    (0, -1),   # N
    (1, -1),   # NE
]

ROUTED, SINK, FLAT, NODATA, OUTLET = 0, 1, 2, 3, 4


def route(z, valid, cols, rows, mx, my):
    """Return (receiver, direction, status) for a grid, as flat lists."""
    receiver = [-1] * (cols * rows)
    direction = [-1] * (cols * rows)
    status = [0] * (cols * rows)
    step = [math.hypot(dx * mx, dy * my) for dx, dy in NEIGHBOURS]

    for row in range(rows):
        for col in range(cols):
            here = row * cols + col
            if not valid[here]:
                status[here] = NODATA
                continue

            best_gradient = 0.0
            best_dir = -1
            best_cell = -1
            saw_equal = False
            saw_edge = False

            for d, (dx, dy) in enumerate(NEIGHBOURS):
                nc, nr = col + dx, row + dy
                if nc < 0 or nc >= cols or nr < 0 or nr >= rows:
                    saw_edge = True
                    continue
                there = nr * cols + nc
                if not valid[there]:
                    continue
                drop = z[here] - z[there]
                if drop == 0:
                    saw_equal = True
                    continue
                if drop < 0:
                    continue
                gradient = drop / step[d]
                if gradient > best_gradient:
                    best_gradient, best_dir, best_cell = gradient, d, there

            if best_dir >= 0:
                receiver[here], direction[here], status[here] = best_cell, best_dir, ROUTED
            elif saw_edge:
                status[here] = OUTLET
            elif saw_equal:
                status[here] = FLAT
            else:
                status[here] = SINK

    return receiver, direction, status


def accumulate(receiver, status, cols, rows):
    """Upstream cell count per cell, by walking downstream from every cell.

    Deliberately the naive quadratic method. The viewer drains cells in
    dependency order, so an error in its bookkeeping would not reproduce here.
    """
    n = cols * rows
    upstream = [0] * n
    for start in range(n):
        if status[start] == NODATA:
            continue
        seen = set()
        at = start
        while at >= 0 and at not in seen:
            seen.add(at)
            upstream[at] += 1
            at = receiver[at]
    return upstream


def load_fixture(path):
    spec = json.loads(path.read_text())
    rows_in = spec["z"]
    rows = len(rows_in)
    cols = len(rows_in[0])
    z, valid = [], []
    for r in rows_in:
        for v in r:
            valid.append(0 if v is None else 1)
            z.append(0.0 if v is None else float(v))
    return spec, z, valid, cols, rows


def compute(path):
    spec, z, valid, cols, rows = load_fixture(path)
    mx = float(spec.get("cellMetresX", 1))
    my = float(spec.get("cellMetresY", 1))
    receiver, direction, status = route(z, valid, cols, rows, mx, my)
    upstream = accumulate(receiver, status, cols, rows)
    return {
        "fixture": path.name,
        "cols": cols,
        "rows": rows,
        "cellMetresX": mx,
        "cellMetresY": my,
        "receiver": receiver,
        "direction": direction,
        "status": status,
        "upstreamCells": upstream,
        "sinkCount": status.count(SINK),
        "flatCount": status.count(FLAT),
        "outletCount": status.count(OUTLET),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="regenerate expectations")
    ap.add_argument("--check", action="store_true", help="compare against expectations")
    args = ap.parse_args()
    if args.write == args.check:
        ap.error("pass exactly one of --write or --check")

    fixtures = sorted(FIXTURES.glob("*.json"))
    if not fixtures:
        print(f"flow_oracle: no fixtures under {FIXTURES}", file=sys.stderr)
        return 1

    EXPECTED.mkdir(parents=True, exist_ok=True)
    problems = []
    for path in fixtures:
        got = compute(path)
        out = EXPECTED / path.name
        if args.write:
            out.write_text(json.dumps(got, indent=2) + "\n")
            print(f"wrote {out.relative_to(HERE.parent.parent.parent)}")
            continue
        if not out.exists():
            problems.append(f"{path.name}: no frozen expectation; run --write")
            continue
        want = json.loads(out.read_text())
        for key in ("receiver", "direction", "status", "upstreamCells",
                    "sinkCount", "flatCount", "outletCount"):
            if got[key] != want.get(key):
                problems.append(f"{path.name}: {key} differs from the frozen record")

    if problems:
        print("flow_oracle FAILED", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    if args.check:
        print(f"flow_oracle OK - {len(fixtures)} fixture(s) match the frozen record")
    return 0


if __name__ == "__main__":
    sys.exit(main())
