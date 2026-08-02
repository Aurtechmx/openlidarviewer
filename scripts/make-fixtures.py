#!/usr/bin/env python3
"""Generate deterministic test fixtures for OpenLiDARViewer core-IO tests.

Emits into tests/fixtures/:
  - tiny.las / tiny.laz            : same ~12-point georeferenced cloud (UTM-like coords)
  - tiny.ply                       : ~10-point local cloud with per-vertex RGB
  - tiny.obj                       : ~8-vertex local mesh
  - tiny.glb                       : ~8-vertex local mesh
  - gate2-origin-a.las/-b.las      : 10-point Z-up tiles, different origins,
                                      overlapping world Z — Gate 2 Stage B fixture
  - gate2-axis-zup-survey.las      : 10-point Z-up survey — Gate 2 Stage B fixture
  - gate2-axis-yup-scan.ply        : 10-point Y-up scan, overlapping world
                                      elevation with the survey above
  - FIXTURES.md                    : ground-truth values the tests assert against

Run: python3 scripts/make-fixtures.py
(Regenerating tiny.las/tiny.laz also rewrites one LAS-header creation-date byte
that is not point data and carries no test assertion — an existing quirk of
laspy embedding today's date on write, predating this script's Gate 2
extension. `git checkout -- tests/fixtures/tiny.las tests/fixtures/tiny.laz`
after a run if you want to keep those two byte-for-byte unless you actually
mean to touch them.)
"""

from pathlib import Path

import numpy as np
import laspy
import trimesh

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)

# --- LAS / LAZ georeferenced cloud -----------------------------------------
SCALE = (0.001, 0.001, 0.001)
OFFSET = (500000.0, 4100000.0, 200.0)

# 12 points in true (georeferenced) UTM-like coordinates.
# First point deliberately near X=500123.456, Y=4100876.789, Z=210.25.
LAS_XYZ = np.array(
    [
        [500123.456, 4100876.789, 210.250],
        [500124.100, 4100877.000, 210.500],
        [500125.250, 4100878.500, 211.000],
        [500126.000, 4100879.250, 211.750],
        [500127.500, 4100880.000, 212.000],
        [500128.750, 4100881.125, 212.500],
        [500129.000, 4100882.000, 213.000],
        [500130.250, 4100883.500, 213.250],
        [500131.500, 4100884.750, 213.750],
        [500132.000, 4100885.000, 214.000],
        [500133.750, 4100886.250, 214.500],
        [500134.500, 4100887.500, 215.000],
    ],
    dtype=np.float64,
)
LAS_INTENSITY = np.array(
    [10, 25, 40, 55, 70, 85, 100, 130, 160, 200, 240, 300], dtype=np.uint16
)
LAS_CLASS = np.array([2, 2, 2, 3, 3, 5, 5, 6, 6, 1, 1, 2], dtype=np.uint8)


def build_las(point_format: int) -> laspy.LasData:
    header = laspy.LasHeader(point_format=point_format, version="1.4")
    header.scales = np.array(SCALE, dtype=np.float64)
    header.offsets = np.array(OFFSET, dtype=np.float64)
    las = laspy.LasData(header)
    las.x = LAS_XYZ[:, 0]
    las.y = LAS_XYZ[:, 1]
    las.z = LAS_XYZ[:, 2]
    las.intensity = LAS_INTENSITY
    las.classification = LAS_CLASS
    return las


def write_las_files() -> dict:
    # Point format 6 -> LAS 1.4 (uint64 point count present).
    las = build_las(point_format=6)
    las_path = FIXTURES / "tiny.las"
    laz_path = FIXTURES / "tiny.laz"
    las.write(str(las_path))
    las.write(str(laz_path), laz_backend=laspy.LazBackend.Lazrs)

    # Re-read to capture the values exactly as stored (quantized by scale).
    r = laspy.read(str(las_path))
    xyz = np.column_stack([r.x, r.y, r.z])
    return {
        "count": int(r.header.point_count),
        "first": xyz[0].tolist(),
        "min": xyz.min(axis=0).tolist(),
        "max": xyz.max(axis=0).tolist(),
        "scale": list(SCALE),
        "offset": list(OFFSET),
        "version_minor": r.header.version.minor,
    }


