#!/usr/bin/env python3
"""
generate-coconino-reference.py — build the Coconino checkpoint crop + matched
reference for OLV's DTM accuracy test.

Source (public domain, USGS 3DEP / The National Map): USGS AZ Coconino B1 2019
(project 19049). The authoritative checkpoint set lives in
  validation/terrain-field/references/coconino-b19-2019__checkpoints.json
reprojected to the LiDAR tile CRS (NAD83(2011) / Conus Albers, EPSG:6350). Tile
Z and checkpoint Z are BOTH NAVD88 orthometric (Geoid12B), so no vertical
reconciliation.

This script is tile-agnostic. Point it at one or more downloaded project tiles;
it finds every checkpoint that falls inside a tile's horizontal bounds, crops the
class-2 (ground) points within RADIUS of each such checkpoint, and writes:
  - crops/coconino__ground.f32           Float32 (x,y,z) relative to ORIGIN
  - references/coconino__matched.json    matched checkpoints in the same frame

The test (tests/coconinoCheckpoints.test.ts) grids that ground with OLV's
production rasterizeDtm and compares each checkpoint to its DTM cell. A single
forested tile yields N=1 (e.g. TR03); adding more project tiles grows N with no
code change.

Usage:
    python3 scripts/terrain-field/generate-coconino-reference.py \
        "/path/to/USGS_LPC_AZ_Coconino_2019_B19_w1407n1486.laz" [more tiles...]

Requires: laspy[lazrs].  (No PROJ needed here — checkpoints are pre-reprojected.)
"""

import json
import sys
from pathlib import Path

RADIUS = 3.0  # m — ground crop halo per checkpoint; forest ground is sparse.
CLASS_GROUND = 2

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "validation/terrain-field/references/coconino-b19-2019__checkpoints.json"
OUT_GROUND = ROOT / "validation/terrain-field/crops/coconino__ground.f32"
OUT_MATCHED = ROOT / "validation/terrain-field/references/coconino__matched.json"


def main(tiles):
    import numpy as np
    import laspy

    ref = json.loads(REF.read_text())
    cps = ref["checkpoints"]

    matched = []          # checkpoints found inside some tile
    ground_xyz = []       # (x,y,z) absolute Albers, class-2, near a matched checkpoint

    for tile in tiles:
        las = laspy.read(tile)
        xmin, ymin = float(las.header.mins[0]), float(las.header.mins[1])
        xmax, ymax = float(las.header.maxs[0]), float(las.header.maxs[1])
        in_tile = [c for c in cps if xmin <= c["albersE"] <= xmax and ymin <= c["albersN"] <= ymax]
        if not in_tile:
            print(f"  {Path(tile).name}: no checkpoints inside bounds", file=sys.stderr)
            continue
        cls = np.asarray(las.classification)
        gx = np.asarray(las.x)[cls == CLASS_GROUND]
        gy = np.asarray(las.y)[cls == CLASS_GROUND]
        gz = np.asarray(las.z)[cls == CLASS_GROUND]
        for c in in_tile:
            m = (np.abs(gx - c["albersE"]) <= RADIUS) & (np.abs(gy - c["albersN"]) <= RADIUS)
            if not m.any():
                print(f"  {c['id']}: no class-2 ground within {RADIUS} m — rejected", file=sys.stderr)
                continue
            matched.append(c)
            for x, y, z in zip(gx[m], gy[m], gz[m]):
                ground_xyz.append((float(x), float(y), float(z)))
        print(f"  {Path(tile).name}: matched {[c['id'] for c in in_tile]}", file=sys.stderr)

    if not matched:
        sys.exit("No checkpoints matched any provided tile — nothing written.")

    # One shared origin so the crop and the checkpoints share a frame.
    ox = min(p[0] for p in ground_xyz)
    oy = min(p[1] for p in ground_xyz)
    import numpy as np
    arr = np.array([(x - ox, y - oy, z) for (x, y, z) in ground_xyz], dtype=np.float32)
    OUT_GROUND.write_bytes(arr.tobytes())

    OUT_MATCHED.write_text(json.dumps({
        "source": ref["source"],
        "verticalDatum": ref["verticalDatum"],
        "horizontalCrs": ref["horizontalCrs"],
        "originAlbersE": round(ox, 3),
        "originAlbersN": round(oy, 3),
        "groundPoints": len(ground_xyz),
        "checkpoints": [
            {"id": c["id"], "type": c["type"],
             "e": round(c["albersE"] - ox, 3), "n": round(c["albersN"] - oy, 3), "z": c["z"]}
            for c in matched
        ],
    }, indent=1))
    print(f"wrote {OUT_GROUND.name} ({len(ground_xyz)} pts) and {OUT_MATCHED.name} ({len(matched)} checkpoints)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
