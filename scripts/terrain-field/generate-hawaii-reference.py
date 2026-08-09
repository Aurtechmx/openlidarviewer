#!/usr/bin/env python3
"""
generate-hawaii-reference.py — Hawaii NOAA leg: a datum-INDEPENDENT gridding
reference plus a datum-reduced surveyed-checkpoint SPOT CHECK.

Two separate things, kept separate on purpose:

1. GRIDDING CORRECTNESS (datum-independent). Crops class-2 ground from the real
   NOAA Maui/Oahu 2020 tile and grids it with scipy binned_statistic_2d — the
   SAME point-in-cell mean OLV performs, in a separate codebase. Both use the
   tile's own Z, so this leg is valid whatever the vertical datum is; it proves
   OLV bins/averages real NAD83(PA11)/UTM-5N coordinates correctly.

2. ABSOLUTE VERTICAL SPOT CHECK (datum-dependent, N=1). The tile carries NO
   declared vertical datum; empirically its Z is ELLIPSOIDAL (~16.5 m above the
   surveyed orthometric checkpoint). Hawaii's authoritative geoid is GEOID12B
   (GEOID18 has no Hawaii grid). We reduce the tile ground to NAVD88 with the
   GEOID12B model (independent of the checkpoint) and record the residual against
   the one in-tile surveyed check point (2001A_2021_HI). This is a single-point,
   datum-limited spot check — recorded, never asserted as an accuracy pass.

Reproduce (pdal, scipy, and the PROJ GEOID12B Hawaii grid us_noaa_g2012bh0.tif
must be present):
  python3 scripts/terrain-field/generate-hawaii-reference.py <tile>.copc.laz
"""
import json
import subprocess
import sys
import tempfile
import numpy as np
from scipy.stats import binned_statistic_2d

LAZ = sys.argv[1]
ORIGIN_X, ORIGIN_Y = 295000.0, 2169500.0
COLS = ROWS = 100
CELL = 1.0
OUT = "validation/terrain-field"
# The one surveyed check point inside the tile (NOAA survey gpkg).
CHECKPOINT = {
    "id": "2001A_2021_HI", "point_type": "NVA", "source_geoid": "GEOID12B",
    "horizontal_epsg": 6635, "vertical_epsg": 5703,
    "easting": 295418.516, "northing": 2169835.956, "orthometric_elev_m": 12.674,
    "lon": -154.9507415, "lat": 19.6130967,
}


