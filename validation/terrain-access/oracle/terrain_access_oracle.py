#!/usr/bin/env python3
"""Terrain Access hard eligibility, cost and least-cost routing, written
independently of the viewer.

This is a second implementation of the method definitions in the governing
prompt (OLV_v0.7_Three_Real_World_Simulations_Implementation_Prompt.md, §12),
in another language, and by a different search algorithm:

  Horn slope/aspect       - Horn (1981), the same 3x3 weighted finite-difference
                            stencil the viewer's terrainDerivatives.ts uses,
                            including its border-extrapolation policy, ported
                            field for field from that module's documented
                            algorithm rather than from its TypeScript.
  Vector Ruggedness       - Sappington, Longshore & Thompson (2007): dispersion
                            Measure (VRM)         of per-cell unit normals over a moving window.
  Local step              - maximum absolute elevation discontinuity between a
                            cell and its valid neighbours in a 3x3 footprint.
  Directional grade       - the elevation gradient decomposed along a physical
                            heading (longitudinal) and perpendicular to it
                            (cross slope).
  Hard eligibility        - node-level (NoData, ROI, support, ruggedness,
                            obstruction, width clearance) and edge-level
                            (longitudinal grade, cross slope, step height)
                            blocking, kept separate exactly as the viewer's
                            traversabilityCost.ts documents.
  Least-cost routing      - Dijkstra (no heuristic), where the viewer runs A*
                            with a planimetric-distance heuristic. Different
                            algorithms for the same declared cost graph: if
                            they agree on total cost and on every hard-block
                            decision, a bug in one search's bookkeeping is
                            unlikely to reproduce in the other.

WHAT THIS IS AND IS NOT. Agreement between these two implementations catches
transcription slips, a sign error in the aspect/gradient convention, and a
mistake in scaling the two horizontal axes to metres. It is not external
validation: both were written for this project, and a shared misreading of
the method would survive. The fixtures are deliberately small and built with
a comment explaining what each one pins, so their expected fields can also be
checked by hand.

Nothing here imports OpenLiDARViewer code, and nothing here reads its output.
Standard library only, so the check has no dependency to install or pin.

Usage:
  terrain_access_oracle.py --write   regenerate the frozen expectations
  terrain_access_oracle.py --check   recompute and compare against them
"""
import argparse
import heapq
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"
EXPECTED = HERE.parent / "expected"

# Neighbour offsets, in the order ties are broken — matches
# TERRAIN_ACCESS_NEIGHBOURS in terrainAccessTypes.ts exactly.
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

NAN = float("nan")


def is_finite(v):
    return v is not None and not math.isnan(v) and not math.isinf(v)


# ── Horn slope/aspect, ported field-for-field from terrainDerivatives.ts ────

def horn_slope_aspect(z, cols, rows, mx, my):
    """Return (slope, aspect) lists, length cols*rows.

    Border policy: linear extrapolation perpendicular to an edge, clamped
    along it (gdaldem -compute_edges), exactly as terrainDerivatives.ts
    documents. A non-finite neighbour degrades to the centre value.
    """
    n = cols * rows
    slope = [0.0] * n
    aspect = [0.0] * n

    def clamp_r(r):
        return 0 if r < 0 else (rows - 1 if r >= rows else r)

    def clamp_c(c):
        return 0 if c < 0 else (cols - 1 if c >= cols else c)

    def raw(r, c):
        return z[clamp_r(r) * cols + clamp_c(c)]

    def at(r, c, fallback):
        v = raw(r, c)
        return v if is_finite(v) else fallback

    def virt(a, b, centre):
        if not is_finite(a):
            return centre
        return (2 * a - b) if is_finite(b) else a

    def fill_window(row, col, e):
        w = [0.0] * 9
        if rows >= 2 and (row == 0 or row == rows - 1):
            inner = 1 if row == 0 else rows - 2
            outward = -1 if row == 0 else 1
            for dc in (-1, 0, 1):
                cc = clamp_c(col + dc)
                w[(outward + 1) * 3 + (dc + 1)] = virt(raw(row, cc), raw(inner, cc), e)
                w[1 * 3 + (dc + 1)] = at(row, cc, e)
                w[(1 - outward) * 3 + (dc + 1)] = at(inner, cc, e)
            return w
        if cols >= 2 and (col == 0 or col == cols - 1):
            inner = 1 if col == 0 else cols - 2
            outward = -1 if col == 0 else 1
            for dr in (-1, 0, 1):
                rr = clamp_r(row + dr)
                w[(dr + 1) * 3 + (outward + 1)] = virt(raw(rr, col), raw(rr, inner), e)
                w[(dr + 1) * 3 + 1] = at(rr, col, e)
                w[(dr + 1) * 3 + (1 - outward)] = at(rr, inner, e)
            return w
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                w[(dr + 1) * 3 + (dc + 1)] = at(row + dr, col + dc, e)
        return w

    for row in range(rows):
        for col in range(cols):
            i = row * cols + col
            e = z[i]
            if not is_finite(e):
                slope[i] = 0.0
                aspect[i] = 0.0
                continue
            w = fill_window(row, col, e)
            a, b, c, d, _e2, f, g, h, ii = w
            dzdx = (c + 2 * f + ii - (a + 2 * d + g)) / (8 * mx)
            dzdy = (g + 2 * h + ii - (a + 2 * b + c)) / (8 * my)
            slope[i] = math.hypot(dzdx, dzdy)
            aspect[i] = 0.0 if (dzdx == 0 and dzdy == 0) else math.atan2(-dzdy, -dzdx)

    return slope, aspect