# --- PLY local cloud with RGB ----------------------------------------------
PLY_XYZ = np.array(
    [
        [0.0, 0.0, 0.0],
        [1.0, 0.5, 0.25],
        [2.0, 1.0, 0.50],
        [3.0, 1.5, 0.75],
        [4.0, 2.0, 1.00],
        [5.0, 2.5, 1.25],
        [6.0, 3.0, 1.50],
        [7.0, 3.5, 1.75],
        [8.0, 4.0, 2.00],
        [9.0, 4.5, 2.25],
    ],
    dtype=np.float64,
)
PLY_RGB = np.array(
    [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
        [128, 128, 128],
        [255, 128, 0],
        [64, 200, 16],
        [10, 20, 30],
    ],
    dtype=np.uint8,
)


def write_ply() -> dict:
    ply_path = FIXTURES / "tiny.ply"
    cloud = trimesh.PointCloud(vertices=PLY_XYZ, colors=PLY_RGB)
    cloud.export(str(ply_path), file_type="ply", encoding="ascii")
    return {
        "count": int(PLY_XYZ.shape[0]),
        "first": PLY_XYZ[0].tolist(),
        "min": PLY_XYZ.min(axis=0).tolist(),
        "max": PLY_XYZ.max(axis=0).tolist(),
    }


# --- OBJ / GLB local meshes ------------------------------------------------
MESH_VERTS = np.array(
    [
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [2.0, 2.0, 0.0],
        [0.0, 2.0, 0.0],
        [0.0, 0.0, 2.0],
        [2.0, 0.0, 2.0],
        [2.0, 2.0, 2.0],
        [0.0, 2.0, 2.0],
    ],
    dtype=np.float64,
)
MESH_FACES = np.array(
    [
        [0, 1, 2], [0, 2, 3],  # bottom
        [4, 6, 5], [4, 7, 6],  # top
        [0, 4, 5], [0, 5, 1],  # sides
        [1, 5, 6], [1, 6, 2],
        [2, 6, 7], [2, 7, 3],
        [3, 7, 4], [3, 4, 0],
    ],
    dtype=np.int64,
)


def write_meshes() -> dict:
    mesh = trimesh.Trimesh(vertices=MESH_VERTS, faces=MESH_FACES, process=False)
    obj_path = FIXTURES / "tiny.obj"
    glb_path = FIXTURES / "tiny.glb"
    obj_path.write_text(trimesh.exchange.obj.export_obj(mesh))
    glb_data = trimesh.exchange.gltf.export_glb(mesh)
    glb_path.write_bytes(glb_data)
    return {
        "count": int(MESH_VERTS.shape[0]),
        "first": MESH_VERTS[0].tolist(),
        "min": MESH_VERTS.min(axis=0).tolist(),
        "max": MESH_VERTS.max(axis=0).tolist(),
    }


# --- Gate 2 — per-cloud elevation-filter fixtures --------------------------
# These expose the bug described in docs/gate2-per-cloud-filter-plan.md: the
# elevation filter converts a world-space window into attribute space with ONE
# origin and ONE up-axis for the whole scene, so a second static cloud with a
# different origin, or a different up-axis format, clips at the wrong world
# height. Two independent pairs below, each isolating one half of the bug.
# See tests/fixtures/FIXTURES.md for the worked accept/reject math.

GATE2_SCALE = (0.001, 0.001, 0.001)


def build_las_generic(
    xyz: np.ndarray,
    intensity: np.ndarray,
    classification: np.ndarray,
    offset: tuple,
    point_format: int = 6,
) -> laspy.LasData:
    header = laspy.LasHeader(point_format=point_format, version="1.4")
    header.scales = np.array(GATE2_SCALE, dtype=np.float64)
    header.offsets = np.array(offset, dtype=np.float64)
    las = laspy.LasData(header)
    las.x = xyz[:, 0]
    las.y = xyz[:, 1]
    las.z = xyz[:, 2]
    las.intensity = intensity
    las.classification = classification
    return las