def ground_xyz():
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tf:
        out = tf.name
    pipe = {"pipeline": [
        {"type": "readers.copc", "filename": LAZ,
         "bounds": f"([{ORIGIN_X},{ORIGIN_X+COLS*CELL}],[{ORIGIN_Y},{ORIGIN_Y+ROWS*CELL}])"},
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.text", "format": "csv", "order": "X,Y,Z", "keep_unspecified": "false", "filename": out},
    ]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as pf:
        json.dump(pipe, pf); pf.flush()
        subprocess.run(["pdal", "pipeline", pf.name], check=True)
    return np.loadtxt(out, delimiter=",", skiprows=1).reshape(-1, 3)


def geoid12b_N(lon, lat):
    """Independent GEOID12B separation (m) via the PROJ Hawaii grid."""
    o = subprocess.run(
        ["bash", "-lc", f'echo "{lon} {lat} 0" | cct -d 4 +proj=vgridshift +grids=us_noaa_g2012bh0.tif'],
        capture_output=True, text=True).stdout.split()
    return abs(float(o[2]))


def main():
    xyz = ground_xyz()
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]

    # ── datum-independent scipy gridding reference ──
    xe = ORIGIN_X + np.arange(COLS + 1) * CELL
    ye = ORIGIN_Y + np.arange(ROWS + 1) * CELL
    stat, _, _, _ = binned_statistic_2d(x, y, z, statistic="mean", bins=[xe, ye])
    grid = stat.T  # row 0 = south
    nodata = -9999.0
    filled = np.where(np.isfinite(grid), grid, nodata)
    asc = f"ncols {COLS}\nnrows {ROWS}\nxllcorner {ORIGIN_X}\nyllcorner {ORIGIN_Y}\ncellsize {CELL}\nNODATA_value {int(nodata)}\n"
    for r in range(ROWS - 1, -1, -1):
        asc += " ".join(f"{v:.4f}" for v in filled[r]) + "\n"
    open(f"{OUT}/references/hawaii-tile__bincell-dtm.asc", "w").write(asc)

    rel = np.empty((xyz.shape[0], 3), dtype=np.float32)
    rel[:, 0] = (x - ORIGIN_X).astype(np.float32)
    rel[:, 1] = (y - ORIGIN_Y).astype(np.float32)
    rel[:, 2] = z.astype(np.float32)
    rel.tofile(f"{OUT}/crops/hawaii-tile__ground.f32")

    crop = {"id": "hawaii-tile", "dataset": "HI-NOAA-MAUI-OAHU-2020",
            "crs": {"horizontalEpsg": 6635, "name": "NAD83(PA11) / UTM 5N", "verticalDatum": "UNDECLARED (empirically ellipsoidal)"},
            "originH1": ORIGIN_X, "originH2": ORIGIN_Y, "cols": COLS, "rows": ROWS, "cellSizeM": CELL,
            "groundPoints": int(xyz.shape[0]), "zMin": float(z.min()), "zMax": float(z.max())}
    open(f"{OUT}/crops/hawaii-tile.crop.json", "w").write(json.dumps(crop, indent=2) + "\n")

    # ── datum-reduced surveyed-checkpoint spot check (N=1) ──
    # Tile ground ellipsoidal at the checkpoint (2 m radius class-2 mean).
    ci, cj = CHECKPOINT["easting"], CHECKPOINT["northing"]
    near = (np.abs(x - ci) <= 2) & (np.abs(y - cj) <= 2)
    tile_ellip = float(np.mean(z[near])) if near.sum() else float("nan")
    N = geoid12b_N(CHECKPOINT["lon"], CHECKPOINT["lat"])
    tile_orthometric = tile_ellip - N
    residual = tile_orthometric - CHECKPOINT["orthometric_elev_m"]
    record = {
        "leg": "absolute-vertical-spot-check",
        "status": "REVIEW",
        "n_checkpoints": 1,
        "checkpoint": CHECKPOINT,
        "tile_vertical_datum": "UNDECLARED in LAZ; empirically ellipsoidal (NAD83(PA11))",
        "geoid_model": "GEOID12B (us_noaa_g2012bh0.tif, PROJ CDN) — Hawaii's authoritative geoid; GEOID18 has no Hawaii grid",
        "geoid_separation_m": round(N, 4),
        "tile_ground_ellipsoidal_m": round(tile_ellip, 4),
        "tile_ground_reduced_navd88_m": round(tile_orthometric, 4),
        "surveyed_orthometric_m": CHECKPOINT["orthometric_elev_m"],
        "residual_m": round(residual, 4),
        "support_points_within_2m": int(near.sum()),
        "interpretation": (
            "Single-point, datum-limited spot check. The residual is dominated by "
            "vertical-datum / geoid-model uncertainty (the tile declares no vertical "
            "datum), not by OLV gridding. With N=1 this is not a statistical accuracy "
            "validation. Gridding correctness is validated separately and "
            "datum-independently against scipy. Reported unchanged; not tuned."
        ),
    }
    open(f"{OUT}/references/hawaii-tile__checkpoint-spotcheck.json", "w").write(json.dumps(record, indent=2) + "\n")

    covered = int(np.isfinite(grid).sum())
    print(f"hawaii: {xyz.shape[0]} class-2 pts, {covered}/{COLS*ROWS} cells | ellip z {z.min():.2f}-{z.max():.2f}")
    print(f"spot check: tile_ellip={tile_ellip:.3f} - N(GEOID12B)={N:.3f} = {tile_orthometric:.3f} vs surveyed {CHECKPOINT['orthometric_elev_m']:.3f} -> residual {residual:+.3f} m (REVIEW, N=1)")


if __name__ == "__main__":
    main()