# ── Vector Ruggedness Measure (Sappington, Longshore & Thompson 2007) ───────

def compute_vrm(slope, aspect, valid, cols, rows, window=3):
    n = cols * rows
    vrm = [NAN] * n
    half = (window - 1) // 2

    nx = [0.0] * n
    ny = [0.0] * n
    nz = [0.0] * n
    ok = [False] * n
    for i in range(n):
        if valid[i] == 0 or not is_finite(slope[i]) or not is_finite(aspect[i]):
            continue
        m = slope[i]
        a = aspect[i]
        inv = 1.0 / math.sqrt(1 + m * m)
        sin_t = m * inv
        nx[i] = sin_t * math.cos(a)
        ny[i] = sin_t * math.sin(a)
        nz[i] = inv
        ok[i] = True

    for row in range(rows):
        for col in range(cols):
            i = row * cols + col
            if not ok[i]:
                continue
            sx = sy = sz = 0.0
            count = 0
            for r in range(max(0, row - half), min(rows - 1, row + half) + 1):
                for c in range(max(0, col - half), min(cols - 1, col + half) + 1):
                    j = r * cols + c
                    if not ok[j]:
                        continue
                    sx += nx[j]
                    sy += ny[j]
                    sz += nz[j]
                    count += 1
            resultant = math.sqrt(sx * sx + sy * sy + sz * sz)
            v = 1 - resultant / count
            vrm[i] = min(1.0, max(0.0, v))
    return vrm


# ── local step (§12.4) ───────────────────────────────────────────────────────

def edge_step(z, valid, a, b):
    if valid[a] == 0 or valid[b] == 0:
        return NAN
    return abs(z[a] - z[b])


# ── directional grade (§12.5) ───────────────────────────────────────────────

def gradient_at(m, a):
    if not is_finite(m) or not is_finite(a):
        return 0.0, 0.0
    return -m * math.cos(a), -m * math.sin(a)


def heading_unit(dx, dy, mx, my):
    east = dx * mx
    north = dy * my
    length = math.hypot(east, north)
    if not (length > 0):
        return 0.0, 0.0
    return east / length, north / length


def directional_slope(grad_e, grad_n, h_e, h_n):
    longitudinal = grad_e * h_e + grad_n * h_n
    perp_e, perp_n = -h_n, h_e
    cross = grad_e * perp_e + grad_n * perp_n
    return abs(longitudinal), abs(cross)


# ── above-ground obstruction evidence (§12.4) ───────────────────────────────

def classify_obstruction(valid, height_above_ground, threshold, n):
    """'obstructed' / 'clear' / 'not-evaluated', matching obstacleEvidence.ts:
    no threshold or no DSM layer at all means nothing was evaluated, distinct
    from a cell that was checked and found clear."""
    out = ["not-evaluated"] * n
    if threshold is None or height_above_ground is None:
        return out
    for i in range(n):
        if valid[i] == 0:
            continue
        h = height_above_ground[i]
        if not is_finite(h):
            continue
        out[i] = "obstructed" if h > threshold else "clear"
    return out


# ── hard eligibility + cost (§12.6, §12.7) ──────────────────────────────────

DEFAULT_WEIGHTS = {"longitudinal": 1.0, "cross": 1.0, "ruggedness": 0.5, "step": 1.0, "support": 1.0}


def utilization(value, limit):
    if not (limit > 0) or not is_finite(value):
        return 0.0
    x = value / limit
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def node_eligibility(valid, confidence, allowed, vrm, obstruction, cols, rows, profile):
    n = cols * rows
    blocked = [False] * n
    reason = [None] * n
    for i in range(n):
        if valid[i] == 0:
            blocked[i] = True
            reason[i] = "no-data"
            continue
        if allowed is not None and allowed[i] == 0:
            blocked[i] = True
            reason[i] = "outside-roi"
            continue
        if confidence[i] < profile["minimumTerrainConfidence"] and profile["unknownPolicy"] == "block":
            blocked[i] = True
            reason[i] = "low-confidence"
            continue
        max_rugged = profile.get("maxRuggedness")
        if max_rugged is not None and is_finite(vrm[i]) and vrm[i] > max_rugged:
            blocked[i] = True
            reason[i] = "ruggedness"
            continue
        if obstruction is not None and obstruction[i] == "obstructed":
            blocked[i] = True
            reason[i] = "obstruction"
            continue
    return blocked, reason


