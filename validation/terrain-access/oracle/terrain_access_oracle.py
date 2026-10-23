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
                            traversabilityCost.ts documents. Width clearance
                            measures to blocked cell RECTANGLES and treats
                            outside the grid as unsupported; a diagonal may
                            not cut an unsupported cell's corner or sweep
                            the width over one (footprintClearance.ts).
                            Computed here by direct scan, where the viewer
                            runs a separable distance transform.
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
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"
EXPECTED = HERE.parent / "expected"

# Neighbour offsets, in the order ties are broken — matches
# TERRAIN_ACCESS_NEIGHBOURS in terrainAccessTypes.ts exactly.
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

NAN = float("nan")


def is_finite(v):
    return v is not None and not math.isnan(v) and not math.isinf(v)


# ── Horn slope/aspect, ported field-for-field from terrainDerivatives.ts ────

def _clamp_r(r, rows):
    if r < 0:
        return 0
    if r >= rows:
        return rows - 1
    return r


def _clamp_c(c, cols):
    if c < 0:
        return 0
    if c >= cols:
        return cols - 1
    return c


def _raw(z, cols, rows, r, c):
    return z[_clamp_r(r, rows) * cols + _clamp_c(c, cols)]


def _at(z, cols, rows, r, c, fallback):
    v = _raw(z, cols, rows, r, c)
    return v if is_finite(v) else fallback


def _virt(a, b, centre):
    if not is_finite(a):
        return centre
    return (2 * a - b) if is_finite(b) else a


def _fill_window_row_edge(z, cols, rows, row, col, e):
    """The window for a cell on the top/bottom border (row 0 or rows-1)."""
    w = [0.0] * 9
    inner = 1 if row == 0 else rows - 2
    outward = -1 if row == 0 else 1
    for dc in (-1, 0, 1):
        cc = _clamp_c(col + dc, cols)
        w[(outward + 1) * 3 + (dc + 1)] = _virt(_raw(z, cols, rows, row, cc), _raw(z, cols, rows, inner, cc), e)
        w[1 * 3 + (dc + 1)] = _at(z, cols, rows, row, cc, e)
        w[(1 - outward) * 3 + (dc + 1)] = _at(z, cols, rows, inner, cc, e)
    return w


def _fill_window_col_edge(z, cols, rows, row, col, e):
    """The window for a cell on the left/right border (col 0 or cols-1)."""
    w = [0.0] * 9
    inner = 1 if col == 0 else cols - 2
    outward = -1 if col == 0 else 1
    for dr in (-1, 0, 1):
        rr = _clamp_r(row + dr, rows)
        w[(dr + 1) * 3 + (outward + 1)] = _virt(_raw(z, cols, rows, rr, col), _raw(z, cols, rows, rr, inner), e)
        w[(dr + 1) * 3 + 1] = _at(z, cols, rows, rr, col, e)
        w[(dr + 1) * 3 + (1 - outward)] = _at(z, cols, rows, rr, inner, e)
    return w


def _fill_window_interior(z, cols, rows, row, col, e):
    w = [0.0] * 9
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            w[(dr + 1) * 3 + (dc + 1)] = _at(z, cols, rows, row + dr, col + dc, e)
    return w


def fill_window(z, cols, rows, row, col, e):
    if rows >= 2 and (row == 0 or row == rows - 1):
        return _fill_window_row_edge(z, cols, rows, row, col, e)
    if cols >= 2 and (col == 0 or col == cols - 1):
        return _fill_window_col_edge(z, cols, rows, row, col, e)
    return _fill_window_interior(z, cols, rows, row, col, e)


