#!/usr/bin/env python3
"""Co-registration and change measurement for the Co-UDlabs Chassieu flight pair.

Reads the two LAS files, builds a common analysis grid, measures the epoch-to-epoch
alignment on stable ground outside the infiltration tank, then searches the tank
floor for surfaces that rose between the two flights. Writes the JSON records that
sit beside this script. Nothing here reads or writes any OpenLiDARViewer code path;
the point handling is laspy and the statistics are numpy and scipy.

Usage: run-change-pair.py <dataset-dir> <output-dir>
"""
import json
import sys
from pathlib import Path

import laspy
import numpy as np
from scipy import ndimage as ndi
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree

FINE = 0.05          # first-pass bin, halved again into the analysis cell
CELL = 0.10          # analysis cell, justified in README.md from measured density
ORIGIN_X, ORIGIN_Y = 852115.0, 6516819.0
NX, NY = 2060, 3330  # covers both epoch bounding boxes with a whole-metre origin
MIN_PTS = 4          # per cell per epoch
TANK_MAX_Z = 198.0   # epoch-1 min-Z below this is the tank bottom
OUTSIDE_MIN_Z = 200.5
FLAT_RANGE = 0.10    # within-cell relief for the stable hard-ground mask
RELIEF_WINDOW = 5    # 0.5 m, in analysis cells
MAX_FIT_CELLS = 250000


def bin_epoch(path):
    """Per-cell min-Z, max-Z, sum-Z, count and a near-nadir min-Z, at CELL."""
    nxf, nyf = NX * 2, NY * 2
    minz = np.full(nxf * nyf, np.inf)
    maxz = np.full(nxf * nyf, -np.inf)
    cnt = np.zeros(nxf * nyf, dtype=np.int32)
    sumz = np.zeros(nxf * nyf)
    with laspy.open(path) as f:
        for pts in f.chunk_iterator(8_000_000):
            x, y, z = np.asarray(pts.x), np.asarray(pts.y), np.asarray(pts.z)
            ix = np.floor((x - ORIGIN_X) / FINE).astype(np.int64)
            iy = np.floor((y - ORIGIN_Y) / FINE).astype(np.int64)
            ok = (ix >= 0) & (ix < nxf) & (iy >= 0) & (iy < nyf)
            idx = iy[ok] * nxf + ix[ok]
            zz = z[ok]
            np.minimum.at(minz, idx, zz)
            np.maximum.at(maxz, idx, zz)
            np.add.at(cnt, idx, 1)
            np.add.at(sumz, idx, zz)
    minz = minz.reshape(nyf, nxf)
    maxz = maxz.reshape(nyf, nxf)
    cnt = cnt.reshape(nyf, nxf)
    sumz = sumz.reshape(nyf, nxf)
    minz[cnt == 0] = np.nan
    maxz[cnt == 0] = np.nan
    r = lambda a: a.reshape(NY, 2, NX, 2)
    return dict(
        minz=np.nanmin(r(minz), axis=(1, 3)),
        maxz=np.nanmax(r(maxz), axis=(1, 3)),
        cnt=r(cnt).sum(axis=(1, 3)),
        sumz=r(sumz).sum(axis=(1, 3)),
        fine_occupied=int((cnt > 0).sum()),
        points=int(cnt.sum()),
        fine_cnt=cnt,
    )


def robust(v):
    med = float(np.median(v))
    return med, float(1.4826 * np.median(np.abs(v - med)))


