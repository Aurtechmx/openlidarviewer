#!/usr/bin/env python3
"""OB-GAIN-03/OB-GAIN-04 Coverage Gain terms and greedy selection, written
independently of the viewer (analytic-truth).

A second implementation of docs/observatory/SPEC.md §5.6, derived from that
prose and from docs/observatory/methods.md's `olv.observation.coverage-gain`
and `olv.observation.station-suggestion` sections rather than from
src/observation/coverageGain.ts:

  - Planning rays: one per (elevation bin, azimuth bin) of the declared
    angular step, pointing at the bin centre; elevations span the vertical
    field of view centred on the horizon.
  - Each ray is clipped to the domain over [minRange, maxRange] and walked
    voxel by voxel with ray_aabb_traversal.py's own slab clip and Amanatides
    & Woo traversal, in exact rational arithmetic (fractions.Fraction) over
    the float direction's exact value. SURFACE stops a ray; PARTIAL stops it
    when hit / (hit + pass) >= p_solid. A stopping voxel is itself visible.
  - inc(v) is the largest |cos i| over the rays reaching v when v declares a
    normal, otherwise 1.
  - G(c) = sum over visible v of w(state(v)) * inc(v) - lambda_red * redundant,
    where redundant counts visible strong SURFACE voxels (sources >= floor and
    hit fraction >= floor) and voxels an earlier pick already reaches; those
    carry no weight. NOT_READ voxels carry weight 0 and are counted apart.
  - Greedy: pick the highest gain (ties to the lower index), add its visible
    voxels to the covered set, re-score the rest, repeat for the declared
    station count; stop early when no gain is positive.

Reads validation/observatory/fixtures/f11-coverage-gain.json (written by
scripts/generate-observatory-fixtures.mjs). tests/observatoryFixturesO10.test.ts
replays the same fixture through the TypeScript scorer and compares every
term with the frozen results this script writes.

WHAT THIS IS AND IS NOT. Agreement catches a transcription slip in either
implementation. It is not external validation: both follow this project's
own SPEC, so a shared misreading would survive agreement.

Standard library only (fractions, math, json, argparse, pathlib).

Usage:
  coverage_gain.py --write   regenerate the frozen expectations
  coverage_gain.py --check   recompute and compare against them
"""
import argparse
import json
import math
import sys
from fractions import Fraction as F
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from ray_aabb_traversal import clip_ray_to_aabb, traverse  # noqa: E402

FIXTURE = HERE.parent / "fixtures" / "f11-coverage-gain.json"
EXPECTED = HERE.parent / "expected" / "f11-coverage-gain.expected.json"


def grid_shape(domain, h):
    return [math.ceil((domain["maxCorner"][a] - domain["minCorner"][a]) / h) for a in range(3)]


def matching_region(centre, regions):
    """The first region whose half-open box holds the voxel centre, or None."""
    for region in regions:
        lo, hi = region["minCorner"], region["maxCorner"]
        if all(F(lo[a]) <= centre[a] < F(hi[a]) for a in range(3)):
            return region
    return None


def expand_field(fixture):
    """Every voxel's state, rows and normal, by voxel-centre membership in the first matching region."""
    domain = fixture["domain"]
    h = fixture["voxelEdge"]
    nx, ny, nz = grid_shape(domain, h)
    states, rows, normals = {}, {}, {}
    for iz in range(nz):
        for iy in range(ny):
            for ix in range(nx):
                c = [F(domain["minCorner"][a]) + (F(i) + F(1, 2)) * F(h) for a, i in enumerate((ix, iy, iz))]
                key = ix + nx * (iy + ny * iz)
                region = matching_region(c, fixture["regions"])
                if region is None:
                    states[key] = fixture["defaultState"]
                    continue
                states[key] = region["state"]
                if "rows" in region:
                    rows[key] = region["rows"]
                if "normal" in region:
                    normals[key] = region["normal"]
    return (nx, ny, nz), states, rows, normals


def directions(model):
    step = model["angularStepDegrees"]
    half = min(90, model["verticalFieldOfViewDegrees"] / 2)
    lo = -half
    az_bins = max(1, math.floor(360 / step))
    el_bins = max(1, math.floor((2 * half) / step))
    rad = math.pi / 180
    out = []
    for j in range(el_bins):
        el = (lo + (j + 0.5) * step) * rad
        ce, se = math.cos(el), math.sin(el)
        for i in range(az_bins):
            az = (i + 0.5) * step * rad
            out.append((ce * math.cos(az), ce * math.sin(az), se))
    return out


def blocks(state, row, p_solid):
    if state == "SURFACE":
        return True
    if state != "PARTIAL" or row is None:
        return False
    n = row["hit"] + row["pass"]
    return n > 0 and F(row["hit"], n) >= F(p_solid)


def incidence(direction, normal):
    if normal is None:
        return F(1)
    return min(F(1), abs(sum(direction[a] * F(normal[a]) for a in range(3))))


def walk_ray(origin, direction, clip, h, shape, field, best):
    """Record every voxel this ray reaches, stopping at the first blocking one."""
    nx, ny, nz = shape
    states, rows, normals, p_solid = field
    for ix, iy, iz in traverse(origin, direction, clip[0], clip[1], h):
        if not (0 <= ix < nx and 0 <= iy < ny and 0 <= iz < nz):
            continue
        key = ix + nx * (iy + ny * iz)
        inc = incidence(direction, normals.get(key))
        if key not in best or inc > best[key]:
            best[key] = inc
        if blocks(states[key], rows.get(key), p_solid):
            return