def write_las_generic(path: Path, xyz: np.ndarray, offset: tuple) -> dict:
    n = xyz.shape[0]
    intensity = np.linspace(50, 500, n).astype(np.uint16)
    classification = np.full(n, 2, dtype=np.uint8)  # 2 = ground
    las = build_las_generic(xyz, intensity, classification, offset)
    las.write(str(path))
    r = laspy.read(str(path))
    stored = np.column_stack([r.x, r.y, r.z])
    origin = [float(np.floor(v)) for v in stored.min(axis=0)]
    return {
        "count": int(r.header.point_count),
        "xyz": stored,
        "min": stored.min(axis=0).tolist(),
        "max": stored.max(axis=0).tolist(),
        "origin": origin,
        "bytes": path.stat().st_size,
    }


def write_ply_generic(path: Path, xyz: np.ndarray, colors: np.ndarray) -> dict:
    cloud = trimesh.PointCloud(vertices=xyz, colors=colors)
    cloud.export(str(path), file_type="ply", encoding="ascii")
    origin = [float(np.floor(v)) for v in xyz.min(axis=0)]
    return {
        "count": int(xyz.shape[0]),
        "xyz": xyz,
        "min": xyz.min(axis=0).tolist(),
        "max": xyz.max(axis=0).tolist(),
        "origin": origin,
        "bytes": path.stat().st_size,
    }


def points_in_window(xyz: np.ndarray, axis_idx: int, lo: float, hi: float) -> list:
    """Indices (1-based, generation order) whose `axis_idx` coordinate falls
    in the inclusive [lo, hi] world-space window — the CPU mirror the shader
    and the pick predicate both apply."""
    vals = xyz[:, axis_idx]
    return [i + 1 for i, v in enumerate(vals) if lo <= v <= hi]


# Pair 1 — two static clouds, same up-axis (Z-up/LAS), DIFFERENT origins.
# "Two tiles from different areas" per the Stage B device check. World Z
# ranges overlap (both reach 195-204) so one world window should clip both
# at the same true height; the current single-origin conversion clips
# whichever cloud did not supply the shared origin at the WRONG height.
GATE2_ORIGIN_A_XYZ = np.column_stack(
    [
        500000.0 + np.arange(10),
        4100000.0 + np.arange(10),
        195.0 + np.arange(10),  # 195..204, step 1
    ]
)
GATE2_ORIGIN_B_XYZ = np.column_stack(
    [
        650000.0 + np.arange(10),
        4250000.0 + np.arange(10),
        150.0 + 6.0 * np.arange(10),  # 150..204, step 6
    ]
)

# Pair 2 — one Z-up survey (LAS), one Y-up phone scan (PLY). World elevation
# overlaps (both 10..19) but lives on a DIFFERENT position component per
# format (Z for the survey, Y for the scan) — the axis half of the bug.
GATE2_AXIS_ZUP_XYZ = np.column_stack(
    [
        0.0 + np.arange(10),
        20.0 + np.arange(10),
        10.0 + np.arange(10),  # elevation (Z), 10..19, step 1
    ]
)
GATE2_AXIS_YUP_XYZ = np.column_stack(
    [
        -2.0 + 0.5 * np.arange(10),
        10.0 + np.arange(10),  # elevation (Y), 10..19, step 1
        0.3 * np.arange(10),  # scanner depth (Z), 0.0..2.7
    ]
)
GATE2_AXIS_YUP_RGB = np.array(
    [[int(20 + 20 * i), int(60 + 15 * i), int(220 - 15 * i)] for i in range(10)],
    dtype=np.uint8,
)


def write_gate2_fixtures() -> dict:
    origin_a = write_las_generic(
        FIXTURES / "gate2-origin-a.las", GATE2_ORIGIN_A_XYZ, (500000.0, 4100000.0, 195.0)
    )
    origin_b = write_las_generic(
        FIXTURES / "gate2-origin-b.las", GATE2_ORIGIN_B_XYZ, (650000.0, 4250000.0, 150.0)
    )
    axis_zup = write_las_generic(
        FIXTURES / "gate2-axis-zup-survey.las", GATE2_AXIS_ZUP_XYZ, (0.0, 20.0, 10.0)
    )
    axis_yup = write_ply_generic(
        FIXTURES / "gate2-axis-yup-scan.ply", GATE2_AXIS_YUP_XYZ, GATE2_AXIS_YUP_RGB
    )
    return {
        "origin_a": origin_a,
        "origin_b": origin_b,
        "axis_zup": axis_zup,
        "axis_yup": axis_yup,
    }


