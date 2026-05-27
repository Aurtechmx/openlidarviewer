#!/usr/bin/env python3
"""
make-ept-fixture.py

Generate a small deterministic EPT (Entwine Point Tile) dataset for the
v0.3.3 EPT integration tests. The fixture mirrors the directory layout
the EPT spec defines:

    <root>/ept.json
    <root>/ept-hierarchy/0-0-0-0.json
    <root>/ept-data/0-0-0-0.bin           ← binary tiles (uncompressed)

We use `dataType: binary` for the fixture rather than `laszip` so the
tests can run without invoking the laz-perf worker. Real-world EPT
datasets are predominantly laszip, but the fixture exercises the
manifest + hierarchy + node-traversal code paths which are dataType-
independent. The laszip-specific decode path is exercised by the COPC
fixtures via the same shared `copcChunkDecode` worker.

The fixture is deterministic: re-running with the same `--seed` produces
byte-identical output. CI can re-create it on demand without diffing.

Usage:
    python3 scripts/make-ept-fixture.py --out tests/fixtures/ept-tiny \\
        --points 1000 --span 128 --seed 42
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import struct
import sys
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Schema — what every binary tile carries per point. Mirrors a typical EPT
# binary layout: X/Y/Z as int32 with scale + offset, plus uint16 intensity
# and uint8 classification, packed in this order.
# ─────────────────────────────────────────────────────────────────────────────
SCHEMA = [
    {"name": "X",              "size": 4, "type": "signed",   "scale": 0.001, "offset": 0.0},
    {"name": "Y",              "size": 4, "type": "signed",   "scale": 0.001, "offset": 0.0},
    {"name": "Z",              "size": 4, "type": "signed",   "scale": 0.001, "offset": 0.0},
    {"name": "Intensity",      "size": 2, "type": "unsigned"},
    {"name": "Classification", "size": 1, "type": "unsigned"},
]

POINT_BYTES = sum(f["size"] for f in SCHEMA)  # 4+4+4+2+1 = 15


def write_manifest(out: Path, points: int, span: int, bounds_cube: list[float]) -> None:
    """Emit ept.json at the dataset root."""
    manifest = {
        "version": "1.1.0",
        "dataType": "binary",
        "hierarchyType": "json",
        "points": points,
        "span": span,
        "schema": SCHEMA,
        "bounds": bounds_cube,                # the cube
        "boundsConforming": bounds_cube,      # tight bounds (same as cube here)
        "srs": {
            "authority": "EPSG",
            "horizontal": "32612",            # UTM 12N — matches our CRS tests
            "wkt": (
                'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",'
                'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],'
                'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
                'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
                'AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],'
                'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-111],'
                'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],'
                'PARAMETER["false_northing",0],'
                'UNIT["metre",1,AUTHORITY["EPSG","9001"]],'
                'AUTHORITY["EPSG","32612"]]'
            ),
        },
    }
    out.write_text(json.dumps(manifest, indent=2))


def write_root_hierarchy(out: Path, root_points: int) -> None:
    """
    Emit the root hierarchy file with just the root node (0-0-0-0).
    For the small fixture sizes we exercise, everything fits in the root
    tile so the hierarchy is a single entry — no link records needed.
    """
    hierarchy = {"0-0-0-0": root_points}
    out.write_text(json.dumps(hierarchy, indent=2))


def write_root_tile(out: Path, points: int, bounds: list[float], seed: int) -> None:
    """
    Emit the binary tile for the root node — `points` points distributed
    deterministically inside the cube bounds.
    """
    rng = random.Random(seed)
    min_x, min_y, min_z, max_x, max_y, max_z = bounds
    # Apply the schema's scale (0.001) — write integer values that the
    # decoder multiplies by 0.001 to recover the float coordinate.
    scale = SCHEMA[0]["scale"]
    with out.open("wb") as fh:
        for _ in range(points):
            fx = rng.uniform(min_x, max_x)
            fy = rng.uniform(min_y, max_y)
            fz = rng.uniform(min_z, max_z)
            ix = int(round(fx / scale))
            iy = int(round(fy / scale))
            iz = int(round(fz / scale))
            intensity = rng.randint(0, 65535)
            classification = rng.choice([2, 5, 6, 9, 1])  # ground/veg/bldg/water/unclass
            fh.write(struct.pack("<iiiHB", ix, iy, iz, intensity, classification))


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a synthetic EPT fixture.")
    parser.add_argument("--out", required=True, help="Output directory (will be created).")
    parser.add_argument("--points", type=int, default=1000, help="Total point count.")
    parser.add_argument("--span", type=int, default=128, help="EPT span value.")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for deterministic output.")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "ept-hierarchy").mkdir(exist_ok=True)
    (out / "ept-data").mkdir(exist_ok=True)

    # Cube bounds — a 100m × 100m × 50m volume in UTM 12N near central Utah.
    # These match the CRS fixture in our crs.test.ts so end-to-end tests can
    # validate CRS + bounds together.
    bounds_cube = [
        500_000.0,    500_000.0,    1_500.0,
        500_100.0,    500_100.0,    1_550.0,
    ]

    write_manifest(out / "ept.json", args.points, args.span, bounds_cube)
    write_root_hierarchy(out / "ept-hierarchy" / "0-0-0-0.json", args.points)
    write_root_tile(out / "ept-data" / "0-0-0-0.bin", args.points, bounds_cube, args.seed)

    total_bytes = (out / "ept-data" / "0-0-0-0.bin").stat().st_size
    expected_bytes = args.points * POINT_BYTES
    assert total_bytes == expected_bytes, (
        f"tile size mismatch: wrote {total_bytes} bytes for {args.points} points "
        f"({POINT_BYTES} bytes/point expected = {expected_bytes})"
    )

    print(f"wrote {out}/ept.json + {args.points} points ({total_bytes} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