def visibility(fixture, shape, states, rows, normals, position, dirs):
    domain = fixture["domain"]
    h = F(fixture["voxelEdge"])
    model = fixture["instrumentModel"]
    field = (states, rows, normals, fixture["parameters"]["p_solid"])
    dmin = [F(v) for v in domain["minCorner"]]
    # Domain-relative coordinates: traverse() floors against 0.
    origin = [F(position[a]) - dmin[a] for a in range(3)]
    lo = [F(0)] * 3
    hi = [F(domain["maxCorner"][a]) - dmin[a] for a in range(3)]
    best = {}
    for d in dirs:
        direction = [F(x) for x in d]
        clip = clip_ray_to_aabb(origin, direction, F(model["minRange"]), F(model["maxRange"]), lo, hi)
        if clip is None or clip[1] <= clip[0]:
            continue
        walk_ray(origin, direction, clip, h, shape, field, best)
    return best


def is_weak(row, floors):
    if row is None:
        return True
    if row["sources"] < floors["sources"]:
        return True
    n = row["hit"] + row["pass"]
    return not (n > 0 and F(row["hit"], n) >= F(floors["consistency"]))


def score(candidate_index, visible, states, rows, params, covered):
    weights = {k: F(v) for k, v in params["stateWeights"].items()}
    floors = params["weakSurfaceFloors"]
    tally = {"SHADOWED": 0, "UNADDRESSED": 0, "NO_RETURN_PATH": 0, "CONFLICT": 0, "WEAK_SURFACE": 0}
    total = F(0)
    redundant = 0
    excluded = 0
    for key in sorted(visible):
        state = states[key]
        if state == "NOT_READ":
            excluded += 1
            continue
        category = None
        strong = False
        if state in ("SHADOWED", "UNADDRESSED", "NO_RETURN_PATH", "CONFLICT"):
            category = state
        elif state == "SURFACE":
            if is_weak(rows.get(key), floors):
                category = "WEAK_SURFACE"
            else:
                strong = True
        if key in covered or strong:
            redundant += 1
            continue
        if category is None:
            continue
        tally[category] += 1
        total += weights[category] * visible[key]
    penalty = F(params["redundancyWeight"]) * redundant
    return {
        "candidateIndex": candidate_index,
        "visibleVoxelCount": len(visible),
        "weightedVisibilitySum": total,
        "weightedCounts": tally,
        "redundantCount": redundant,
        "redundantPenalty": penalty,
        "gain": total - penalty,
        "excludedVoxelCount": excluded,
    }


def as_json_terms(t):
    out = dict(t)
    for k in ("weightedVisibilitySum", "redundantPenalty", "gain"):
        out[k] = float(t[k])
        out[k + "Exact"] = str(t[k])
    return out


def greedy_select(vis, states, rows, params, station_count):
    """Greedy picks in order, and why selection stopped."""
    if not isinstance(station_count, int) or station_count < 0:
        raise SystemExit(f"stationCount must be a non-negative integer, got {station_count!r}")
    covered, picked, selections = set(), set(), []
    stop = "declared-count-reached" if vis else "no-candidates"
    # A pick is never repeated: one round past the candidate count only reports "no-candidates".
    rounds = min(station_count, len(vis) + 1) if vis else 0
    while len(selections) < rounds:
        best = None
        for i in sorted(vis):
            if i in picked:
                continue
            t = score(i, vis[i], states, rows, params, covered)
            if best is None or t["gain"] > best["gain"]:
                best = t
        if best is None:
            stop = "no-candidates"
            break
        if best["gain"] <= 0:
            stop = "no-positive-gain"
            break
        picked.add(best["candidateIndex"])
        selections.append(best)
        covered |= set(vis[best["candidateIndex"]].keys())
    return selections, stop


def compute_all():
    fixture = json.loads(FIXTURE.read_text())
    shape, states, rows, normals = expand_field(fixture)
    dirs = directions(fixture["instrumentModel"])
    params = fixture["parameters"]
    vis = {c["candidateIndex"]: visibility(fixture, shape, states, rows, normals, c["position"], dirs) for c in fixture["candidates"]}
    round1 = [score(i, vis[i], states, rows, params, set()) for i in sorted(vis)]

    selections, stop = greedy_select(vis, states, rows, params, fixture["stationCount"])

    state_counts = {}
    for s in states.values():
        state_counts[s] = state_counts.get(s, 0) + 1
    return {
        "schemaVersion": 1,
        "planningRayCount": len(dirs),
        "grid": list(shape),
        "stateCounts": dict(sorted(state_counts.items())),
        "candidateTerms": [as_json_terms(t) for t in round1],
        "selectedCandidateIndices": [t["candidateIndex"] for t in selections],
        "termsAtSelection": [as_json_terms(t) for t in selections],
        "stopReason": stop,
    }


def write_frozen(payload):
    target = EXPECTED.resolve()
    if not target.is_relative_to(HERE.parent.resolve()):
        raise SystemExit(f"refusing to write outside {HERE.parent}: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if not FIXTURE.exists():
        print(f"coverage_gain.py: FAILED — fixture missing: {FIXTURE}", file=sys.stderr)
        return 1
    result = compute_all()

    if args.write:
        write_frozen(result)
        print(f"coverage_gain.py --write: wrote {len(result['candidateTerms'])} candidate(s), selection {result['selectedCandidateIndices']}")
        return 0

    if not EXPECTED.exists():
        print("coverage_gain.py --check: FAILED — no frozen expectations. Run --write first.", file=sys.stderr)
        return 1
    frozen = json.loads(EXPECTED.read_text())
    if frozen != json.loads(json.dumps(result)):
        print("coverage_gain.py --check: FAILED — recomputed terms differ from the frozen file.", file=sys.stderr)
        return 1
    print(f"coverage_gain.py --check: OK — {len(result['candidateTerms'])} candidate(s), selection {result['selectedCandidateIndices']} match the frozen file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