def _slope_aspect_at(z, cols, rows, mx, my, row, col):
    i = row * cols + col
    e = z[i]
    if not is_finite(e):
        return 0.0, 0.0
    w = fill_window(z, cols, rows, row, col, e)
    a, b, c, d, _e2, f, g, h, ii = w
    dzdx = (c + 2 * f + ii - (a + 2 * d + g)) / (8 * mx)
    dzdy = (g + 2 * h + ii - (a + 2 * b + c)) / (8 * my)
    slope = math.hypot(dzdx, dzdy)
    aspect = 0.0 if (dzdx == 0 and dzdy == 0) else math.atan2(-dzdy, -dzdx)
    return slope, aspect


def horn_slope_aspect(z, cols, rows, mx, my):
    """Return (slope, aspect) lists, length cols*rows.

    Border policy: linear extrapolation perpendicular to an edge, clamped
    along it (gdaldem -compute_edges), exactly as terrainDerivatives.ts
    documents. A non-finite neighbour degrades to the centre value.
    """
    n = cols * rows
    slope = [0.0] * n
    aspect = [0.0] * n
    for row in range(rows):
        for col in range(cols):
            i = row * cols + col
            slope[i], aspect[i] = _slope_aspect_at(z, cols, rows, mx, my, row, col)
    return slope, aspect


# ── Vector Ruggedness Measure (Sappington, Longshore & Thompson 2007) ───────

def _unit_normals(slope, aspect, valid, n):
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
    return nx, ny, nz, ok


def _vrm_at(nx, ny, nz, ok, cols, rows, row, col, half):
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
    return min(1.0, max(0.0, v))


def compute_vrm(slope, aspect, valid, cols, rows, window=3):
    n = cols * rows
    vrm = [NAN] * n
    half = (window - 1) // 2
    nx, ny, nz, ok = _unit_normals(slope, aspect, valid, n)
    for row in range(rows):
        for col in range(cols):
            i = row * cols + col
            if not ok[i]:
                continue
            vrm[i] = _vrm_at(nx, ny, nz, ok, cols, rows, row, col, half)
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
    if length <= 0:
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
    if limit <= 0 or not is_finite(value):
        return 0.0
    x = value / limit
    if x < 0:
        return 0.0
    if x > 1:
        return 1.0
    return x


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
    return blocked, reason


# Width clearance. A cell is the rectangle mx x my around its centre; the
# body is a disc of radius width/2. Unsupported area = every node-blocked
# cell's rectangle plus everything outside the grid. A cell is refused when
# its centre is STRICTLY closer than the radius to unsupported area (a body
# exactly as wide as a corridor touches both walls and fits). Squared
# distances are compared with a relative tolerance of 1e-12.
#
# Written as a direct scan over every blocked rectangle (O(n^2) on these
# small fixtures), where the viewer runs a separable distance transform.

TOUCH_TOLERANCE = 1e-12


def _intrudes(d2, r2):
    return d2 < r2 * (1 - TOUCH_TOLERANCE)


def _rect_gap(offset_cells, size):
    """Distance along one axis from a cell centre to a cell `offset_cells` away."""
    return max(abs(offset_cells) * size - size / 2, 0.0)


def _clearance_sq(blocked, cols, rows, mx, my, i):
    r, c = divmod(i, cols)
    best = min(
        ((c + 0.5) * mx) ** 2, ((cols - c - 0.5) * mx) ** 2,
        ((r + 0.5) * my) ** 2, ((rows - r - 0.5) * my) ** 2,
    )
    for j in range(cols * rows):
        if not blocked[j]:
            continue
        br, bc = divmod(j, cols)
        d2 = _rect_gap(bc - c, mx) ** 2 + _rect_gap(br - r, my) ** 2
        if d2 < best:
            best = d2
    return best


def dilate_blocked(blocked, cols, rows, mx, my, width):
    n = cols * rows
    radius_m = width / 2 if (not math.isnan(width) and width > 0) else 0
    if radius_m <= 0:
        return list(blocked)
    r2 = radius_m * radius_m
    return [blocked[i] or _intrudes(_clearance_sq(blocked, cols, rows, mx, my, i), r2) for i in range(n)]


