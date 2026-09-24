#!/usr/bin/env python3
"""OB-LED-01/OB-LED-02 ray-AABB clip and voxel traversal (analytic-truth).

Reads validation/observatory/fixtures/f8-dda-cases.json (written by
scripts/generate-observatory-fixtures.mjs, committed alongside this oracle's
output) and computes, for each case, the ray-AABB clip interval and the
ordered voxel list Amanatides & Woo (1987) traversal visits, stepping in
exact rational arithmetic (fractions.Fraction) so a ray chosen to land exactly
on a voxel face or corner is resolved by the written tie rule rather than by
whatever a float rounds to.

TIE RULE (OB-LED-01), read from the fixture's own `tieRule` field and
implemented here as plain floor division: a coordinate exactly on a voxel
boundary belongs to the voxel on the POSITIVE side of that boundary along
that axis, i.e. voxel i owns the half-open interval [i*h, (i+1)*h). A ray
that grazes a shared corner or edge is not a special case: advancing two or
three axes in the same traversal step, when their distances to the next
boundary are EXACTLY equal, is this same per-axis rule applied simultaneously.

O1 does not implement this traversal in TypeScript (that is O4). This phase's
TypeScript test instead reads the frozen records this script writes and
checks them against the FIXTURE's inputs for consistency, so nothing here is
compared to a TypeScript computation yet.

Standard library only (fractions, json, argparse, pathlib).

Usage:
  ray_aabb_traversal.py --write   regenerate the frozen expectations
  ray_aabb_traversal.py --check   recompute and compare against them
"""
import argparse
import json
import sys
from fractions import Fraction as F
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "fixtures" / "f8-dda-cases.json"
EXPECTED = HERE.parent / "expected" / "f8-dda-cases.expected.json"


def clip_ray_to_aabb(origin, direction, t_min, t_max, min_corner, max_corner):
    """Slab method in exact rationals. Returns (tEntry, tExit) or None if empty."""
    entry, exit_ = t_min, t_max
    for axis in range(3):
        o, d = origin[axis], direction[axis]
        lo, hi = min_corner[axis], max_corner[axis]
        if d == 0:
            if o < lo or o > hi:
                return None
            continue
        t1 = (lo - o) / d
        t2 = (hi - o) / d
        if t1 > t2:
            t1, t2 = t2, t1
        entry = max(entry, t1)
        exit_ = min(exit_, t2)
        if entry > exit_:
            return None
    return entry, exit_


def traverse(origin, direction, t_entry, t_exit, h):
    """Amanatides & Woo (1987) voxel traversal over [t_entry, t_exit], exact rationals."""
    entry_point = [origin[a] + t_entry * direction[a] for a in range(3)]
    voxel = [(entry_point[a] / h).__floor__() for a in range(3)]
    voxels = [tuple(voxel)]

    step = [0, 0, 0]
    t_next = [None, None, None]
    t_delta = [None, None, None]
    for a in range(3):
        d = direction[a]
        if d == 0:
            continue
        step[a] = 1 if d > 0 else -1
        boundary = (voxel[a] + 1) * h if d > 0 else voxel[a] * h
        t_next[a] = (boundary - origin[a]) / d
        t_delta[a] = abs(F(h) / d)

    while True:
        finite = [(a, t_next[a]) for a in range(3) if t_next[a] is not None]
        if not finite:
            break  # a zero-direction ray: exactly the starting voxel.
        axis_min = min(t for _, t in finite)
        if axis_min >= t_exit:
            break
        for a, t in finite:
            if t == axis_min:
                voxel[a] += step[a]
                t_next[a] += t_delta[a]
        voxels.append(tuple(voxel))
    return voxels


def as_fraction_vec(v):
    return [F(x) for x in v]


def run_case(case, domain, voxel_edge):
    origin = as_fraction_vec(case["origin"])
    direction = as_fraction_vec(case["direction"])
    t_max = F(case["tMax"])
    min_corner = as_fraction_vec(domain["minCorner"])
    max_corner = as_fraction_vec(domain["maxCorner"])
    h = F(voxel_edge)

    clipped = clip_ray_to_aabb(origin, direction, F(0), t_max, min_corner, max_corner)
    if clipped is None:
        return {"clip": None, "voxels": []}
    t_entry, t_exit = clipped
    voxels = traverse(origin, direction, t_entry, t_exit, h)
    return {
        "clip": [str(t_entry), str(t_exit)],
        "voxels": [list(v) for v in voxels],
    }


def compute_all():
    fixture = json.loads(FIXTURE.read_text())
    domain = fixture["domain"]
    voxel_edge = fixture["voxelEdge"]
    records = []
    for case in fixture["cases"]:
        result = run_case(case, domain, voxel_edge)
        records.append({
            "caseId": case["id"],
            # The input echoed back verbatim, so a consistency check can
            # compare it against the fixture file without re-deriving anything.
            "input": {
                "origin": case["origin"],
                "direction": case["direction"],
                "tMax": case["tMax"],
                "domain": domain,
                "voxelEdge": voxel_edge,
            },
            "clip": result["clip"],
            "voxels": result["voxels"],
        })
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if not FIXTURE.exists():
        print(f"ray_aabb_traversal.py: FAILED — fixture missing: {FIXTURE}", file=sys.stderr)
        return 1

    records = compute_all()

    if args.write:
        EXPECTED.parent.mkdir(parents=True, exist_ok=True)
        EXPECTED.write_text(json.dumps({"schemaVersion": 1, "cases": records}, indent=2) + "\n")
        print(f"ray_aabb_traversal.py --write: wrote {len(records)} case(s)")
        return 0

    if not EXPECTED.exists():
        print("ray_aabb_traversal.py --check: FAILED — no frozen expectations. Run --write first.", file=sys.stderr)
        return 1
    frozen = json.loads(EXPECTED.read_text())
    if frozen.get("cases") != records:
        print("ray_aabb_traversal.py --check: FAILED — recomputed traversal differs from the frozen file.", file=sys.stderr)
        for f, r in zip(frozen.get("cases", []), records):
            if f != r:
                print(f"  case {r['caseId']}: frozen={f} recomputed={r}", file=sys.stderr)
        return 1

    # Self-check: every voxel index is inside the declared domain, in cells.
    fixture = json.loads(FIXTURE.read_text())
    domain = fixture["domain"]
    h = fixture["voxelEdge"]
    n_cells = [int((F(domain["maxCorner"][a]) - F(domain["minCorner"][a])) / F(h)) for a in range(3)]
    problems = []
    for rec in records:
        for v in rec["voxels"]:
            for a in range(3):
                if not (0 <= v[a] < n_cells[a]):
                    problems.append(f"{rec['caseId']}: voxel {v} axis {a} outside [0, {n_cells[a]})")
    if problems:
        print(f"ray_aabb_traversal.py --check: FAILED — {len(problems)} out-of-domain voxel(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"ray_aabb_traversal.py --check: OK — {len(records)} case(s) match the frozen file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
