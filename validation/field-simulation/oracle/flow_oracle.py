#!/usr/bin/env python3
"""D8 flow routing, accumulation and Priority-Flood conditioning, written
independently of the viewer.

This is a second implementation of the same three published methods, in
another language, derived from their definitions rather than from the
TypeScript:

  D8 flow direction  - O'Callaghan & Mark (1984). Each cell drains to whichever
                       of its eight neighbours gives the steepest descent per
                       unit of horizontal distance, measured in metres.
  Flow accumulation  - the number of cells draining through each cell, itself
                       included, obtained here by walking downstream from every
                       cell rather than by the dependency-ordered pass the
                       viewer uses. A different algorithm for the same
                       quantity: if the two agree on every fixture, they are
                       unlikely to be wrong in the same way.
  Priority-Flood     - Barnes, Lehman & Mulla (2014). The surface is flooded
                       inward from its edge, always from the lowest cell
                       reached so far (heapq, ordered by spill level then by
                       insertion), and a cell reached from below is raised to
                       the level it was reached at, plus one rise so every
                       filled flat drains. The rules the viewer fixes and this
                       file repeats from the method's definition: the rise is
                       the next float64 above the parent (math.nextafter) or a
                       fixed number; a NoData cell is a wall, so the flood
                       seeds only at the grid boundary and at the rim of NoData
                       that reaches it, and reads an enclosed gap as an exit
                       only when the fixture asks for it; a cell is in a
                       depression only when its ORIGINAL height is strictly
                       below the spill level it was reached from; cells NoData
                       encloses are never reached and are counted, not filled.
                       The input heights are read as float32, the precision the
                       viewer's grids hold, so the float64 rises start from the
                       same values on both sides.

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
import heapq
import json
import math
import struct
import sys
from collections import deque
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
    (1, 1),    # NE
    (0, 1),    # N
    (-1, 1),   # NW
    (-1, 0),   # W
    (-1, -1),  # SW
    (0, -1),   # S
    (1, -1),   # SE
]

ROUTED, SINK, FLAT, NODATA, OUTLET = 0, 1, 2, 3, 4


def outside_surface(valid, cols, rows):
    """NoData cells joined to the grid border through NoData, 4-connected.

    Such a cell lies outside the mapped surface, so a cell beside it drains off
    the surface the way a cell on the grid border does. NoData the surface
    encloses is a hole in it and stays a wall.
    """
    outside = [False] * (cols * rows)
    queue = deque()
    for row in range(rows):
        for col in range(cols):
            i = row * cols + col
            on_border = col in (0, cols - 1) or row in (0, rows - 1)
            if on_border and not valid[i]:
                outside[i] = True
                queue.append(i)
    while queue:
        i = queue.popleft()
        col, row = i % cols, i // cols
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dx, row + dy
            if 0 <= nc < cols and 0 <= nr < rows:
                j = nr * cols + nc
                if not valid[j] and not outside[j]:
                    outside[j] = True
                    queue.append(j)
    return outside


def route(z, valid, cols, rows, mx, my):
    """Return (receiver, direction, status) for a grid, as flat lists."""
    outside = outside_surface(valid, cols, rows)
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
                    if outside[there]:
                        saw_edge = True
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


def f32(v):
    """The nearest float32 to v, as a Python float (the viewer holds heights in Float32Array)."""
    return struct.unpack('<f', struct.pack('<f', v))[0]


class _Flood:
    """The state of one Priority-Flood run, advanced one cell at a time."""

    def __init__(self, z, valid, cols, rows, epsilon, nodata):
        self.valid, self.cols, self.rows = valid, cols, rows
        self.epsilon = epsilon
        self.gaps_are_exits = nodata == 'outlet'
        self.step = epsilon == 'float64-step'
        self.rises = self.step or epsilon > 0
        self.n = cols * rows
        self.source = [f32(v) for v in z]
        self.out = list(self.source)
        self.spill = list(self.source)
        self.closed = [False] * self.n
        self.outside = outside_surface(valid, cols, rows)
        self.heap = []
        self.seq = 0
        self.depression = [0] * self.n
        self.cells_raised = 0
        self.max_fill_depth = 0.0
        self.fill_depth_sum = 0.0
        self.flat_cells_resolved = 0
        self.epsilon_absorbed = 0

    def rise(self, zc):
        return math.nextafter(zc, math.inf) if self.step else zc + self.epsilon

    def push(self, i):
        heapq.heappush(self.heap, (self.spill[i], self.seq, i))
        self.seq += 1

    def edge_seed(self, col, row):
        if col == 0 or row == 0 or col == self.cols - 1 or row == self.rows - 1:
            return True
        for dx, dy in NEIGHBOURS:
            nb = (row + dy) * self.cols + col + dx
            if not self.valid[nb] and (self.gaps_are_exits or self.outside[nb]):
                return True
        return False

    def seed(self):
        for row in range(self.rows):
            for col in range(self.cols):
                i = row * self.cols + col
                if self.valid[i] and self.edge_seed(col, row):
                    self.closed[i] = True
                    self.push(i)

    def neighbours(self, c):
        """Valid, not yet reached neighbours of cell c."""
        col, row = c % self.cols, c // self.cols
        for dx, dy in NEIGHBOURS:
            nc, nr = col + dx, row + dy
            if 0 <= nc < self.cols and 0 <= nr < self.rows:
                nb = nr * self.cols + nc
                if self.valid[nb] and not self.closed[nb]:
                    yield nb

    def fill(self, nb, level):
        """Record a depression cell reached from a spill level above its own height."""
        original = self.source[nb]
        self.depression[nb] = 1
        self.spill[nb] = level
        depth = level - original
        self.cells_raised += 1
        self.fill_depth_sum += depth
        self.max_fill_depth = max(self.max_fill_depth, depth)

    def lift(self, nb, zc):
        """Raise a cell at or below its parent so the flat drains."""
        original = self.source[nb]
        self.out[nb] = self.rise(zc)
        if self.depression[nb] != 1 and self.out[nb] > original:
            self.flat_cells_resolved += 1
        if self.rises and self.out[nb] <= zc:
            self.epsilon_absorbed += 1

    def run(self):
        self.seed()
        while self.heap:
            _, _, c = heapq.heappop(self.heap)
            zc = self.out[c]
            level = self.spill[c]
            for nb in self.neighbours(c):
                self.closed[nb] = True
                original = self.source[nb]
                if original < level:
                    self.fill(nb, level)
                if original <= zc:
                    self.lift(nb, zc)
                self.push(nb)


def priority_flood(z, valid, cols, rows, epsilon='float64-step', nodata='wall'):
    """Condition a surface so every reachable valid cell drains to the boundary.

    Returns a dict with the conditioned heights (float64), the spill level each
    cell was reached at, the depression mask, and the counts the viewer reports.
    Invalid cells keep their input value in the conditioned surface and the
    spill level, and are null in the frozen record.
    """
    if epsilon != 'float64-step' and not (isinstance(epsilon, (int, float)) and epsilon >= 0):
        raise ValueError('epsilon must be "float64-step" or a non-negative number')
    if nodata not in ('wall', 'outlet'):
        raise ValueError('nodata must be "wall" or "outlet"')
    flood = _Flood(z, valid, cols, rows, epsilon, nodata)
    flood.run()
    n = flood.n
    cells_unreachable = sum(1 for i in range(n) if valid[i] and not flood.closed[i])
    return {
        "conditioning": {"epsilon": epsilon, "noData": nodata},
        "conditionedZ": [flood.out[i] if valid[i] else None for i in range(n)],
        "spillLevel": [flood.spill[i] if valid[i] else None for i in range(n)],
        "depressionMask": flood.depression,
        "cellsRaised": flood.cells_raised,
        "maxFillDepth": flood.max_fill_depth,
        "fillDepthSum": flood.fill_depth_sum,
        "flatCellsResolved": flood.flat_cells_resolved,
        "epsilonAbsorbed": flood.epsilon_absorbed,
        "cellsUnreachable": cells_unreachable,
    }


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
    # Every fixture is also conditioned, with the viewer's defaults for a
    # conditioned run unless the fixture names its own (a "conditioning" block
    # with "epsilon" and "noData"), so the conditioned surface and the filled
    # mask are compared on every terrain, not only the one with a pit.
    cond = spec.get("conditioning", {})
    flood = priority_flood(z, valid, cols, rows,
                           epsilon=cond.get("epsilon", "float64-step"),
                           nodata=cond.get("noData", "wall"))
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
        **flood,
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
                    "sinkCount", "flatCount", "outletCount",
                    "conditioning", "conditionedZ", "spillLevel", "depressionMask",
                    "cellsRaised", "maxFillDepth", "fillDepthSum",
                    "flatCellsResolved", "epsilonAbsorbed", "cellsUnreachable"):
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