# Diagonal moves. The centreline of a diagonal passes the corner shared by
# the two orthogonal cells bordering it, so the move is refused when either
# of those is node-blocked, at any width. For a positive width the swept
# disc must also stay off every blocked rectangle along the whole segment,
# not only at its ends: the exact segment-to-rectangle distance is the
# minimum of each segment end to the rectangle and each rectangle corner to
# the segment. Orthogonal moves need no extra check (along an axis-aligned
# centre-to-centre segment the distance to a grid-aligned rectangle, and to
# the survey edge, is smallest at an endpoint).

def _point_rect_sq(px, py, x0, x1, y0, y1):
    dx = x0 - px if px < x0 else (px - x1 if px > x1 else 0.0)
    dy = y0 - py if py < y0 else (py - y1 if py > y1 else 0.0)
    return dx * dx + dy * dy


def _point_segment_sq(px, py, ax, ay, bx, by):
    ex, ey = bx - ax, by - ay
    t = ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)
    t = min(1.0, max(0.0, t))
    dx, dy = px - (ax + t * ex), py - (ay + t * ey)
    return dx * dx + dy * dy


def _segment_rect_sq(ax, ay, bx, by, x0, x1, y0, y1):
    corners = ((x0, y0), (x0, y1), (x1, y0), (x1, y1))
    return min(
        _point_rect_sq(ax, ay, x0, x1, y0, y1),
        _point_rect_sq(bx, by, x0, x1, y0, y1),
        *(_point_segment_sq(px, py, ax, ay, bx, by) for px, py in corners),
    )


def diagonal_clear(support_blocked, cols, rows, mx, my, width, i, dx, dy):
    if dx == 0 or dy == 0:
        return True
    r, c = divmod(i, cols)
    if support_blocked[r * cols + c + dx] or support_blocked[(r + dy) * cols + c]:
        return False
    radius_m = width / 2 if (not math.isnan(width) and width > 0) else 0
    if radius_m <= 0:
        return True
    r2 = radius_m * radius_m
    ax, ay = c * mx, r * my
    bx, by = (c + dx) * mx, (r + dy) * my
    for j in range(cols * rows):
        if not support_blocked[j]:
            continue
        br, bc = divmod(j, cols)
        x0, x1 = (bc - 0.5) * mx, (bc + 0.5) * mx
        y0, y1 = (br - 0.5) * my, (br + 0.5) * my
        if _intrudes(_segment_rect_sq(ax, ay, bx, by, x0, x1, y0, y1), r2):
            return False
    return True


@dataclass
class Terrain:
    """Every per-cell array the edge cost / search need, grouped so
    `edge_cost`/`dijkstra` take one object instead of ten positional arrays."""
    z: list
    valid: list
    confidence: list
    vrm: list
    grad_e: list
    grad_n: list
    cols: int
    rows: int
    mx: float
    my: float
    support_blocked: list = None
    width: float = 0.0


def edge_geometry(terrain, a, b, dx, dy):
    # Per-edge grade: the steepest of the directional Horn grade at either
    # endpoint and the edge's own rise over run, so the figure is symmetric
    # under reversing the move and never below what the edge actually climbs.
    # Cross slope is the steeper of the two endpoints' perpendicular parts.
    h_e, h_n = heading_unit(dx, dy, terrain.mx, terrain.my)
    long_a, cross_a = directional_slope(terrain.grad_e[a], terrain.grad_n[a], h_e, h_n)
    long_b, cross_b = directional_slope(terrain.grad_e[b], terrain.grad_n[b], h_e, h_n)
    step = edge_step(terrain.z, terrain.valid, a, b)
    distance = math.hypot(dx * terrain.mx, dy * terrain.my)
    rise_run = step / distance if is_finite(step) and distance > 0 else 0.0
    longitudinal = max(long_a, long_b, rise_run)
    cross = max(cross_a, cross_b)
    return distance, longitudinal, cross, step


def evaluate_edge(terrain, profile, a, b, dx, dy):
    distance, longitudinal, cross, step = edge_geometry(terrain, a, b, dx, dy)
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


