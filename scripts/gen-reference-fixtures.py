#!/usr/bin/env python3
"""gen-reference-fixtures.py — emit an independent CRS reference table via pyproj.

Roadmap item P1 #9 (docs/architecture/coordinate-integrity-roadmap.md): the UTM
projection maths is checked for internal self-consistency (round trips, Snyder
anchors) but NOT against a second, independent implementation in a committed,
reproducible fixture. This script produces that fixture from PROJ (via pyproj),
so tests/referenceFixtures.test.ts can assert the viewer's transforms agree with
an implementation the viewer did not write.

Two viewer transform paths are exercised, and each fixture records which one and
how its reference was produced:

  path 'vendored-utm'  — src/geo/UtmConverter.ts, the hand-written Transverse
      Mercator series. Reference produced from PROJ AUTHORITY codes
      (EPSG:4326 -> EPSG:326zz / 327zz). Both sides are WGS84, so there is no
      datum operation: this is a pure projection cross-check, and the two
      implementations share no code and no definition source. This is the
      headline P1 #9 leg.

  path 'proj4-engine'  — src/convert/reproject.ts, which resolves an EPSG code
      to a proj4 definition string (src/convert/epsg.ts) and delegates the
      transform to proj4js. Two reference methods appear here:
        - 'pyproj-authority' (EPSG:3857): WGS84 -> WGS84 Pseudo-Mercator, no
          datum change, so PROJ's authority definition is compared directly.
        - 'pyproj-projstring' (EPSG:27700, 2154): the viewer's OWN proj4 string
          is fed to BOTH sides (proj4js at runtime, PROJ here via from_proj4).
          This holds the datum model identical on both sides and isolates the
          question the viewer can actually get wrong: are the curated projection
          PARAMETERS (false easting/northing, standard parallels, k0, ellipsoid)
          correct? It is deliberately NOT a datum-realization test — comparing a
          finite Helmert against PROJ's grid-shifted authority definition would
          differ by up to ~1 m for OSGB36 and that is not a viewer bug.

Metric: horizontal deviation, in metres, between the viewer's easting/northing
and the reference easting/northing (hypot of the two component deltas). Gate is
< 1 mm; see the test.

Each fixture carries BOTH directions of the reference, and the inverse must be
PROJ's own inverse of the committed easting/northing rather than the original
lon/lat. For an exactly invertible transform (UTM, Web Mercator) the two are the
same. For a CRS whose datum leg is a 7-parameter Helmert (EPSG:27700), the
position-vector Helmert with finite rotations is NOT exactly invertible by
negating its parameters, so PROJ's own forward->inverse does not return the input
(about 0.8 mm at UK latitudes). Comparing the viewer's inverse to PROJ's inverse
of the SAME easting/northing keeps the leg a like-for-like cross-implementation
check; comparing it to the original lon/lat would instead measure that shared
non-closure and attribute it to the viewer.

Regenerate:
    pip install pyproj
    python3 scripts/gen-reference-fixtures.py
This overwrites validation/cross-implementation/crs-reference/proj-reference.json.
The output pins the pyproj and PROJ versions it was produced with; a reader can
reproduce the same numbers by installing that PROJ. The committed JSON is the
artifact the test reads — pyproj is NOT required to run the test.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import sys

try:
    import pyproj
    from pyproj import CRS, Transformer
except ImportError:  # pragma: no cover - operator guidance, not test path
    sys.stderr.write(
        "pyproj is not installed. Run `pip install pyproj` and retry. The test\n"
        "reads the committed JSON and does not need pyproj; only regeneration does.\n"
    )
    raise SystemExit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(
    ROOT, "validation", "cross-implementation", "crs-reference", "proj-reference.json"
)

# proj4 definition strings copied verbatim from src/convert/epsg.ts so the
# 'pyproj-projstring' leg feeds PROJ the exact string proj4js resolves at
# runtime. If epsg.ts changes one of these, this table must be regenerated.
WGS84_LONGLAT = "+proj=longlat +datum=WGS84 +no_defs"  # epsgToProj4(4326)
PROJSTRING_DEFS = {
    # British National Grid (OSGB36 7-parameter Helmert). src/convert/epsg.ts.
    27700: (
        "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 "
        "+y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,"
        "0.247,0.842,-20.489 +units=m +no_defs"
    ),
    # RGF93 / Lambert-93 (France). src/convert/epsg.ts.
    2154: (
        "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 "
        "+y_0=6600000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs"
    ),
}


def central_meridian(zone: int) -> float:
    return (zone - 1) * 6 - 180 + 3


# ── the point set ────────────────────────────────────────────────────────────
# lon/lat chosen within ~3 deg of each zone's central meridian so the vendored
# converter's grid-range gate (100 000-900 000 m easting) accepts them; a
# refusal is not a projection error and would only muddy the comparison.

# path='vendored-utm': {id, epsg, category, lon, lat}
UTM_POINTS = [
    # UTM zone 12N central-meridian anchors (easting == false easting, N == 0).
    dict(id="utm12n-cm-equator", epsg=32612, category="central-meridian",
         lon=central_meridian(12), lat=0.0),
    dict(id="utm12n-tucson", epsg=32612, category="utm-north",
         lon=-110.9747, lat=32.2226),
    dict(id="utm12n-high-lat-north", epsg=32612, category="high-latitude",
         lon=-111.0, lat=80.0),
    # More northern zones, spread across the meridian range incl. antimeridian.
    dict(id="utm18n-nyc", epsg=32618, category="utm-north",
         lon=-73.5, lat=40.5),
    dict(id="utm33n-berlin", epsg=32633, category="utm-north",
         lon=13.4050, lat=52.5200),
    dict(id="utm01n-antimeridian", epsg=32601, category="utm-north",
         lon=-178.0, lat=10.0),
    dict(id="utm60n-antimeridian", epsg=32660, category="utm-north",
         lon=178.0, lat=60.0),
    # Explicit zone-edge pair: the SAME geographic point at the 12/13 boundary
    # (lon -108) projected into each adjacent zone. ~3 deg off each meridian.
    dict(id="edge-12-13-in-zone12", epsg=32612, category="zone-edge",
         lon=-108.0, lat=45.0),
    dict(id="edge-12-13-in-zone13", epsg=32613, category="zone-edge",
         lon=-108.0, lat=45.0),
    # Southern hemisphere.
    dict(id="utm56s-sydney", epsg=32756, category="utm-south",
         lon=151.2093, lat=-33.8688),
    dict(id="utm19s-lapaz", epsg=32719, category="utm-south",
         lon=-68.15, lat=-16.5),
    dict(id="utm34s-capetown", epsg=32734, category="utm-south",
         lon=18.4241, lat=-33.9249),
    dict(id="utm34s-high-lat-south", epsg=32734, category="high-latitude",
         lon=21.0, lat=-80.0),
    # Equator-straddle: a southern-zone code used just NORTH of the equator, so
    # the grid northing legitimately exceeds 10 000 000 (the overlap the gate
    # allows). Exercises the false-northing + overlap handling on both sides.
    dict(id="utm33s-equator-straddle", epsg=32733, category="equator-straddle",
         lon=15.0, lat=0.5),
]

# path='proj4-engine': {id, epsg, category, lon, lat, reference}
PROJECTED_POINTS = [
    # Web Mercator — authority reference, datum-clean.
    dict(id="webmerc-origin", epsg=3857, category="web-mercator",
         lon=0.0, lat=0.0, reference="pyproj-authority"),
    dict(id="webmerc-london", epsg=3857, category="web-mercator",
         lon=-0.1278, lat=51.5074, reference="pyproj-authority"),
    dict(id="webmerc-sydney", epsg=3857, category="web-mercator",
         lon=151.2093, lat=-33.8688, reference="pyproj-authority"),
    dict(id="webmerc-high-lat", epsg=3857, category="web-mercator",
         lon=10.0, lat=80.0, reference="pyproj-authority"),
    # National grids — projstring reference (same def string both sides).
    dict(id="bng-london", epsg=27700, category="national-grid-tmerc",
         lon=-0.1278, lat=51.5074, reference="pyproj-projstring"),
    dict(id="bng-edinburgh", epsg=27700, category="national-grid-tmerc",
         lon=-3.1883, lat=55.9533, reference="pyproj-projstring"),
    dict(id="lambert93-paris", epsg=2154, category="national-grid-lcc",
         lon=2.3522, lat=48.8566, reference="pyproj-projstring"),
    dict(id="lambert93-marseille", epsg=2154, category="national-grid-lcc",
         lon=5.3698, lat=43.2965, reference="pyproj-projstring"),
]


def transformers_authority(epsg: int) -> tuple[Transformer, Transformer]:
    """Forward (4326 -> epsg) and inverse (epsg -> 4326), authority codes."""
    fwd = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    inv = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    return fwd, inv


def transformers_projstring(epsg: int) -> tuple[Transformer, Transformer]:
    """Forward / inverse using the viewer's own proj4 string on both sides."""
    ll = CRS.from_proj4(WGS84_LONGLAT)
    grid = CRS.from_proj4(PROJSTRING_DEFS[epsg])
    fwd = Transformer.from_crs(ll, grid, always_xy=True)
    inv = Transformer.from_crs(grid, ll, always_xy=True)
    return fwd, inv


