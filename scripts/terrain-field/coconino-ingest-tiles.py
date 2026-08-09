#!/usr/bin/env python3
"""
coconino-ingest-tiles.py — fetch Coconino B1 2019 LiDAR tiles and rebuild the
external-validation universe, deterministically and reproducibly.

WHAT IT DOES (and does NOT do):
  1. Downloads the requested USGS 3DEP tiles (public domain) into a cache dir,
     resumable — a tile already present with the right size is not re-fetched.
  2. Runs the committed generate-coconino-reference.py over ALL cached tiles to
     rebuild crops/coconino__ground.f32 + references/coconino__matched.json.
  3. Rebuilds coconino/input-universe.json: per-tile bounds + sha256 + point
     count from the LAZ headers, the matched checkpoints (exactly those the
     generator kept), and a RE-EVALUATED evidence determination — F7 (sample
     size) recomputed from the new N, F10 (preregistration) unchanged because
     found third-party checkpoints can never satisfy it.

  It computes NO residuals and asserts NO accuracy. The residual metrics come
  from tests/coconinoCheckpoints.test.ts (OLV's production rasterizeDtm), the
  single authoritative source, run after this ingest.

WHICH TILES. By default, the deterministic set that brings the universe to the
F7 minimum (n>=40, >=12 per stratum): the tiles already in input-universe.json
plus the id-ordered next tiles from coconino-required-tiles.json until the gate
is met. `--all` fetches every required tile (the full 121-checkpoint universe).
The selection is RESULT-BLIND (residuals are unknown at download time), so it is
not a cherry-pick.

    python3 scripts/terrain-field/coconino-ingest-tiles.py            # to n>=40
    python3 scripts/terrain-field/coconino-ingest-tiles.py --all      # full universe
    python3 scripts/terrain-field/coconino-ingest-tiles.py --plan     # print tiles, fetch nothing

Requires: laspy[lazrs], numpy. Cache dir: $COCONINO_TILE_CACHE or ./_coconino_tiles.
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GEN = ROOT / "scripts/terrain-field/generate-coconino-reference.py"
REQUIRED = ROOT / "validation/terrain-field/coconino/required-tiles.json"
UNIVERSE = ROOT / "validation/terrain-field/coconino/input-universe.json"
CHECKPOINTS = ROOT / "validation/terrain-field/references/coconino-b19-2019__checkpoints.json"
MATCHED = ROOT / "validation/terrain-field/references/coconino__matched.json"
CACHE = Path(os.environ.get("COCONINO_TILE_CACHE", ROOT / "_coconino_tiles"))

BASE_URL = ("https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/"
            "Projects/AZ_Coconino_2019_B19/AZ_Coconino_B1_2019/LAZ/")
TILE_FILE = "USGS_LPC_AZ_Coconino_2019_B19_{tile}.laz"

F7_MIN_TOTAL = 40
F7_MIN_PER_STRATUM = 12
F10_REASON = (
    "PREREGISTRATION (verify-field-study F10): the USGS Coconino survey is 2019; an OLV "
    "protocol registers 2026, so registeredAt > fieldwork.startedAt. Found third-party "
    "checkpoints cannot satisfy the repo's E5 preregistration bar, which requires the "
    "checkpoint survey to be frozen against the protocol before fieldwork."
)


def f7_reason(n, nva, vva):
    return (f"SAMPLE SIZE (verify-field-study F7): {n} usable checkpoints ({nva} NVA, {vva} VVA) "
            f"is below the {F7_MIN_TOTAL}-total / {F7_MIN_PER_STRATUM}-per-stratum minimum, and "
            f"below the USGS/ASPRS >=20-NVA standard for a formal vertical-accuracy statement.")


def target_tiles(want_all):
    req = json.loads(REQUIRED.read_text())
    tiles = req["tiles"]  # sorted by id, each with tileId, checkpointIds, nva, vva, downloaded
    if want_all:
        return [t["tileId"] for t in tiles]
    # already-downloaded + id-ordered next until F7 gate met
    have = [t for t in tiles if t["downloaded"]]
    n = sum(len(t["checkpointIds"]) for t in have)
    nva = sum(t["nva"] for t in have); vva = sum(t["vva"] for t in have)
    chosen = [t["tileId"] for t in have]
    for t in tiles:
        if t["downloaded"]:
            continue
        if n >= F7_MIN_TOTAL and nva >= F7_MIN_PER_STRATUM and vva >= F7_MIN_PER_STRATUM:
            break
        chosen.append(t["tileId"]); n += len(t["checkpointIds"]); nva += t["nva"]; vva += t["vva"]
    return chosen


def fetch(tile):
    CACHE.mkdir(parents=True, exist_ok=True)
    url = BASE_URL + TILE_FILE.format(tile=tile)
    dst = CACHE / TILE_FILE.format(tile=tile)
    with urllib.request.urlopen(url) as r:
        remote = int(r.headers.get("content-length", 0))
        if dst.exists() and dst.stat().st_size == remote and remote > 0:
            return dst  # resumable: already complete
        tmp = dst.with_suffix(".part")
        with open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.replace(dst)
    return dst


def rebuild_universe(cached_tiles):
    import numpy as np  # noqa: F401  (laspy pulls numpy; kept explicit)
    import laspy

    table = json.loads(CHECKPOINTS.read_text())
    cps = table["checkpoints"]
    prev = json.loads(UNIVERSE.read_text())
    matched_ids = {c["id"] for c in json.loads(MATCHED.read_text())["checkpoints"]}

    downloaded = []
    for p in sorted(cached_tiles):
        h = laspy.read(str(p)).header
        tile = p.stem.replace("USGS_LPC_AZ_Coconino_2019_B19_", "")
        downloaded.append({
            "file": p.name, "tileId": tile,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "bytes": p.stat().st_size, "pointCount": int(h.point_count),
            "boundsAlbers": {"xmin": float(h.mins[0]), "xmax": float(h.maxs[0]),
                             "ymin": float(h.mins[1]), "ymax": float(h.maxs[1]),
                             "zmin": float(h.mins[2]), "zmax": float(h.maxs[2])},
            "crs": "NAD83(2011) / Conus Albers + NAVD88 height - Geoid12B (metre)",
        })

    # matched = exactly those the generator kept (in-bounds AND had class-2 ground)
    id_to_tile = {}
    for t in downloaded:
        b = t["boundsAlbers"]
        for c in cps:
            if b["xmin"] <= c["albersE"] <= b["xmax"] and b["ymin"] <= c["albersN"] <= b["ymax"]:
                id_to_tile[c["id"]] = t
    matched = [dict(c, tile=id_to_tile[c["id"]]["tileId"], tileFile=id_to_tile[c["id"]]["file"])
               for c in cps if c["id"] in matched_ids and c["id"] in id_to_tile]
    n = len(matched)
    nva = sum(1 for c in matched if c["type"] == "NVA")
    vva = n - nva

    f7_met = n >= F7_MIN_TOTAL and nva >= F7_MIN_PER_STRATUM and vva >= F7_MIN_PER_STRATUM
    reasons = [F10_REASON] + ([] if f7_met else [f7_reason(n, nva, vva)])

    prev.update({
        "downloadedTiles": downloaded,
        "matchedCheckpointCount": n,
        "matchedCheckpoints": matched,
    })
    prev["evidenceDetermination"] = {
        "achievedLevel": prev["evidenceDetermination"]["achievedLevel"],
        "e5Reached": False,  # F10 unmet; found checkpoints cannot preregister
        "limitingReasons": reasons,
        "confounders": {"sharedSolutionWithReference": False, "checkpointLeakage": False},
        "conclusion": (f"External checkpoint agreement over {n} independent USGS checkpoints "
                       f"({nva} NVA, {vva} VVA). "
                       + ("F7 sample size met; " if f7_met else "F7 not yet met; ")
                       + "E5 still blocked by F10 (found checkpoints cannot be preregistered). "
                       "DTM stays E3 pending the tier decision. Residual metrics: see the test."),
    }
    UNIVERSE.write_text(json.dumps(prev, indent=1) + "\n")
    return n, nva, vva, f7_met


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="fetch every required tile (full universe)")
    ap.add_argument("--plan", action="store_true", help="print the tile list and exit; fetch nothing")
    a = ap.parse_args()

    tiles = target_tiles(a.all)
    print(f"target: {len(tiles)} tiles -> {BASE_URL}", file=sys.stderr)
    if a.plan:
        for t in tiles:
            print(TILE_FILE.format(tile=t))
        return 0

    cached = []
    for i, t in enumerate(tiles, 1):
        p = fetch(t)
        cached.append(p)
        print(f"[{i}/{len(tiles)}] {p.name} ({p.stat().st_size/1e6:.1f} MB)", file=sys.stderr)

    print("regenerating crop + matched.json ...", file=sys.stderr)
    subprocess.run([sys.executable, str(GEN), *[str(p) for p in cached]], check=True)

    n, nva, vva, f7 = rebuild_universe(cached)
    print(f"universe rebuilt: n={n} (NVA={nva}, VVA={vva}); F7 {'MET' if f7 else 'NOT met'}; "
          f"E5 still blocked by F10.", file=sys.stderr)
    print("NEXT: `npx vitest run tests/coconinoCheckpoints.test.ts` for the residual metrics.",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