def edge_cost(terrain, profile, weights, a, b, dx, dy):
    ev = evaluate_edge(terrain, profile, a, b, dx, dy)
    if ev["blocked"]:
        return None
    max_rugged = profile.get("maxRuggedness")
    vrm = terrain.vrm
    ruggedness = utilization(max(vrm[a] or 0, vrm[b] or 0), max_rugged) if max_rugged is not None else 0.0
    confidence = terrain.confidence
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

def _relax_neighbours(terrain, blocked, profile, weights, i, dist, prev, closed, heap, counter):
    row, col = divmod(i, terrain.cols)
    for dx, dy in NEIGHBOURS:
        c = col + dx
        r = row + dy
        if c < 0 or c >= terrain.cols or r < 0 or r >= terrain.rows:
            continue
        j = r * terrain.cols + c
        if closed[j] or blocked[j]:
            continue
        if not diagonal_clear(terrain.support_blocked, terrain.cols, terrain.rows, terrain.mx, terrain.my,
                              terrain.width, i, dx, dy):
            continue
        cost = edge_cost(terrain, profile, weights, i, j, dx, dy)
        if cost is None:
            continue
        nd = dist[i] + cost
        if nd < dist[j]:
            dist[j] = nd
            prev[j] = i
            counter += 1
            heapq.heappush(heap, (nd, counter, j))
    return counter


def _reconstruct_path(prev, end):
    path = []
    at = end
    while at != -1:
        path.append(at)
        at = prev[at]
    path.reverse()
    return path


def dijkstra(terrain, blocked, profile, weights, start, end):
    n = terrain.cols * terrain.rows
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
        _dist, _order, i = heapq.heappop(heap)
        if closed[i]:
            continue
        closed[i] = True
        explored += 1
        if i == end:
            return "FOUND", _reconstruct_path(prev, end), dist[end], explored
        counter = _relax_neighbours(terrain, blocked, profile, weights, i, dist, prev, closed, heap, counter)

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


def _reason_counts_with_dilation(blocked, reason, dilated):
    """A cell the ORIGINAL pass left eligible but dilation newly excludes is
    not blocked for any of the declared node reasons — it is too close to
    one that is. Re-tag it 'vehicle-width', matching applyWidthClearance in
    traversabilityCost.ts, so the reason tally describes the same thing on
    both sides rather than the Python side silently keeping "None"."""
    for i in range(len(dilated)):
        if dilated[i] and not blocked[i]:
            reason[i] = "vehicle-width"
    return reason


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
    reason = _reason_counts_with_dilation(blocked, reason, dilated)
    support_blocked = blocked
    blocked = dilated

    terrain = Terrain(z, valid, confidence, vrm, grad_e, grad_n, cols, rows, mx, my,
                      support_blocked, float(profile["vehicleWidth"]))
    start = spec["start"][0] * cols + spec["start"][1]
    end = spec["end"][0] * cols + spec["end"][1]
    outcome, path_cells, cost, _explored = dijkstra(terrain, blocked, profile, weights, start, end)

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


def _run_one_fixture(path, write):
    """Compute one fixture and either write or compare it. Returns a list of
    problem strings (empty means the fixture matched, or was written)."""
    got = compute(path)
    out = EXPECTED / path.name
    if write:
        out.write_text(json.dumps(got, indent=2) + "\n")
        print(f"wrote {out.relative_to(HERE.parent.parent.parent)}")
        return []
    if not out.exists():
        return [f"{path.name}: no frozen expectation; run --write"]
    want = json.loads(out.read_text())
    problems = []
    for key in ("outcome", "path", "cost", "eligibleCount", "blockedReasonCounts"):
        if got[key] != want.get(key):
            problems.append(f"{path.name}: {key} differs from the frozen record (got {got[key]!r}, want {want.get(key)!r})")
    return problems


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
        problems.extend(_run_one_fixture(path, args.write))

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