def main():
    ds, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    e1 = bin_epoch(ds / "chassieu_vol1.las")
    e2 = bin_epoch(ds / "chassieu_vol2.las")

    z1, z2 = e1["minz"], e2["minz"]
    m1, m2 = e1["maxz"], e2["maxz"]
    c1, c2 = e1["cnt"], e2["cnt"]
    enough = (c1 >= MIN_PTS) & (c2 >= MIN_PTS)
    tank = enough & (z1 < TANK_MAX_Z)
    tank_all = z1 < TANK_MAX_Z
    outside = enough & (z1 >= OUTSIDE_MIN_Z)

    yy, xx = np.mgrid[0:NY, 0:NX]
    X = ORIGIN_X + (xx + 0.5) * CELL
    Y = ORIGIN_Y + (yy + 0.5) * CELL

    density = {}
    for tag, e in (("epoch1", e1), ("epoch2", e2)):
        area = e["fine_occupied"] * FINE * FINE
        density[tag] = dict(points=e["points"], coveredAreaM2=round(area, 1),
                            pointsPerM2=round(e["points"] / area, 1))
    both = enough
    density["analysisCell"] = CELL
    density["cellsBothEpochs"] = int(both.sum())
    density["medianPointsPerCellEpoch1"] = float(np.median(c1[both]))
    density["medianPointsPerCellEpoch2"] = float(np.median(c2[both]))

    # Why CELL is what it is: the sample a cell actually holds, at each candidate size.
    f1, f2 = e1["fine_cnt"], e2["fine_cnt"]
    table = []
    for k in (1, 2, 4, 5, 10, 20):
        size = round(FINE * k, 3)
        hh, ww = f1.shape[0] // k * k, f1.shape[1] // k * k
        agg = lambda a: a[:hh, :ww].reshape(hh // k, k, ww // k, k).sum(axis=(1, 3))
        a1, a2 = agg(f1), agg(f2)
        pair = (a1 > 0) & (a2 > 0)
        table.append(dict(
            cellM=size, cellsBothEpochs=int(pair.sum()),
            medianPointsPerCellEpoch1=float(np.median(a1[pair])),
            medianPointsPerCellEpoch2=float(np.median(a2[pair])),
            fractionWithAtLeast4InBoth=round(float(((a1 >= 4) & (a2 >= 4)).sum() / pair.sum()), 3),
            fractionWithAtLeast10InBoth=round(float(((a1 >= 10) & (a2 >= 10)).sum() / pair.sum()), 3)))
    density["cellSizeStudy"] = table
    del f1, f2, e1["fine_cnt"], e2["fine_cnt"]

    # ---- co-registration, measured on stable ground OUTSIDE the tank ----
    h1, h2 = m1 - z1, m2 - z2
    hard = outside & (h1 <= FLAT_RANGE) & (h2 <= FLAT_RANGE)
    dz_raw = z2 - z1
    mean1 = e1["sumz"] / np.maximum(c1, 1)
    mean2 = e2["sumz"] / np.maximum(c2, 1)

    med_min, nmad_min = robust(dz_raw[hard])
    med_mean, nmad_mean = robust((mean2 - mean1)[hard])

    A = np.c_[np.ones(int(hard.sum())), X[hard] - X.mean(), Y[hard] - Y.mean()]
    coef, *_ = np.linalg.lstsq(A, dz_raw[hard], rcond=None)
    resid = dz_raw[hard] - A @ coef
    _, nmad_plane = robust(resid)

    blk = int(round(25.0 / CELL))
    key = ((yy // blk) * 10000 + (xx // blk))[hard]
    vals = dz_raw[hard]
    block_meds = []
    for k in np.unique(key):
        s = key == k
        if s.sum() >= 200:
            block_meds.append(float(np.median(vals[s])))
    block_meds = np.array(block_meds)

    # horizontal shift: NMAD of the difference minimised over sub-cell shifts
    Zf = np.where(enough, z1, np.nan)
    msk = np.isfinite(Zf).astype(float)
    num = ndi.uniform_filter(np.where(np.isfinite(Zf), Zf, 0.0), 3)
    den = ndi.uniform_filter(msk, 3)
    filled = np.where(np.isfinite(Zf), Zf,
                      np.where(den > 0.3, num / np.maximum(den, 1e-9), np.nan))
    gy, gx = np.gradient(filled, CELL)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gy, gx)
    stable = enough & (z1 >= 199.0) & (h1 <= 0.30) & (h2 <= 0.30) & np.isfinite(slope)
    textured = np.flatnonzero(stable & (slope > np.radians(3)))
    # Deterministic selection. This pair yields fewer textured cells than the
    # cap, so every one is used; a larger set takes an even stride. The fit
    # below is order independent, so a permutation of the same set cannot move
    # the result.
    sel = (
        textured
        if textured.size <= MAX_FIT_CELLS
        else textured[:: max(1, textured.size // MAX_FIT_CELLS)][:MAX_FIT_CELLS]
    )
    row = (sel // NX).astype(float)
    col = (sel % NX).astype(float)
    z1s = z1.ravel()[sel]
    Z2 = np.where(enough, z2, np.nan)
    V = np.nan_to_num(Z2, nan=0.0)
    M = np.isfinite(Z2).astype(float)
    shifts = np.arange(-0.15, 0.1501, 0.025)
    valid = np.ones(sel.size, bool)
    for dx in shifts:
        for dy in shifts:
            valid &= map_coordinates(M, [row + dy / CELL, col + dx / CELL],
                                     order=1, mode="nearest") > 0.999
    row, col, z1s = row[valid], col[valid], z1s[valid]
    surface = {}
    best = None
    for dx in shifts:
        for dy in shifts:
            v = map_coordinates(V, [row + dy / CELL, col + dx / CELL],
                                order=1, mode="nearest")
            _, n = robust(v - z1s)
            surface[(round(float(dx), 3), round(float(dy), 3))] = n
            if best is None or n < best[0]:
                best = (n, float(dx), float(dy))

    def parabolic(axis):
        ys = [surface[(round(float(v), 3), round(best[2], 3))] if axis == 0
              else surface[(round(best[1], 3), round(float(v), 3))] for v in shifts]
        i = int(np.argmin(ys))
        if 0 < i < len(shifts) - 1:
            y0, y1, y2 = ys[i - 1], ys[i], ys[i + 1]
            return float(shifts[i] + (y0 - y2) / (2 * (y0 - 2 * y1 + y2)) * 0.025)
        return float(shifts[i])

    # Nuth and Kaeaeb, as an estimator that does not share the search above
    s = stable & (slope > np.radians(5)) & (slope < np.radians(45))
    dzs, sl, asp = dz_raw[s], slope[s], aspect[s]
    med0, nmad0 = robust(dzs)
    keep = np.abs(dzs - med0) < 3 * nmad0
    dzs, sl, asp = dzs[keep], sl[keep], asp[keep]
    y = dzs / np.tan(sl)
    edges = np.linspace(-np.pi, np.pi, 73)
    bi = np.digitize(asp, edges) - 1
    binned = np.array([np.median(y[bi == k]) for k in range(72)])
    centres = (edges[:-1] + edges[1:]) / 2
    B = np.c_[np.cos(centres), np.sin(centres), np.ones(72)]
    nk, *_ = np.linalg.lstsq(B, binned, rcond=None)
    nk_amp = float(np.hypot(nk[0], nk[1]))
    nk_dir = float(np.degrees(np.arctan2(nk[1], nk[0])))

    coreg = dict(
        stableGround=dict(
            definition=("epoch-1 min-Z >= %.1f m, within-cell relief <= %.2f m in both "
                        "epochs, >= %d points per cell per epoch" %
                        (OUTSIDE_MIN_Z, FLAT_RANGE, MIN_PTS)),
            cells=int(hard.sum()), areaM2=round(float(hard.sum()) * CELL * CELL, 1)),
        verticalOffsetM=dict(
            minZSurface=dict(median=round(med_min, 4), nmad=round(nmad_min, 4)),
            meanZSurface=dict(median=round(med_mean, 4), nmad=round(nmad_mean, 4))),
        tilt=dict(
            interceptM=round(float(coef[0]), 5),
            perMetreEast=float("%.6g" % coef[1]),
            perMetreNorth=float("%.6g" % coef[2]),
            magnitudeMmPerM=round(float(np.hypot(coef[1], coef[2]) * 1000), 4),
            acrossEastExtentMm=round(float(coef[1] * 205 * 1000), 2),
            acrossNorthExtentMm=round(float(coef[2] * 332 * 1000), 2),
            residualNmadM=round(nmad_plane, 4)),
        blockMediansM=dict(
            blockSizeM=25, blocks=int(block_meds.size),
            min=round(float(block_meds.min()), 4),
            p10=round(float(np.percentile(block_meds, 10)), 4),
            median=round(float(np.median(block_meds)), 4),
            p90=round(float(np.percentile(block_meds, 90)), 4),
            max=round(float(block_meds.max()), 4)),
        horizontalShiftM=dict(
            nmadSearch=dict(sampleCells=int(row.size),
                            gridBestEast=round(best[1], 4), gridBestNorth=round(best[2], 4),
                            subCellEast=round(parabolic(0), 4),
                            subCellNorth=round(parabolic(1), 4),
                            nmadAtBest=round(float(best[0]), 5),
                            nmadAtZeroShift=round(float(surface[(0.0, 0.0)]), 5)),
            nuthKaab=dict(cells=int(dzs.size), amplitudeM=round(nk_amp, 4),
                          directionDeg=round(nk_dir, 1),
                          eastM=round(-nk_amp * np.cos(np.radians(nk_dir)), 4),
                          northM=round(-nk_amp * np.sin(np.radians(nk_dir)), 4))),
        density=density)
    (outdir / "coregistration.json").write_text(json.dumps(coreg, indent=1) + "\n")

    # ---- change inside the tank ----
    plane = coef[0] + coef[1] * (X - X.mean()) + coef[2] * (Y - Y.mean())
    dD = np.where(enough, m2 - m1 - plane, np.nan)
    relief1 = (ndi.maximum_filter(np.where(enough, m1, -9e9), size=RELIEF_WINDOW)
               - ndi.minimum_filter(np.where(enough, z1, 9e9), size=RELIEF_WINDOW))
    absd = np.abs(np.nan_to_num(dD, nan=0.0))

    exclusions = dict(
        tankBottomM2=round(float(tank_all.sum()) * CELL * CELL, 1),
        keptWithEnoughPointsM2=round(float(tank.sum()) * CELL * CELL, 1),
        droppedSparseOrSingleEpochM2=round(float((tank_all & ~enough).sum()) * CELL * CELL, 1),
        searchableAtRelief035M2=round(float((tank & (relief1 <= 0.35)).sum()) * CELL * CELL, 1))
    bands = []
    for lo, hi in ((0, .15), (.15, .25), (.25, .35), (.35, .5), (.5, 1.), (1., 3.), (3., 99.)):
        b = tank & (relief1 >= lo) & (relief1 < hi)
        if b.sum() < 200:
            continue
        med, nmad = robust(dD[b])
        bands.append(dict(reliefLoM=lo, reliefHiM=hi,
                          areaM2=round(float(b.sum()) * CELL * CELL, 1),
                          medianM=round(med, 4), nmadM=round(nmad, 4),
                          fiveNmadM=round(5 * nmad, 3)))

    def candidates(base, sign, thr=0.10, min_cells=4, flat=0.60, ring_max=0.15, fill=0.45):
        v = sign * dD
        lab, n = ndi.label((v > thr) & enough & base)
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        boxes = ndi.find_objects(lab)
        found = []
        for i in range(1, n + 1):
            sz = sizes[i]
            if sz < min_cells or sz > 200:
                continue
            box = boxes[i - 1]
            sub = lab[box] == i
            hh, ww = sub.shape
            if sz / (hh * ww) < fill or max(hh, ww) / min(hh, ww) > 4:
                continue
            if np.nanmax(relief1[box][sub]) > flat:
                continue
            r0, c0 = box[0].start, box[1].start
            a0, a1 = max(0, r0 - 3), min(NY, r0 + hh + 3)
            b0, b1 = max(0, c0 - 3), min(NX, c0 + ww + 3)
            ring = np.ones((a1 - a0, b1 - b0), bool)
            ring[r0 - a0:r0 - a0 + hh, c0 - b0:c0 - b0 + ww] = False
            ring &= enough[a0:a1, b0:b1]
            if ring.sum() < 20 or np.percentile(absd[a0:a1, b0:b1][ring], 90) >= ring_max:
                continue
            vv = v[box][sub]
            found.append(dict(cells=int(sz),
                              E=round(ORIGIN_X + (c0 + ww / 2) * CELL, 3),
                              N=round(ORIGIN_Y + (r0 + hh / 2) * CELL, 3),
                              dsmMedianM=round(float(np.median(vv)), 3),
                              dsmMaxM=round(float(vv.max()), 3)))
        return found

    groups = [("tank-rise", tank, +1), ("tank-fall", tank, -1),
              ("outside-rise", outside, +1), ("outside-fall", outside, -1)]
    cand = []
    for name, base, sign in groups:
        for r in candidates(base, sign):
            r["group"] = name
            cand.append(r)

    # ---- point-level test on every candidate ----
    P = np.array([[r["E"], r["N"]] for r in cand])
    tree = cKDTree(P)
    buckets = {1: [[] for _ in cand], 2: [[] for _ in cand]}
    for epoch, name in ((1, "chassieu_vol1.las"), (2, "chassieu_vol2.las")):
        with laspy.open(ds / name) as f:
            for pts in f.chunk_iterator(6_000_000):
                x, y, z = np.asarray(pts.x), np.asarray(pts.y), np.asarray(pts.z)
                dist, idx = tree.query(np.c_[x, y], distance_upper_bound=1.4, workers=-1)
                ok = np.isfinite(dist)
                xi, yi, zi, ii = x[ok], y[ok], z[ok], idx[ok]
                order = np.argsort(ii, kind="stable")
                xi, yi, zi, ii = xi[order], yi[order], zi[order], ii[order]
                edge = np.searchsorted(ii, np.arange(len(cand) + 1))
                for k in range(len(cand)):
                    a, b = edge[k], edge[k + 1]
                    if b > a:
                        buckets[epoch][k].append(np.c_[xi[a:b], yi[a:b], zi[a:b]])

    def ground_plane(a, e, n):
        x, y, z = a[:, 0] - e, a[:, 1] - n, a[:, 2]
        r = np.hypot(x, y)
        ring = (r > 0.60) & (r < 1.35)
        if ring.sum() < 300:
            return None
        A_ = np.c_[np.ones(int(ring.sum())), x[ring], y[ring]]
        b_ = z[ring]
        co, *_ = np.linalg.lstsq(A_, b_, rcond=None)
        for _ in range(5):
            res = b_ - A_ @ co
            keep_ = res < np.percentile(res, 60)
            co, *_ = np.linalg.lstsq(A_[keep_], b_[keep_], rcond=None)
        res = b_ - A_ @ co
        return co, float(np.std(res[np.abs(res) < 0.15]))

    verified, confirmed = [], []
    for k, r in enumerate(cand):
        a1 = np.vstack(buckets[1][k]) if buckets[1][k] else np.zeros((0, 3))
        a2 = np.vstack(buckets[2][k]) if buckets[2][k] else np.zeros((0, 3))
        if len(a1) < 800 or len(a2) < 800:
            continue
        g1 = ground_plane(a1, r["E"], r["N"])
        g2 = ground_plane(a2, r["E"], r["N"])
        if g1 is None or g2 is None:
            continue
        (co1, rms1), (co2, rms2) = g1, g2
        def heights(a, co):
            x, y = a[:, 0] - r["E"], a[:, 1] - r["N"]
            return a[:, 2] - (co[0] + co[1] * x + co[2] * y), np.hypot(x, y)
        h1p, r1p = heights(a1, co1)
        h2p, r2p = heights(a2, co2)
        core1, core2 = r1p < 0.55, r2p < 0.55
        rec = dict(group=r["group"], E=r["E"], N=r["N"], cells=r["cells"],
                   groundRmsEpoch1M=round(rms1, 3), groundRmsEpoch2M=round(rms2, 3),
                   pointsAbove015Epoch1=int((h1p[core1] > 0.15).sum()),
                   pointsAbove015Epoch2=int((h2p[core2] > 0.15).sum()),
                   maxHeightEpoch1M=round(float(h1p[core1].max()), 3),
                   maxHeightEpoch2M=round(float(h2p[core2].max()), 3))
        verified.append(rec)
        sign = +1 if r["group"].endswith("rise") else -1
        before, after = ((rec["pointsAbove015Epoch1"], rec["pointsAbove015Epoch2"]) if sign > 0
                         else (rec["pointsAbove015Epoch2"], rec["pointsAbove015Epoch1"]))
        peak = rec["maxHeightEpoch2M"] if sign > 0 else rec["maxHeightEpoch1M"]
        if before <= 10 and after >= 60 and peak >= 0.18 and max(rms1, rms2) <= 0.06:
            # footprint and volume, both epochs referred to the SAME epoch-1 plane
            gx_, gy_ = a2[:, 0] - r["E"], a2[:, 1] - r["N"]
            h2c = a2[:, 2] - (co1[0] + co1[1] * gx_ + co1[2] * gy_)
            hx_, hy_ = a1[:, 0] - r["E"], a1[:, 1] - r["N"]
            h1c = a1[:, 2] - (co1[0] + co1[1] * hx_ + co1[2] * hy_)
            G, ext = 0.05, 0.8
            NB = int(2 * ext / G)
            def top(hx, hy, hz):
                ix = np.floor((hx + ext) / G).astype(int)
                iy = np.floor((hy + ext) / G).astype(int)
                ok = (ix >= 0) & (ix < NB) & (iy >= 0) & (iy < NB)
                out_ = np.full(NB * NB, -9.0)
                np.maximum.at(out_, iy[ok] * NB + ix[ok], hz[ok])
                return out_.reshape(NB, NB)
            t2, t1 = top(gx_, gy_, h2c), top(hx_, hy_, h1c)
            obj = (t2 > 0.10) & (t1 <= 0.08) & (t1 > -8)
            lb, nn = ndi.label(obj)
            if nn:
                cs = np.bincount(lb.ravel())
                cs[0] = 0
                obj = lb == int(np.argmax(cs))
            ys_, xs_ = np.nonzero(obj)
            rec = dict(rec)
            # A footprint is only meaningful for a surface that rose. A candidate in
            # the falling direction is kept in the record with nulls, because its
            # count is the false-positive measure and must not be quietly dropped.
            if sign > 0 and obj.sum():
                rec["footprintM2"] = round(float(obj.sum()) * G * G, 3)
                rec["bboxM"] = [round(float((xs_.max() - xs_.min() + 1) * G), 2),
                                round(float((ys_.max() - ys_.min() + 1) * G), 2)]
                rec["volumeM3"] = round(float(np.sum(np.clip(t2[obj], 0, None)
                                                     - np.clip(t1[obj], 0, None)) * G * G), 4)
            else:
                rec["footprintM2"] = None
                rec["bboxM"] = None
                rec["volumeM3"] = None
            confirmed.append(rec)

    counts = {}
    for name, _, _ in groups:
        counts[name] = dict(
            candidates=sum(1 for r in cand if r["group"] == name),
            pointVerified=sum(1 for r in verified if r["group"] == name),
            passing=sum(1 for r in confirmed if r["group"] == name))
    (outdir / "detections.json").write_text(json.dumps(dict(
        exclusions=exclusions, noiseByEpoch1Relief=bands, counts=counts,
        confirmed=confirmed), indent=1) + "\n")
    print(json.dumps(dict(coregistration=coreg, exclusions=exclusions,
                          counts=counts, confirmed=confirmed), indent=1))


if __name__ == "__main__":
    main()