def simulate_shared_filter(clouds: dict, first_loaded_key: str, axis_is_z: bool, lo: float, hi: float) -> dict:
    """Reproduce today's (pre-Stage-B) `Viewer.setElevationFilter` + shader
    mask exactly: ONE axis (from whichever cloud loaded LAST) and ONE origin
    (from whichever static cloud loaded FIRST) are shared across every cloud.
    `clouds[key]` holds `{'xyz': Nx3 world array, 'origin': [ox, oy, oz]}`.
    Returns `key -> accepted 1-based point indices` under that shared, buggy
    conversion — the CPU mirror of `_elevMaskMultiplier` / `pointFilterAccept`.
    """
    axis_idx = 2 if axis_is_z else 1
    origin_used = clouds[first_loaded_key]["origin"][axis_idx]
    attr_min = lo - origin_used
    attr_max = hi - origin_used
    out = {}
    for key, c in clouds.items():
        attr = c["xyz"][:, axis_idx] - c["origin"][axis_idx]
        out[key] = [i + 1 for i, v in enumerate(attr) if attr_min <= v <= attr_max]
    return out


def fmt(vec) -> str:
    return "[" + ", ".join(f"{v:.6f}" for v in vec) + "]"


def main() -> None:
    las = write_las_files()
    ply = write_ply()
    mesh = write_meshes()
    gate2 = write_gate2_fixtures()

    md = []
    md.append("# Test Fixtures — Ground Truth")
    md.append("")
    md.append("Generated by `scripts/make-fixtures.py`. Do not edit by hand.")
    md.append("These recorded values are the ground truth the core-IO tests assert against.")
    md.append("")

    md.append("## tiny.las / tiny.laz")
    md.append("")
    md.append("Same georeferenced point cloud, written in both LAS and LAZ.")
    md.append("LAS point format 6, version 1.4.")
    md.append("")
    md.append(f"- pointCount: {las['count']}")
    md.append(f"- versionMinor: {las['version_minor']}")
    md.append(f"- scale: {fmt(las['scale'])}")
    md.append(f"- offset: {fmt(las['offset'])}")
    md.append(f"- firstPoint: {fmt(las['first'])}")
    md.append(f"- min: {fmt(las['min'])}")
    md.append(f"- max: {fmt(las['max'])}")
    md.append("")

    md.append("## tiny.ply")
    md.append("")
    md.append("Local-coordinate point cloud with per-vertex RGB color.")
    md.append("")
    md.append(f"- pointCount: {ply['count']}")
    md.append(f"- firstPoint: {fmt(ply['first'])}")
    md.append(f"- min: {fmt(ply['min'])}")
    md.append(f"- max: {fmt(ply['max'])}")
    md.append("")

    md.append("## tiny.obj")
    md.append("")
    md.append("Small local-coordinate mesh (a unit-ish cube).")
    md.append("")
    md.append(f"- vertexCount: {mesh['count']}")
    md.append(f"- firstVertex: {fmt(mesh['first'])}")
    md.append(f"- min: {fmt(mesh['min'])}")
    md.append(f"- max: {fmt(mesh['max'])}")
    md.append("")

    md.append("## tiny.glb")
    md.append("")
    md.append("Same cube mesh as tiny.obj, exported as binary glTF.")
    md.append("")
    md.append(f"- vertexCount: {mesh['count']}")
    md.append(f"- firstVertex: {fmt(mesh['first'])}")
    md.append(f"- min: {fmt(mesh['min'])}")
    md.append(f"- max: {fmt(mesh['max'])}")
    md.append("")

    # --- Gate 2 fixtures ------------------------------------------------
    oa, ob = gate2["origin_a"], gate2["origin_b"]
    zc, yc = gate2["axis_zup"], gate2["axis_yup"]

    md.append("## Gate 2 — per-cloud elevation filter (gate2-*)")
    md.append("")
    md.append(
        "Fixtures for `docs/gate2-per-cloud-filter-plan.md` Stage B. The elevation "
        "filter converts a world-space window into attribute space with ONE origin "
        "and ONE up-axis for the whole scene (`Viewer.setElevationFilter`), so a "
        "second cloud with a different origin, or a different up-axis format, "
        "clips at the wrong world height. These pairs make that visible with a "
        "concrete world window and the point-index math for both the correct "
        "(per-cloud) answer and today's shared-origin/shared-axis answer."
    )
    md.append("")

    md.append("### gate2-origin-a.las / gate2-origin-b.las — different origins, same up-axis")
    md.append("")
    md.append(
        "Two Z-up LAS tiles from different areas (a few hundred kilometres apart in "
        "X/Y) whose Z ranges overlap. `origin-a` is 195-204 m, `origin-b` is "
        "150-204 m in steps of 6 m — both climb through the 195-204 m band, so one "
        "world window should clip both at the same true height."
    )
    md.append("")
    md.append("gate2-origin-a.las:")
    md.append(f"- pointCount: {oa['count']}")
    md.append(f"- up-axis: Z (LAS)")
    md.append(f"- min: {fmt(oa['min'])}")
    md.append(f"- max: {fmt(oa['max'])}")
    md.append(f"- origin (floored min): {fmt(oa['origin'])}")
    md.append("")
    md.append("gate2-origin-b.las:")
    md.append(f"- pointCount: {ob['count']}")
    md.append(f"- up-axis: Z (LAS)")
    md.append(f"- min: {fmt(ob['min'])}")
    md.append(f"- max: {fmt(ob['max'])}")
    md.append(f"- origin (floored min): {fmt(ob['origin'])}")
    md.append("")

    win1 = (198.0, 202.0)
    correct_a = points_in_window(oa["xyz"], 2, *win1)
    correct_b = points_in_window(ob["xyz"], 2, *win1)
    clouds1 = {"a": {"xyz": oa["xyz"], "origin": oa["origin"]}, "b": {"xyz": ob["xyz"], "origin": ob["origin"]}}
    buggy_a_first = simulate_shared_filter(clouds1, first_loaded_key="a", axis_is_z=True, lo=win1[0], hi=win1[1])
    buggy_b_first = simulate_shared_filter(clouds1, first_loaded_key="b", axis_is_z=True, lo=win1[0], hi=win1[1])
    origin_shift = oa["origin"][2] - ob["origin"][2]

    md.append(f"**Device check window: world Z in [{win1[0]:.0f}, {win1[1]:.0f}] m.**")
    md.append("")
    md.append(
        f"Correct (per-cloud, Stage B): `gate2-origin-a` accepts point(s) "
        f"{correct_a} ({len(correct_a)} of {oa['count']}, Z = "
        f"{[float(oa['xyz'][i-1, 2]) for i in correct_a]}); `gate2-origin-b` accepts "
        f"point(s) {correct_b} ({len(correct_b)} of {ob['count']}, Z = "
        f"{[float(ob['xyz'][i-1, 2]) for i in correct_b]})."
    )
    md.append("")
    md.append(
        f"Buggy (today, Stage A — one shared origin from whichever cloud loaded "
        f"FIRST): the origins differ by {origin_shift:.0f} m along Z, so the OTHER "
        f"cloud's effective accept window shifts by that same {origin_shift:.0f} m."
    )
    if buggy_a_first["b"]:
        wrong_z = float(ob["xyz"][buggy_a_first["b"][0] - 1, 2])
        right_z = float(ob["xyz"][correct_b[0] - 1, 2])
        b_desc = f"wrong point, Z = {wrong_z:.0f} m instead of {right_z:.0f} m"
    else:
        b_desc = "nothing shown"
    a_desc = "nothing shown, band shifted clean out of the tile" if not buggy_b_first["a"] else "wrong points"

    md.append(
        f"- Load a then b: `gate2-origin-a` still accepts {buggy_a_first['a']} "
        f"(correct — it supplied the shared origin); `gate2-origin-b` accepts "
        f"{buggy_a_first['b']} instead of {correct_b} ({b_desc})."
    )
    md.append(
        f"- Load b then a: `gate2-origin-b` still accepts {buggy_b_first['b']} "
        f"(correct); `gate2-origin-a` accepts {buggy_b_first['a']} instead of "
        f"{correct_a} ({a_desc})."
    )
    md.append("")

    md.append("### gate2-axis-zup-survey.las / gate2-axis-yup-scan.ply — different up-axis")
    md.append("")
    md.append(
        "A Z-up survey (LAS) and a Y-up phone scan (PLY). Both hold world elevation "
        "10-19 m, but the survey carries it on Z while the scan carries it on Y (its "
        "Z is scanner depth, 0.0-2.7 m). `_worldUp` is reset from whichever cloud "
        "loaded LAST, so the shared axis is wrong for at least one of the two "
        "clouds regardless of load order."
    )
    md.append("")
    md.append("gate2-axis-zup-survey.las:")
    md.append(f"- pointCount: {zc['count']}")
    md.append(f"- up-axis: Z (LAS)")
    md.append(f"- min: {fmt(zc['min'])}")
    md.append(f"- max: {fmt(zc['max'])}")
    md.append(f"- origin (floored min): {fmt(zc['origin'])}")
    md.append("")
    md.append("gate2-axis-yup-scan.ply:")
    md.append(f"- pointCount: {yc['count']}")
    md.append(f"- up-axis: Y (PLY)")
    md.append(f"- min: {fmt(yc['min'])}")
    md.append(f"- max: {fmt(yc['max'])}")
    md.append(f"- origin (floored min): {fmt(yc['origin'])}")
    md.append("")

    win2 = (12.0, 17.0)
    correct_zc = points_in_window(zc["xyz"], 2, *win2)
    correct_yc = points_in_window(yc["xyz"], 1, *win2)
    clouds2 = {"zup": {"xyz": zc["xyz"], "origin": zc["origin"]}, "yup": {"xyz": yc["xyz"], "origin": yc["origin"]}}
    buggy_zup_first = simulate_shared_filter(clouds2, first_loaded_key="zup", axis_is_z=False, lo=win2[0], hi=win2[1])
    buggy_yup_first = simulate_shared_filter(clouds2, first_loaded_key="yup", axis_is_z=True, lo=win2[0], hi=win2[1])

    md.append(f"**Device check window: world elevation in [{win2[0]:.0f}, {win2[1]:.0f}] m.**")
    md.append("")
    md.append(
        f"Correct (per-cloud, Stage B): `gate2-axis-zup-survey` accepts "
        f"{correct_zc} ({len(correct_zc)} of {zc['count']}, its own Z); "
        f"`gate2-axis-yup-scan` accepts {correct_yc} ({len(correct_yc)} of "
        f"{yc['count']}, its own Y). Both bands sit at the same world height."
    )
    md.append("")
    md.append(
        "Buggy (today, Stage A — one shared axis from whichever cloud loaded LAST, "
        "one shared origin from whichever loaded FIRST): with these two clouds the "
        "shared threshold always lands outside BOTH clouds' 0-9 attribute range, "
        "so the filter shows ZERO points on both layers no matter the load order — "
        f"instead of {len(correct_zc)} + {len(correct_yc)} = "
        f"{len(correct_zc) + len(correct_yc)} points total."
    )
    md.append(
        f"- Load survey then scan (shared axis = Y, from the scan): "
        f"`gate2-axis-zup-survey` accepts {buggy_zup_first['zup']}, "
        f"`gate2-axis-yup-scan` accepts {buggy_zup_first['yup']}."
    )
    md.append(
        f"- Load scan then survey (shared axis = Z, from the survey): "
        f"`gate2-axis-zup-survey` accepts {buggy_yup_first['zup']}, "
        f"`gate2-axis-yup-scan` accepts {buggy_yup_first['yup']}."
    )
    md.append("")

    (FIXTURES / "FIXTURES.md").write_text("\n".join(md))

    print("Wrote fixtures to", FIXTURES)
    for name in (
        "tiny.las", "tiny.laz", "tiny.ply", "tiny.obj", "tiny.glb",
        "gate2-origin-a.las", "gate2-origin-b.las",
        "gate2-axis-zup-survey.las", "gate2-axis-yup-scan.ply",
        "FIXTURES.md",
    ):
        p = FIXTURES / name
        print(f"  {name}: {'OK' if p.exists() else 'MISSING'} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