def dilate_blocked(blocked, cols, rows, mx, my, width):
    n = cols * rows
    out = [False] * n
    radius_m = width / 2 if (width == width and width > 0) else 0  # NaN-safe
    if radius_m <= 0:
        return list(blocked)
    rcx = math.ceil(radius_m / mx) if mx > 0 else 0
    rcy = math.ceil(radius_m / my) if my > 0 else 0
    seeds = [i for i in range(n) if blocked[i]]
    for seed in seeds:
        out[seed] = True
        sr, sc = divmod(seed, cols)
        for dr in range(-rcy, rcy + 1):
            r = sr + dr
            if r < 0 or r >= rows:
                continue
            for dc in range(-rcx, rcx + 1):
                c = sc + dc
                if c < 0 or c >= cols:
                    continue
                j = r * cols + c
                if out[j]:
                    continue
                if math.hypot(dc * mx, dr * my) <= radius_m:
                    out[j] = True
    return out


def edge_geometry(z, valid, grad_e, grad_n, cols, mx, my, a, b, dx, dy):
    h_e, h_n = heading_unit(dx, dy, mx, my)
    longitudinal, cross = directional_slope(grad_e[a], grad_n[a], h_e, h_n)
    step = edge_step(z, valid, a, b)
    distance = math.hypot(dx * mx, dy * my)
    return distance, longitudinal, cross, step


def evaluate_edge(z, valid, grad_e, grad_n, cols, mx, my, profile, a, b, dx, dy):
    distance, longitudinal, cross, step = edge_geometry(z, valid, grad_e, grad_n, cols, mx, my, a, b, dx, dy)
    reason = None
    if is_finite(step) and step > profile["maxStepHeight"]:
        reason = "step-height"
    elif longitudinal > profile["maxLongitudinalGrade"]:
        reason = "longitudinal-grade"
    elif cross > profile["maxCrossSlope"]:
        reason = "cross-slope"
    return {
        "blocked": reason is not None, "reason": reason,
        "distanceM": distance, "longitudinalGrade": longitudinal, "crossSlope": cross, "stepM": step,
    }


def edge_cost(z, valid, confidence, vrm, grad_e, grad_n, cols, mx, my, profile, a, b, dx, dy, weights):
    ev = evaluate_edge(z, valid, grad_e, grad_n, cols, mx, my, profile, a, b, dx, dy)
    if ev["blocked"]:
        return None
    max_rugged = profile.get("maxRuggedness")
    ruggedness = utilization(max(vrm[a] or 0, vrm[b] or 0), max_rugged) if max_rugged is not None else 0.0
    confidence01 = min(confidence[a], confidence[b]) / 100.0
    multiplier = (
        1
        + weights["longitudinal"] * utilization(ev["longitudinalGrade"], profile["maxLongitudinalGrade"])
        + weights["cross"] * utilization(ev["crossSlope"], profile["maxCrossSlope"])
        + weights["ruggedness"] * ruggedness
        + weights["step"] * utilization(ev["stepM"], profile["maxStepHeight"])
        + weights["support"] * (1 - confidence01)
    )
    return ev["distanceM"] * multiplier


# ── Dijkstra (the viewer runs A*) ────────────────────────────────────────────

def dijkstra(z, valid, confidence, vrm, grad_e, grad_n, blocked, cols, rows, mx, my, profile, start, end, weights):
    n = cols * rows
    if not (0 <= start < n) or blocked[start]:
        return "START_BLOCKED", [], None, 0
    if not (0 <= end < n) or blocked[end]:
        return "END_BLOCKED", [], None, 0
    if start == end:
        return "FOUND", [start], 0.0, 0

    dist = [math.inf] * n
    prev = [-1] * n
    dist[start] = 0.0
    # (distance, insertion order, index) — insertion order breaks a tie
    # deterministically without depending on Python's heap internals beyond
    # documented total ordering.
    counter = 0
    heap = [(0.0, counter, start)]
    closed = [False] * n
    explored = 0

    while heap:
        d, _, i = heapq.heappop(heap)
        if closed[i]:
            continue
        closed[i] = True
        explored += 1
        if i == end:
            path = []
            at = end
            while at != -1:
                path.append(at)
                at = prev[at]
            path.reverse()
            return "FOUND", path, dist[end], explored

        row, col = divmod(i, cols)
        for dx, dy in NEIGHBOURS:
            c = col + dx
            r = row + dy
            if c < 0 or c >= cols or r < 0 or r >= rows:
                continue
            j = r * cols + c
            if closed[j] or blocked[j]:
                continue
            cost = edge_cost(z, valid, confidence, vrm, grad_e, grad_n, cols, mx, my, profile, i, j, dx, dy, weights)
            if cost is None:
                continue
            nd = dist[i] + cost
            if nd < dist[j]:
                dist[j] = nd
                prev[j] = i
                counter += 1
                heapq.heappush(heap, (nd, counter, j))

    return "NO_ROUTE", [], None, explored


