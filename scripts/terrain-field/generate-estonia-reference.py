#!/usr/bin/env python3
"""
generate-estonia-reference.py — the Estonia National LiDAR harness leg.

Crops a 100 x 100 m interior window of the Estonian Land Board 2020 tile
(EPSG:3301 L-EST97 Lambert Conformal Conic + EH2000 vertical), keeps class-2
ground, and produces:

  crops/estonia-tava__ground.f32          OLV fixture (Float32 x,y,z origin-relative)
  crops/estonia-tava.crop.json            frozen crop bounds + grid
  references/estonia-tava__bincell-dtm.asc  scipy point-in-cell DTM (independent)

The scipy binned_statistic_2d mean is the SAME point-in-cell operation OLV's
rasteriser performs, in a separate codebase — the tight gridding-correctness leg.
Estonia adds a third projection family (Lambert Conformal Conic) to the harness,
distinct from the UTM/TM datasets.

Reproduce:
  pdal must be on PATH; scipy/numpy in the environment.
  python3 scripts/terrain-field/generate-estonia-reference.py <path-to>.laz
"""
import json
import subprocess
import sys
import tempfile
import numpy as np
from scipy.stats import binned_statistic_2d

LAZ = sys.argv[1]
# Interior 100 m window of the 539000-540000 / 6568000-6569000 tile.
ORIGIN_X, ORIGIN_Y = 539450.0, 6568450.0
COLS = ROWS = 100
CELL = 1.0
OUT_DIR = "validation/terrain-field"


def pdal_ground_xyz():
    """Crop + keep class 2, return Nx3 float64 array of absolute X,Y,Z."""
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tf:
        out = tf.name
    pipeline = {
        "pipeline": [
            {"type": "readers.las", "filename": LAZ},
            {"type": "filters.crop", "bounds": f"([{ORIGIN_X},{ORIGIN_X+COLS*CELL}],[{ORIGIN_Y},{ORIGIN_Y+ROWS*CELL}])"},
            {"type": "filters.range", "limits": "Classification[2:2]"},
            {"type": "writers.text", "format": "csv", "order": "X,Y,Z", "keep_unspecified": "false", "filename": out},
        ]
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as pf:
        json.dump(pipeline, pf)
        pf.flush()
        subprocess.run(["pdal", "pipeline", pf.name], check=True)
    data = np.loadtxt(out, delimiter=",", skiprows=1)
    return data.reshape(-1, 3)


def main():
    xyz = pdal_ground_xyz()
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]

    xedges = ORIGIN_X + np.arange(COLS + 1) * CELL
    yedges = ORIGIN_Y + np.arange(ROWS + 1) * CELL
    stat, _, _, _ = binned_statistic_2d(x, y, z, statistic="mean", bins=[xedges, yedges])
    # stat is [xbin, ybin]; transpose to row-major [row=y, col=x], row 0 = south.
    grid = stat.T  # (rows, cols), row 0 = south (yedges ascending)
    nodata = -9999.0
    filled = np.where(np.isfinite(grid), grid, nodata)

    # ASCII grid: file row 0 = NORTH → flip the south-up grid.
    asc = f"ncols {COLS}\nnrows {ROWS}\nxllcorner {ORIGIN_X}\nyllcorner {ORIGIN_Y}\ncellsize {CELL}\nNODATA_value {int(nodata)}\n"
    for r in range(ROWS - 1, -1, -1):
        asc += " ".join(f"{v:.4f}" for v in filled[r]) + "\n"
    with open(f"{OUT_DIR}/references/estonia-tava__bincell-dtm.asc", "w") as fh:
        fh.write(asc)

    # OLV fixture: Float32 x,y,z relative to the crop origin.
    rel = np.empty((xyz.shape[0], 3), dtype=np.float32)
    rel[:, 0] = (x - ORIGIN_X).astype(np.float32)
    rel[:, 1] = (y - ORIGIN_Y).astype(np.float32)
    rel[:, 2] = z.astype(np.float32)
    rel.tofile(f"{OUT_DIR}/crops/estonia-tava__ground.f32")

    crop = {
        "id": "estonia-tava",
        "dataset": "EST-ELB-TAVA-2020",
        "crs": {"horizontalEpsg": 3301, "name": "L-EST97 / Lambert Conformal Conic", "verticalDatum": "EH2000"},
        "originH1": ORIGIN_X, "originH2": ORIGIN_Y, "cols": COLS, "rows": ROWS, "cellSizeM": CELL,
        "groundPoints": int(xyz.shape[0]),
        "zMin": float(z.min()), "zMax": float(z.max()),
    }
    with open(f"{OUT_DIR}/crops/estonia-tava.crop.json", "w") as fh:
        json.dump(crop, fh, indent=2)
        fh.write("\n")

    covered = int(np.isfinite(grid).sum())
    print(f"estonia: {xyz.shape[0]} class-2 ground pts, {covered}/{COLS*ROWS} cells covered, z {z.min():.2f}-{z.max():.2f}")


if __name__ == "__main__":
    main()
