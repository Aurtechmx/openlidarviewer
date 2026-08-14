#!/usr/bin/env python3
"""
coconino-required-tiles.py — derive the DETERMINISTIC tile set the Coconino
external-validation universe requires, straight from the frozen checkpoint table.

WHY THIS EXISTS. The Coconino study (validation/terrain-field/coconino/) freezes a
checkpoint universe as "a checkpoint is IN iff its Albers (E,N) falls inside a
downloaded tile's bounds". That rule is sound, but which tiles get downloaded was
not itself written down as a rule — leaving one unstated degree of freedom (a
tile could, in principle, be chosen by result). This script closes that gap: the
required tiles are a pure function of the frozen 121-checkpoint table and the
USGS 1 km Albers tiling the table already documents in its `tileScheme` field, so
"which tiles" is fixed by the checkpoints, not by anyone's choice.

TILE RULE (from the checkpoint table's tileScheme, verified against the committed
tile header bounds in input-universe.json): a checkpoint at Albers (E, N) belongs
to tile  w{ceil(-E/1000)}n{floor(N/1000)}  in EPSG:6350. Each tile spans
x in [-W*1000, -(W-1)*1000], y in [N*1000, (N+1)*1000].

It downloads nothing and validates nothing. It emits the manifest of tiles that
MUST be present to bring each checkpoint into the universe, so the path to a
larger N is a deterministic download list rather than a series of choices.

    python3 scripts/terrain-field/coconino-required-tiles.py
    python3 scripts/terrain-field/coconino-required-tiles.py --check   # CI: manifest matches

Emits validation/terrain-field/coconino/required-tiles.json (sorted, stable).
"""
import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECKPOINTS = ROOT / "validation/terrain-field/references/coconino-b19-2019__checkpoints.json"
UNIVERSE = ROOT / "validation/terrain-field/coconino/input-universe.json"
OUT = ROOT / "validation/terrain-field/coconino/required-tiles.json"

# The F7 preregistered sample-size gate (verify-field-study): a formal external
# vertical-accuracy statement needs at least this many usable checkpoints total
# and per stratum. Stated here so the manifest reports the gap, never hides it.
F7_MIN_TOTAL = 40
F7_MIN_PER_STRATUM = 12


def tile_for(albers_e: float, albers_n: float) -> str:
    """The USGS 1 km Albers tile a checkpoint falls in. See TILE RULE above."""
    w = math.ceil(-albers_e / 1000.0)
    n = math.floor(albers_n / 1000.0)
    return f"w{w}n{n}"


def build_manifest() -> dict:
    table = json.loads(CHECKPOINTS.read_text())
    checkpoints = table["checkpoints"]
    downloaded = set()
    if UNIVERSE.exists():
        downloaded = {t["tileId"] for t in json.loads(UNIVERSE.read_text()).get("downloadedTiles", [])}

    tiles: dict[str, dict] = {}
    for c in checkpoints:
        tid = tile_for(c["albersE"], c["albersN"])
        entry = tiles.setdefault(tid, {"tileId": tid, "checkpointIds": [], "nva": 0, "vva": 0})
        entry["checkpointIds"].append(c["id"])
        entry["nva" if c["type"] == "NVA" else "vva"] += 1
    for e in tiles.values():
        e["checkpointIds"].sort()
        e["downloaded"] = e["tileId"] in downloaded

    ordered = [tiles[t] for t in sorted(tiles)]
    present = [e for e in ordered if e["downloaded"]]
    covered_total = sum(len(e["checkpointIds"]) for e in present)
    covered_nva = sum(e["nva"] for e in present)
    covered_vva = sum(e["vva"] for e in present)

    return {
        "study": "Coconino B1 2019 external DTM validation — required-tile manifest",
        "derivedFrom": {
            "checkpointTable": "validation/terrain-field/references/coconino-b19-2019__checkpoints.json",
            "checkpointCount": len(checkpoints),
            "tileRule": "w{ceil(-albersE/1000)}n{floor(albersN/1000)} in EPSG:6350 (USGS 1 km Albers)",
            "note": "The required tiles are a pure function of the frozen checkpoint table and the tile rule. No tile is chosen; the checkpoints choose the tiles.",
        },
        "totals": {
            "requiredTiles": len(ordered),
            "checkpoints": len(checkpoints),
            "nva": sum(e["nva"] for e in ordered),
            "vva": sum(e["vva"] for e in ordered),
        },
        "coverageNow": {
            "downloadedTilesWithCheckpoints": len(present),
            "checkpointsCovered": covered_total,
            "nvaCovered": covered_nva,
            "vvaCovered": covered_vva,
        },
        "f7Gate": {
            "minTotal": F7_MIN_TOTAL,
            "minPerStratum": F7_MIN_PER_STRATUM,
            "totalMet": covered_total >= F7_MIN_TOTAL,
            "perStratumMet": covered_nva >= F7_MIN_PER_STRATUM and covered_vva >= F7_MIN_PER_STRATUM,
            "tilesStillNeededForMinTotal": max(0, F7_MIN_TOTAL - covered_total),
            "note": "One checkpoint per ~1 km tile, so total N and tile downloads (~70 MB each) rise together; closing F7 is a deterministic download, not a choice.",
        },
        "tiles": ordered,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the committed manifest is stale")
    a = ap.parse_args()
    manifest = build_manifest()
    text = json.dumps(manifest, indent=2) + "\n"
    if a.check:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"required-tiles.json is stale; re-run {Path(__file__).name}", file=sys.stderr)
            return 1
        print("required-tiles.json is current.")
        return 0
    OUT.write_text(text)
    t = manifest["totals"]
    c = manifest["coverageNow"]
    print(
        f"wrote {OUT.relative_to(ROOT)} — {t['requiredTiles']} required tiles for "
        f"{t['checkpoints']} checkpoints ({t['nva']} NVA / {t['vva']} VVA); "
        f"covered now: {c['checkpointsCovered']} ({c['nvaCovered']} NVA / {c['vvaCovered']} VVA)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