# ── fixture plumbing ─────────────────────────────────────────────────────────

def load_fixture(path):
    spec = json.loads(path.read_text())
    rows_in = spec["z"]
    rows = len(rows_in)
    cols = len(rows_in[0])
    z = [0.0] * (cols * rows)
    valid = [0] * (cols * rows)
    for r, row in enumerate(rows_in):
        for c, v in enumerate(row):
            i = r * cols + c
            if v is None:
                z[i] = NAN
                valid[i] = 0
            else:
                z[i] = float(v)
                valid[i] = 1
    confidence = spec.get("confidence")
    if confidence is not None:
        flat_conf = [float(v) for row in confidence for v in row]
    else:
        flat_conf = [100.0] * (cols * rows)
    allowed = spec.get("allowed")
    flat_allowed = [int(v) for row in allowed for v in row] if allowed is not None else None
    hag = spec.get("heightAboveGround")
    flat_hag = [float(v) for row in hag for v in row] if hag is not None else None
    return spec, z, valid, flat_conf, flat_allowed, flat_hag, cols, rows


def compute(path):
    spec, z, valid, confidence, allowed, height_above_ground, cols, rows = load_fixture(path)
    mx = float(spec.get("cellMetresX", 1))
    my = float(spec.get("cellMetresY", 1))
    profile = spec["profile"]
    weights = spec.get("weights", DEFAULT_WEIGHTS)

    slope, aspect = horn_slope_aspect(z, cols, rows, mx, my)
    vrm = compute_vrm(slope, aspect, valid, cols, rows)
    grad_e = [0.0] * (cols * rows)
    grad_n = [0.0] * (cols * rows)
    for i in range(cols * rows):
        grad_e[i], grad_n[i] = gradient_at(slope[i], aspect[i])

    obstruction = classify_obstruction(valid, height_above_ground, profile.get("obstacleHeightThreshold"), cols * rows)
    blocked, reason = node_eligibility(valid, confidence, allowed, vrm, obstruction, cols, rows, profile)
    dilated = dilate_blocked(blocked, cols, rows, mx, my, profile["vehicleWidth"])
    # A cell the ORIGINAL pass left eligible but dilation newly excludes is
    # not blocked for any of the declared node reasons — it is too close to
    # one that is. Re-tag it 'vehicle-width', matching applyWidthClearance in
    # traversabilityCost.ts, so the reason tally describes the same thing on
    # both sides rather than the Python side silently keeping "None".
    for i in range(len(dilated)):
        if dilated[i] and not blocked[i]:
            reason[i] = "vehicle-width"
    blocked = dilated

    start = spec["start"][0] * cols + spec["start"][1]
    end = spec["end"][0] * cols + spec["end"][1]
    outcome, path_cells, cost, explored = dijkstra(
        z, valid, confidence, vrm, grad_e, grad_n, blocked, cols, rows, mx, my, profile, start, end, weights,
    )

    eligible_count = sum(1 for b in blocked if not b)

    return {
        "fixture": path.name,
        "cols": cols, "rows": rows,
        "outcome": outcome,
        "path": path_cells,
        "cost": None if cost is None else round(cost, 9),
        "eligibleCount": eligible_count,
        "blockedReasonCounts": _tally(reason),
    }


def _tally(reasons):
    out = {}
    for r in reasons:
        if r is None:
            continue
        out[r] = out.get(r, 0) + 1
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="regenerate expectations")
    ap.add_argument("--check", action="store_true", help="compare against expectations")
    args = ap.parse_args()
    if args.write == args.check:
        ap.error("pass exactly one of --write or --check")

    fixtures = sorted(FIXTURES.glob("*.json"))
    if not fixtures:
        print(f"terrain_access_oracle: no fixtures under {FIXTURES}", file=sys.stderr)
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
        for key in ("outcome", "path", "cost", "eligibleCount", "blockedReasonCounts"):
            if got[key] != want.get(key):
                problems.append(f"{path.name}: {key} differs from the frozen record (got {got[key]!r}, want {want.get(key)!r})")

    if problems:
        print("terrain_access_oracle FAILED", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    if args.check:
        print(f"terrain_access_oracle OK - {len(fixtures)} fixture(s) match the frozen record")
    return 0


if __name__ == "__main__":
    sys.exit(main())
