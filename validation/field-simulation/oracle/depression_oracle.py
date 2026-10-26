#!/usr/bin/env python3
"""depression_oracle.py: expected depression figures, written from the definition.

For every grid in ../fixtures/ and in ../depression-cases/, this computes what a
Priority-Flood fill (Barnes, Lehman and Mulla 2014) must give, and writes it to
../expected-depressions/. It is written from the published definition and from
the conventions documented in docs/terrain-flow-pulse.md, not from the
TypeScript in src/simulation/flowPulse/, so a slip in one need not reproduce in
the other. Both are still this project's code, so agreement between them is a
check of the arithmetic and the bookkeeping, not external validation.

Conventions, all from the documentation:

- Grid row 0 is whichever row the fixture lists first. The fill does not depend
  on orientation, and every index below is row-major over the fixture as
  stored.
- A cell is an outlet seed when it is on the grid border, or 8-adjacent to a
  NoData cell that reaches the border through NoData cells (4-connected), or,
  when NoData is read as an outlet, 8-adjacent to any NoData cell.
- The spill level of a cell is the lowest level at which water reaching it can
  leave the grid. A cell is in a depression when its own elevation is strictly
  below its spill level. The fill is computed by a plain priority queue on the
  spill level; ties do not change spill levels.
- Depressions are the 8-connected components of the depression cells.
- A depression's outlet elevation is the lowest elevation among the valid
  cells 8-adjacent to it that are not depression cells.
- Elevations are rounded to Float32 on load, as the viewer stores a DTM, and
  every depth is then computed in double precision from those values.
- Fill volume is the sum over a depression of (spill level - elevation) times
  the cell area (cellMetresX x cellMetresY).

Usage:
  python3 depression_oracle.py --write   regenerate ../expected-depressions/
  python3 depression_oracle.py --check   compare against the committed records
"""
import argparse
import heapq
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCES = [ROOT / "fixtures", ROOT / "depression-cases"]
EXPECTED = ROOT / "expected-depressions"
N8 = [(dc, dr) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dc or dr]


def outside_nodata(valid, cols, rows):
    out = [False] * (cols * rows)
    stack = []
    for r in range(rows):
        for c in range(cols):
            if (r in (0, rows - 1) or c in (0, cols - 1)) and not valid[r * cols + c]:
                out[r * cols + c] = True
                stack.append(r * cols + c)
    while stack:
        i = stack.pop()
        c, r = i % cols, i // cols
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < cols and 0 <= nr < rows:
                j = nr * cols + nc
                if not valid[j] and not out[j]:
                    out[j] = True
                    stack.append(j)
    return out


def fill(z, valid, cols, rows, gaps_are_exits):
    outside = outside_nodata(valid, cols, rows)
    spill = list(z)
    done = [False] * (cols * rows)
    heap = []
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            if not valid[i]:
                continue
            seed = r in (0, rows - 1) or c in (0, cols - 1)
            for dc, dr in N8:
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < rows:
                    j = nr * cols + nc
                    if not valid[j] and (outside[j] or gaps_are_exits):
                        seed = True
            if seed:
                done[i] = True
                heapq.heappush(heap, (z[i], i))
    while heap:
        level, i = heapq.heappop(heap)
        c, r = i % cols, i // cols
        for dc, dr in N8:
            nc, nr = c + dc, r + dr
            if not (0 <= nc < cols and 0 <= nr < rows):
                continue
            j = nr * cols + nc
            if not valid[j] or done[j]:
                continue
            done[j] = True
            spill[j] = max(z[j], level)
            heapq.heappush(heap, (spill[j], j))
    unreachable = sum(1 for i in range(cols * rows) if valid[i] and not done[i])
    return spill, done, unreachable


def depressions(z, valid, spill, done, cols, rows, mx, my):
    inside = [valid[i] and done[i] and z[i] < spill[i] for i in range(cols * rows)]
    label = [-1] * (cols * rows)
    out = []
    for s in range(cols * rows):
        if not inside[s] or label[s] != -1:
            continue
        members = []
        stack = [s]
        label[s] = len(out)
        while stack:
            i = stack.pop()
            members.append(i)
            c, r = i % cols, i // cols
            for dc, dr in N8:
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < rows:
                    j = nr * cols + nc
                    if inside[j] and label[j] == -1:
                        label[j] = len(out)
                        stack.append(j)
        rim = None
        for i in members:
            c, r = i % cols, i // cols
            for dc, dr in N8:
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < rows:
                    j = nr * cols + nc
                    if valid[j] and not inside[j]:
                        rim = z[j] if rim is None else min(rim, z[j])
        depths = [spill[i] - z[i] for i in members]
        out.append({
            "seedCell": min(members),
            "cells": sorted(members),
            "cellCount": len(members),
            "areaM2": len(members) * mx * my,
            "maxFillDepth": max(depths),
            "fillDepthSum": sum(depths),
            "fillVolumeM3": sum(depths) * mx * my,
            "spillLevels": sorted(set(spill[i] for i in members)),
            "outletElevation": rim,
        })
    out.sort(key=lambda d: (-d["cellCount"], d["seedCell"]))
    return out


def compute(path):
    spec = json.loads(path.read_text())
    rows_in = spec["z"]
    rows, cols = len(rows_in), len(rows_in[0])
    z, valid = [], []
    for row in rows_in:
        for v in row:
            valid.append(v is not None)
            z.append(0.0 if v is None else struct.unpack("<f", struct.pack("<f", float(v)))[0])
    mx = float(spec.get("cellMetresX", 1))
    my = float(spec.get("cellMetresY", 1))
    result = {"fixture": f"{path.parent.name}/{path.name}", "cols": cols, "rows": rows,
              "cellMetresX": mx, "cellMetresY": my}
    for mode in ("wall", "outlet"):
        spill, done, unreachable = fill(z, valid, cols, rows, mode == "outlet")
        deps = depressions(z, valid, spill, done, cols, rows, mx, my)
        result[mode] = {
            "cellsUnreachable": unreachable,
            "depressionCount": len(deps),
            "filledCellCount": sum(d["cellCount"] for d in deps),
            "fillDepthSum": sum(d["fillDepthSum"] for d in deps),
            "fillVolumeM3": sum(d["fillVolumeM3"] for d in deps),
            "depressions": deps,
        }
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.write == args.check:
        ap.error("pass exactly one of --write or --check")
    paths = sorted(p for d in SOURCES if d.exists() for p in d.glob("*.json"))
    EXPECTED.mkdir(exist_ok=True)
    problems = []
    for p in paths:
        got = compute(p)
        out = EXPECTED / f"{p.parent.name}__{p.name}"
        text = json.dumps(got, indent=1) + "\n"
        if args.write:
            out.write_text(text)
            continue
        if not out.exists() or out.read_text() != text:
            problems.append(out.name)
    if problems:
        print("depression_oracle FAILED: " + ", ".join(problems), file=sys.stderr)
        return 1
    print(f"depression_oracle {'wrote' if args.write else 'OK'} - {len(paths)} grid(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
