#!/usr/bin/env python3
"""
measure-antiochia-repeatability.py — how far apart two UAV flights over the same
ground put that ground.

Two OpenMMS/Livox flights of the Antiochia ad Cragum "small bath area"
(Zenodo 10.5281/zenodo.13864073, CC BY 4.0) were flown on 2022-07-07 sixteen
minutes apart, same sensor, same processing chain, independent trajectory
solutions. Where their swaths overlap the same ground is measured twice, so the
disagreement between the two surfaces bounds what a single flight can support.

This measures the capture. It says nothing about any viewer, and it is not an
accuracy figure: neither flight is truth.

Every heavy step runs in a tool this repository did not write:

  PDAL 2.10.2   crop, statistical outlier removal, SMRF ground classification,
                writers.gdal rasterisation
  GDAL 3.13.3   gdal_translate GeoTIFF -> AAIGrid for the raster cross-check
  laspy 2.7.0   LAZ decode (all three backends, compared against PDAL's)
  numpy/scipy   per-cell planar fits, statistics, morphology

Outputs (paths relative to the repository root):
  validation/repeatability/antiochia-flight/reference-runs.json  every external command
  validation/repeatability/antiochia-flight/results.json         the measured distribution
  validation/repeatability/antiochia-flight/comparable-cells.csv one row per compared cell

Reproduce:
  python3 scripts/repeatability/measure-antiochia-repeatability.py \
      <dataset-root> <work-dir>

  <dataset-root> holds first_half/ and second_half/ as unpacked from the Zenodo
  archive; <work-dir> is scratch space for the ~2 GB of intermediates and is not
  read back by anything else.
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

DATASET = Path(sys.argv[1]).resolve()
WORK = Path(sys.argv[2]).resolve()
OUT = Path("validation/repeatability/antiochia-flight")
WORK.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

# --- the comparison grid -----------------------------------------------------
# The bounding box the two flight headers share, snapped outward to whole metres.
OVERLAP = dict(minx=448603.156, maxx=448917.303, miny=4001034.882, maxy=4001418.011)
X0, Y0 = 448603.0, 4001034.0
CELL = 1.0
NX, NY = 315, 385

# --- the exclusion rule, fixed before the difference was looked at -----------
MIN_GROUND_PER_CELL = 10   # E1: each flight must determine the cell on its own
MAX_PLANE_RMS = 0.30       # E2: metres, each flight's ground must fit a plane
EROSION_CELLS = 2          # E3: metres of overlap edge dropped

# --- SMRF, sized for a wooded 15-33 degree hillside --------------------------
SMRF = dict(cell=1.0, window=18.0, slope=0.6, threshold=0.45, scalar=1.25)
OUTLIER = dict(method="statistical", mean_k=12, multiplier=2.5)

FLIGHTS = {"a": "first_half", "b": "second_half"}

runs = []


def redact(text):
    """No tracked file may name the machine this ran on."""
    return str(text).replace(str(DATASET), "<dataset>").replace(str(WORK), "<work>")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(run_id, kind, argv, outputs=()):
    proc = subprocess.run(argv, capture_output=True, text=True)
    rec = dict(
        runId=run_id,
        kind=kind,
        tool=Path(argv[0]).name,
        argv=[redact(a) for a in argv],
        commandLine=redact(" ".join(argv)),
        exitCode=proc.returncode,
        stderr=(proc.stderr.strip() or None),
        status="ok" if proc.returncode == 0 else "failed",
        outputs=[dict(path=redact(p), sha256=sha256(p)) for p in outputs if Path(p).exists()],
    )
    runs.append(rec)
    if proc.returncode != 0:
        raise SystemExit(f"{run_id} failed:\n{proc.stderr}")
    return rec


def write_pipeline(name, stages):
    path = OUT / "pipelines" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pipeline": stages}, indent=2) + "\n")
    return path


# --- 1. crop each flight to the shared bounding box --------------------------
bounds = f"([{OVERLAP['minx']},{OVERLAP['maxx']}],[{OVERLAP['miny']},{OVERLAP['maxy']}])"
for tag, half in FLIGHTS.items():
    src = DATASET / half / "flight_data" / "quick_pc.laz"
    dst = WORK / f"overlap-{tag}.laz"
    pipe = write_pipeline(
        f"crop-{tag}",
        [
            {"type": "readers.las", "filename": "<dataset>/%s/flight_data/quick_pc.laz" % half},
            {"type": "filters.crop", "bounds": bounds},
            {"type": "writers.las", "filename": "<work>/overlap-%s.laz" % tag, "compression": "true", "forward": "all"},
        ],
    )
    run(
        f"crop-{tag}",
        "crop",
        ["pdal", "translate", str(src), str(dst), "crop", f"--filters.crop.bounds={bounds}"],
        outputs=[dst],
    )
    runs[-1]["pipeline"] = str(pipe)

# --- 2. denoise and classify ground, each flight on its own ------------------
# The source files carry NumberOfReturns = 0 for every point, which is not a
# legal LAS value and makes filters.smrf refuse to run. Assigning
# NumberOfReturns = ReturnNumber makes every return its own last return, which
# is the same thing as telling SMRF to use all returns: it invents nothing,
# because the file never recorded a pulse's return count in the first place.
for tag in FLIGHTS:
    stages = [
        {"type": "readers.las", "filename": str(WORK / f"overlap-{tag}.laz")},
        {"type": "filters.assign", "value": "NumberOfReturns = ReturnNumber"},
        {"type": "filters.outlier", **OUTLIER},
        {"type": "filters.smrf", **SMRF, "ignore": "Classification[7:7]"},
        {"type": "writers.las", "filename": str(WORK / f"ground-{tag}.laz"), "compression": "true", "forward": "all"},
    ]
    real = WORK / f"smrf-{tag}.json"
    real.write_text(json.dumps({"pipeline": stages}, indent=2) + "\n")
    redacted = json.loads(redact(json.dumps({"pipeline": stages})))
    write_pipeline(f"ground-{tag}", redacted["pipeline"])
    run(f"ground-{tag}", "ground-classification", ["pdal", "pipeline", str(real)],
        outputs=[WORK / f"ground-{tag}.laz"])

# --- 3. an independent rasterisation of the same ground points ---------------
for tag in FLIGHTS:
    stages = [
        {"type": "readers.las", "filename": str(WORK / f"ground-{tag}.laz")},
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {
            "type": "writers.gdal", "filename": str(WORK / f"dtm-{tag}.tif"), "gdaldriver": "GTiff",
            "output_type": "mean,min,max,count", "resolution": CELL, "radius": 0.7072,
            "origin_x": X0, "origin_y": Y0, "width": NX, "height": NY,
            "nodata": -9999, "data_type": "double",
        },
    ]
    real = WORK / f"gdal-{tag}.json"
    real.write_text(json.dumps({"pipeline": stages}, indent=2) + "\n")
    write_pipeline(f"grid-{tag}", json.loads(redact(json.dumps({"pipeline": stages})))["pipeline"])
    run(f"grid-{tag}", "rasterise", ["pdal", "pipeline", str(real)], outputs=[WORK / f"dtm-{tag}.tif"])
    for band, name in ((3, "mean"), (4, "count")):
        asc = WORK / f"dtm-{tag}-{name}.asc"
        run(f"transcode-{tag}-{name}", "transcode",
            ["gdal_translate", "-q", "-of", "AAIGrid", "-b", str(band),
             "-co", "DECIMAL_PRECISION=6", str(WORK / f"dtm-{tag}.tif"), str(asc)],
            outputs=[asc])

# --- 4. decode, and check the decoders agree ---------------------------------
import laspy  # noqa: E402  (imported after the PDAL legs so a missing laspy fails late)

decode_check = {}
points = {}
for tag in FLIGHTS:
    fingerprints = {}
    for backend in (laspy.LazBackend.Laszip, laspy.LazBackend.Lazrs, laspy.LazBackend.LazrsParallel):
        with laspy.open(WORK / f"ground-{tag}.laz", laz_backend=backend) as fh:
            las = fh.read()
        raw = np.column_stack([
            np.asarray(las.X, dtype=np.int64), np.asarray(las.Y, dtype=np.int64),
            np.asarray(las.Z, dtype=np.int64), np.asarray(las.classification, dtype=np.int64),
        ])
        fingerprints[backend.name] = hashlib.sha256(np.ascontiguousarray(raw)).hexdigest()
        if backend is laspy.LazBackend.Laszip:
            cls = np.asarray(las.classification)
            keep = cls != 7
            points[tag] = dict(
                ground=np.column_stack([np.asarray(las.x)[cls == 2], np.asarray(las.y)[cls == 2],
                                        np.asarray(las.z)[cls == 2], np.asarray(las.gps_time)[cls == 2]]),
                nonnoise=np.column_stack([np.asarray(las.x)[keep], np.asarray(las.y)[keep], np.asarray(las.z)[keep]]),
                counts={int(k): int(v) for k, v in zip(*np.unique(cls, return_counts=True))},
                total=int(cls.size),
            )
    # laspy's three backends are not three implementations: LazrsParallel and
    # Lazrs are one Rust codebase threaded two ways, and WhiteboxTools decodes
    # LAZ through that same upstream, which is why it is not used here as a
    # second opinion on anything the decode touches. Laszip (C++) against Lazrs
    # (Rust) is the comparison that carries weight, and PDAL's own reader is a
    # fourth path checked below.
    stats = subprocess.run(
        ["pdal", "info", "--stats", "--dimensions", "X,Y,Z",
         str(WORK / f"ground-{tag}.laz")], capture_output=True, text=True)
    runs.append(dict(runId=f"decode-check-{tag}", kind="decode-cross-check", tool="pdal",
                     argv=["info", "--stats", "--dimensions", "X,Y,Z", f"<work>/ground-{tag}.laz"],
                     commandLine=f"pdal info --stats --dimensions X,Y,Z <work>/ground-{tag}.laz",
                     exitCode=stats.returncode, stderr=(stats.stderr.strip() or None),
                     status="ok" if stats.returncode == 0 else "failed", outputs=[]))
    pdal_stats = {s["name"]: s for s in json.loads(stats.stdout)["stats"]["statistic"]}
    with laspy.open(WORK / f"ground-{tag}.laz", laz_backend=laspy.LazBackend.Lazrs) as fh:
        las = fh.read()
    against_pdal = {}
    for name, values in (("X", np.asarray(las.x)), ("Y", np.asarray(las.y)), ("Z", np.asarray(las.z))):
        ref = pdal_stats[name]
        against_pdal[name] = dict(
            countMatches=int(ref["count"]) == values.size,
            minDelta=float(ref["minimum"] - values.min()),
            maxDelta=float(ref["maximum"] - values.max()),
        )
    decode_check[tag] = dict(
        laspyBackends=fingerprints,
        laspyBackendsIdentical=len(set(fingerprints.values())) == 1,
        pdalReaderVsLaspyLazrs=against_pdal,
    )

# --- 5. one plane per cell per flight, evaluated at the cell centre ----------
# The cell mean sits at the flight's own centroid inside the cell, not at the
# cell centre, so on a 30-degree slope two flights that sampled opposite halves
# of a cell differ by ~0.2 m for no reason but where their points landed. The
# plane removes that; `residual_rms` is what is left of each flight's own ground
# returns about it, and is the E2 test.
N = NX * NY


def cell_planes(xyz, cell=CELL):
    nx, ny = int(round(NX * CELL / cell)), int(round(NY * CELL / cell))
    n_cells = nx * ny
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    ix = np.clip(((x - X0) / cell).astype(np.int64), 0, nx - 1)
    iy = np.clip(((y - Y0) / cell).astype(np.int64), 0, ny - 1)
    k = iy * nx + ix
    u = x - (X0 + (ix + 0.5) * cell)
    v = y - (Y0 + (iy + 0.5) * cell)
    acc = lambda w: np.bincount(k, weights=w, minlength=n_cells)  # noqa: E731
    n = np.bincount(k, minlength=n_cells).astype(np.float64)
    su, sv, sz = acc(u), acc(v), acc(z)
    suu, suv, svv = acc(u * u), acc(u * v), acc(v * v)
    suz, svz, szz = acc(u * z), acc(v * z), acc(z * z)
    N = n_cells
    mat = np.empty((N, 3, 3))
    mat[:, 0] = np.stack([n, su, sv], 1)
    mat[:, 1] = np.stack([su, suu, suv], 1)
    mat[:, 2] = np.stack([sv, suv, svv], 1)
    rhs = np.stack([sz, suz, svz], 1)
    coef = np.full((N, 3), np.nan)
    solvable = n >= 6
    if solvable.any():
        sub, rsub = mat[solvable], rhs[solvable]
        ok = np.abs(np.linalg.det(sub)) > 1e-9
        sol = np.full((sub.shape[0], 3), np.nan)
        if ok.any():
            sol[ok] = np.linalg.solve(sub[ok], rsub[ok][..., None])[..., 0]
        coef[solvable] = sol
    sse = szz - np.nansum(coef * rhs, axis=1)
    rms = np.sqrt(np.maximum(sse, 0) / np.maximum(n, 1))
    rms[~np.isfinite(coef[:, 0])] = np.nan
    shape = (ny, nx)
    return dict(n=n.reshape(shape), z=coef[:, 0].reshape(shape),
                gx=coef[:, 1].reshape(shape), gy=coef[:, 2].reshape(shape),
                rms=rms.reshape(shape),
                mean=np.divide(sz, n, out=np.full(N, np.nan), where=n > 0).reshape(shape))


grids = {tag: cell_planes(points[tag]["ground"][:, :3]) for tag in FLIGHTS}

# A surface that owes nothing to SMRF: the 5th percentile of every non-noise
# return in the cell. If the ground filter were manufacturing the difference,
# this would not reproduce it.
low = {}
for tag in FLIGHTS:
    xyz = points[tag]["nonnoise"]
    ix = np.clip(((xyz[:, 0] - X0) / CELL).astype(np.int64), 0, NX - 1)
    iy = np.clip(((xyz[:, 1] - Y0) / CELL).astype(np.int64), 0, NY - 1)
    k = iy * NX + ix
    order = np.lexsort((xyz[:, 2], k))
    ks, zs = k[order], xyz[order, 2]
    start = np.searchsorted(ks, np.arange(N))
    count = np.searchsorted(ks, np.arange(N), side="right") - start
    out = np.full(N, np.nan)
    enough = count >= 10
    out[enough] = zs[start[enough] + (0.05 * (count[enough] - 1)).astype(np.int64)]
    low[tag] = out.reshape((NY, NX))

# --- 6. the exclusion rule ---------------------------------------------------
nA, nB = grids["a"]["n"], grids["b"]["n"]
dz = grids["b"]["z"] - grids["a"]["z"]
covered = (nA > 0) & (nB > 0)
e1 = covered & (nA >= MIN_GROUND_PER_CELL) & (nB >= MIN_GROUND_PER_CELL)
e2 = e1 & (grids["a"]["rms"] <= MAX_PLANE_RMS) & (grids["b"]["rms"] <= MAX_PLANE_RMS)
interior = ndimage.binary_erosion(covered, structure=np.ones((2 * EROSION_CELLS + 1,) * 2))
keep = e2 & interior & np.isfinite(dz)

exclusion = dict(
    gridCells=int(NX * NY),
    cellsWithGroundInA=int((nA > 0).sum()),
    cellsWithGroundInB=int((nB > 0).sum()),
    cellsCoveredByBoth=int(covered.sum()),
    removedByE1MinGroundReturns=int(covered.sum() - e1.sum()),
    removedByE2PlaneResidual=int(e1.sum() - e2.sum()),
    removedByE3OverlapEdge=int(e2.sum() - (e2 & interior).sum()),
    comparableCells=int(keep.sum()),
)


def distribution(values):
    v = np.asarray(values)
    v = v[np.isfinite(v)]
    p5, p50, p95 = np.percentile(v, [5, 50, 95])
    return dict(n=int(v.size), mean=float(v.mean()), median=float(np.median(v)),
                sd=float(v.std(ddof=1)), rms=float(np.sqrt((v ** 2).mean())),
                p5=float(p5), p50=float(p50), p95=float(p95),
                nmad=float(1.4826 * np.median(np.abs(v - np.median(v)))),
                min=float(v.min()), max=float(v.max()))


d = dz[keep]
gx = 0.5 * (grids["a"]["gx"] + grids["b"]["gx"])
gy = 0.5 * (grids["a"]["gy"] + grids["b"]["gy"])
slope = np.hypot(gx, gy)

results = dict(
    difference=distribution(d),
    differenceAboutItsMedian=distribution(d - np.median(d)),
    pointsPerCell=dict(
        flightA=dict(median=float(np.median(nA[keep])), p5=float(np.percentile(nA[keep], 5)),
                     p95=float(np.percentile(nA[keep], 95))),
        flightB=dict(median=float(np.median(nB[keep])), p5=float(np.percentile(nB[keep], 5)),
                     p95=float(np.percentile(nB[keep], 95))),
        groundReturnsPerCoveredSquareMetreA=float(nA[nA > 0].mean()),
        groundReturnsPerCoveredSquareMetreB=float(nB[nB > 0].mean()),
    ),
    terrain=dict(
        slopeMedian=float(np.median(slope[keep])),
        slopeP95=float(np.percentile(slope[keep], 95)),
        slopeMedianDegrees=float(np.degrees(np.arctan(np.median(slope[keep])))),
        slopeP95Degrees=float(np.degrees(np.arctan(np.percentile(slope[keep], 95)))),
    ),
)

# --- 7. is it a rigid offset? ------------------------------------------------
# z_b(p) = z_a(p + s) makes dz = s . grad(z), so a least-squares fit of dz on the
# terrain gradient reads off the horizontal shift directly, and the constant is
# the vertical one.
rng = np.random.default_rng(20220707)


def shift_fit(y, gxv, gyv, draws=2000):
    design = np.column_stack([np.ones(y.size), gxv, gyv])
    coef, *_ = np.linalg.lstsq(design, y, rcond=None)
    resid = y - design @ coef
    boot = np.array([np.linalg.lstsq(design[i], y[i], rcond=None)[0]
                     for i in (rng.integers(0, y.size, y.size) for _ in range(draws))])
    ci = lambda j: [float(np.percentile(boot[:, j], 2.5)), float(np.percentile(boot[:, j], 97.5))]  # noqa: E731
    return dict(
        vertical=float(coef[0]), verticalCi95=ci(0),
        shiftEast=float(coef[1]), shiftEastCi95=ci(1),
        shiftNorth=float(coef[2]), shiftNorthCi95=ci(2),
        shiftMagnitude=float(np.hypot(coef[1], coef[2])),
        r2=float(1 - resid.var() / y.var()), residualSd=float(resid.std(ddof=1)),
        corrWithDzDx=float(np.corrcoef(y, gxv)[0, 1]),
        corrWithDzDy=float(np.corrcoef(y, gyv)[0, 1]),
        corrWithSlope=float(np.corrcoef(y, np.hypot(gxv, gyv))[0, 1]),
    )


results["coregistration"] = dict(wholeField=shift_fit(d, gx[keep], gy[keep]))

# The whole-field fit cannot separate a horizontal shift from a long-wavelength
# vertical warp, because in a corridor this narrow the terrain gradient and the
# position along the corridor are the same variable. Subtracting a local median
# leaves only what varies faster than the window; a real planimetric offset
# survives that, a warp does not.
field = np.where(keep, dz, np.nan)
detrended = {}
for window in (9, 15, 25, 41):
    with np.errstate(invalid="ignore"):
        smooth = ndimage.generic_filter(field, np.nanmedian, size=window, mode="constant", cval=np.nan)
    local = (field - smooth)[keep]
    ok = np.isfinite(local)
    detrended[f"{window}m"] = dict(
        residual=distribution(local[ok]),
        fit=shift_fit(local[ok], gx[keep][ok], gy[keep][ok], draws=600),
    )
results["coregistration"]["afterLocalDetrend"] = detrended

# --- 8. controls -------------------------------------------------------------
# Same machinery, same ground, one flight: two passes over the same cell
# separated by a time gap. This is the floor the between-flight number must be
# read against.
def intra_flight(tag, min_gap=5.0):
    g = points[tag]["ground"]
    x, y, z, t = g[:, 0], g[:, 1], g[:, 2], g[:, 3]
    ix = np.clip(((x - X0) / CELL).astype(np.int64), 0, NX - 1)
    iy = np.clip(((y - Y0) / CELL).astype(np.int64), 0, NY - 1)
    k = iy * NX + ix
    order = np.lexsort((t, k))
    ks, ts = k[order], t[order]
    gap = np.r_[0.0, np.diff(ts)]
    gap[np.r_[True, ks[1:] != ks[:-1]]] = -1.0
    idx = np.arange(ks.size)
    widest = np.full(N, -1.0)
    at = np.full(N, -1, dtype=np.int64)
    asc = np.argsort(gap)
    widest[ks[asc]] = gap[asc]
    at[ks[asc]] = idx[asc]
    second = idx >= at[ks]
    usable = widest[ks] > min_gap
    halves = []
    for which in (False, True):
        sel = usable & (second == which)
        halves.append(cell_planes(np.column_stack([x[order][sel], y[order][sel], z[order][sel]])))
    first, later = halves
    ok = ((first["n"] >= MIN_GROUND_PER_CELL) & (later["n"] >= MIN_GROUND_PER_CELL)
          & (first["rms"] <= MAX_PLANE_RMS) & (later["rms"] <= MAX_PLANE_RMS)
          & np.isfinite(first["z"]) & np.isfinite(later["z"]))
    diff = (later["z"] - first["z"])[ok]
    gaps = widest.reshape((NY, NX))[ok]
    out = dict(all=distribution(diff), medianSeparationSeconds=float(np.median(gaps)), byGap={})
    for lo, hi in ((5, 90), (90, 200), (200, 400), (400, 800), (800, 2000)):
        band = (gaps >= lo) & (gaps < hi)
        if band.sum() >= 15:
            out["byGap"][f"{lo}-{hi}s"] = distribution(diff[band])
    return out


results["withinFlightControl"] = {tag: intra_flight(tag) for tag in FLIGHTS}

# Why 1.0 m and not finer: the same rules at other cell sizes, so the choice is
# on the record rather than asserted.
probe = {}
for cell in (0.25, 0.5, 1.0, 2.0):
    g = {tag: cell_planes(points[tag]["ground"][:, :3], cell) for tag in FLIGHTS}
    cov = (g["a"]["n"] > 0) & (g["b"]["n"] > 0)
    # E1 scaled by area so "10 returns in a square metre" means the same thing
    floor = max(6, int(round(MIN_GROUND_PER_CELL * cell * cell)))
    edge = int(round(EROSION_CELLS / cell))
    inside = ndimage.binary_erosion(cov, structure=np.ones((2 * edge + 1,) * 2))
    passing = (cov & (g["a"]["n"] >= floor) & (g["b"]["n"] >= floor)
               & (g["a"]["rms"] <= MAX_PLANE_RMS) & (g["b"]["rms"] <= MAX_PLANE_RMS)
               & inside & np.isfinite(g["b"]["z"] - g["a"]["z"]))
    probe[f"{cell}m"] = dict(
        cellsCoveredByBoth=int(cov.sum()),
        minGroundReturnsPerCell=floor,
        comparableCells=int(passing.sum()),
        medianGroundReturnsPerCoveredCellA=float(np.median(g["a"]["n"][cov])),
        medianGroundReturnsPerCoveredCellB=float(np.median(g["b"]["n"][cov])),
    )
results["cellSizeChoice"] = probe

# --- 9. does the answer depend on how the surface was made? ------------------
def asc_grid(path):
    return np.flipud(np.loadtxt(path, skiprows=6))


pdal_mean = {tag: asc_grid(WORK / f"dtm-{tag}-mean.asc") for tag in FLIGHTS}
alt = dict(
    pdalWritersGdalRadialMean=distribution((pdal_mean["b"] - pdal_mean["a"])[keep]),
    pointInCellMean=distribution((grids["b"]["mean"] - grids["a"]["mean"])[keep]),
    pointInCellPlaneAtCentre=results["difference"],
    fifthPercentileOfAllReturnsNoGroundFilter=distribution((low["b"] - low["a"])[keep]),
)
spread = np.array([alt[k]["sd"] for k in alt])
alt["sdRangeAcrossEstimators"] = float(spread.max() - spread.min())
results["surfaceEstimatorCrossCheck"] = alt
results["decodeCrossCheck"] = decode_check
results["classification"] = {tag: points[tag]["counts"] | {"total": points[tag]["total"]} for tag in FLIGHTS}

# --- 10. write it out --------------------------------------------------------
rows = np.argwhere(keep)
header = "row,col,easting,northing,z_a,z_b,dz,n_a,n_b,rms_a,rms_b,dzdx,dzdy"
lines = [header]
for r, c in rows:
    lines.append(",".join([
        str(int(r)), str(int(c)),
        f"{X0 + (c + 0.5) * CELL:.3f}", f"{Y0 + (r + 0.5) * CELL:.3f}",
        f"{grids['a']['z'][r, c]:.4f}", f"{grids['b']['z'][r, c]:.4f}", f"{dz[r, c]:.4f}",
        str(int(nA[r, c])), str(int(nB[r, c])),
        f"{grids['a']['rms'][r, c]:.4f}", f"{grids['b']['rms'][r, c]:.4f}",
        f"{gx[r, c]:.5f}", f"{gy[r, c]:.5f}",
    ]))
(OUT / "comparable-cells.csv").write_text("\n".join(lines) + "\n")

environment = dict(
    pdalVersion=subprocess.run(["pdal", "--version"], capture_output=True, text=True).stdout.strip(),
    pdalResolvedPath=os.path.realpath(shutil.which("pdal")),
    gdalTranslateVersion=subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True).stdout.strip(),
    gdalTranslateResolvedPath=os.path.realpath(shutil.which("gdal_translate")),
    python=platform.python_version(),
    laspy=laspy.__version__,
    numpy=np.__version__,
    scipy=__import__("scipy").__version__,
    containerPinning="not-executed",
    containerPinningReason=(
        "No containerised PDAL or GDAL was used; the resolved executable paths, the reported "
        "versions and the exact command lines stand in for an image digest."
    ),
    platform=platform.system().lower(),
    architecture=platform.machine(),
)

sources = {}
for tag, half in FLIGHTS.items():
    src = DATASET / half / "flight_data" / "quick_pc.laz"
    sources[tag] = dict(path=f"<dataset>/{half}/flight_data/quick_pc.laz", sha256=sha256(src))

json.dump(dict(
    generatedBy="scripts/repeatability/measure-antiochia-repeatability.py",
    reference="PDAL + GDAL + laspy/numpy/scipy",
    measures="capture repeatability between two independent UAV flights, not the accuracy of any implementation",
    environment=environment,
    sources=sources,
    grid=dict(cell=CELL, originX=X0, originY=Y0, width=NX, height=NY, epsg=32636,
              overlapBoundingBox=OVERLAP),
    parameters=dict(outlier=OUTLIER, smrf=SMRF,
                    writersGdal=dict(outputType="mean,min,max,count", resolution=CELL, radius=0.7072,
                                     nodata=-9999, dataType="double"),
                    exclusion=dict(minGroundReturnsPerCell=MIN_GROUND_PER_CELL,
                                   maxPlaneResidualRms=MAX_PLANE_RMS,
                                   overlapEdgeErosionCells=EROSION_CELLS)),
    runs=runs,
), open(OUT / "reference-runs.json", "w"), indent=2)

json.dump(dict(
    generatedBy="scripts/repeatability/measure-antiochia-repeatability.py",
    exclusion=exclusion,
    results=results,
), open(OUT / "results.json", "w"), indent=2)

print(json.dumps(dict(exclusion=exclusion, difference=results["difference"],
                      coregistration=results["coregistration"]), indent=2))