def build() -> dict:
    fixtures = []

    for p in UTM_POINTS:
        fwd, inv = transformers_authority(p["epsg"])
        e, n = fwd.transform(p["lon"], p["lat"])
        inv_lon, inv_lat = inv.transform(e, n)
        fixtures.append({
            "id": p["id"],
            "path": "vendored-utm",
            "category": p["category"],
            "epsg": p["epsg"],
            "sourceCrs": "EPSG:4326",
            "referenceCrs": f"EPSG:{p['epsg']}",
            "reference": "pyproj-authority",
            "lon": p["lon"],
            "lat": p["lat"],
            "easting": e,
            "northing": n,
            # PROJ's own inverse of the E/N above — the reference the inverse leg
            # compares against (equals lon/lat here, since UTM is invertible).
            "invLon": inv_lon,
            "invLat": inv_lat,
        })

    for p in PROJECTED_POINTS:
        if p["reference"] == "pyproj-authority":
            fwd, inv = transformers_authority(p["epsg"])
            ref_crs = f"EPSG:{p['epsg']}"
            src_crs = "EPSG:4326"
        else:
            fwd, inv = transformers_projstring(p["epsg"])
            ref_crs = PROJSTRING_DEFS[p["epsg"]]
            src_crs = WGS84_LONGLAT
        e, n = fwd.transform(p["lon"], p["lat"])
        inv_lon, inv_lat = inv.transform(e, n)
        fixtures.append({
            "id": p["id"],
            "path": "proj4-engine",
            "category": p["category"],
            "epsg": p["epsg"],
            "sourceCrs": src_crs,
            "referenceCrs": ref_crs,
            "reference": p["reference"],
            "lon": p["lon"],
            "lat": p["lat"],
            "easting": e,
            "northing": n,
            "invLon": inv_lon,
            "invLat": inv_lat,
        })

    return {
        "provenance": {
            "generator": "scripts/gen-reference-fixtures.py",
            "roadmapItem": "P1 #9 (docs/architecture/coordinate-integrity-roadmap.md)",
            "referenceImplementation": "PROJ via pyproj",
            "pyprojVersion": pyproj.__version__,
            "projVersion": pyproj.proj_version_str,
            "generatedAtUtc": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat(),
            "metric": "horizontal deviation in metres (hypot of easting/northing deltas)",
            "toleranceMm": 1.0,
            "methods": {
                "pyproj-authority": "PROJ EPSG authority definition; WGS84 source, no datum operation.",
                "pyproj-projstring": "viewer's own proj4 def string (src/convert/epsg.ts) fed to PROJ; holds the datum model identical on both sides, checks curated projection parameters, not datum realization.",
            },
        },
        "fixtures": fixtures,
    }


def main() -> None:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = build()
    # Sanity: no non-finite reference value should ever be committed.
    for f in data["fixtures"]:
        for k in ("easting", "northing", "lon", "lat", "invLon", "invLat"):
            if not math.isfinite(f[k]):
                raise SystemExit(f"non-finite {k} in fixture {f['id']}")
    with open(OUT, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print(
        f"wrote {len(data['fixtures'])} fixtures to {os.path.relpath(OUT, ROOT)} "
        f"(pyproj {pyproj.__version__}, PROJ {pyproj.proj_version_str})"
    )


if __name__ == "__main__":
    main()
