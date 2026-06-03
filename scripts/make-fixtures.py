#!/usr/bin/env python3
"""Generate deterministic test fixtures for OpenLiDARViewer core-IO tests.

Emits into tests/fixtures/:
  - tiny.las / tiny.laz : same ~12-point georeferenced cloud (UTM-like coords)
  - tiny.ply            : ~10-point local cloud with per-vertex RGB
  - tiny.obj            : ~8-vertex local mesh
  - tiny.glb            : ~8-vertex local mesh
  - FIXTURES.md         : ground-truth values the tests assert against

Run: python3 scripts/make-fixtures.py
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


def fmt(vec) -> str:
    return "[" + ", ".join(f"{v:.6f}" for v in vec) + "]"


def main() -> None:
    las = write_las_files()
    ply = write_ply()
    mesh = write_meshes()

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

    (FIXTURES / "FIXTURES.md").write_text("\n".join(md))

    print("Wrote fixtures to", FIXTURES)
    for name in ("tiny.las", "tiny.laz", "tiny.ply", "tiny.obj", "tiny.glb", "FIXTURES.md"):
        p = FIXTURES / name
        print(f"  {name}: {'OK' if p.exists() else 'MISSING'} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
