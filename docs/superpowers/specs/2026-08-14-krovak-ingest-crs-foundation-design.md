# SP1 — Ingest & CRS Foundation (Krovák + iPhone PDRF7 + universal footprint reprojection)

Date: 2026-08-14
Status: design, awaiting review
Part of: v0.6.6 scanner-comparison evidence program (SP1 of SP1–SP4)

## Purpose

Make OLV open the four real scanner-comparison scans (Zenodo DOI 10.5281/zenodo.15421291 — Trimble TX8 TLS, GeoSLAM ZEB Horizon, iPhone 14 Pro, mapry LA03) correctly: right CRS, right units, right coordinates, colours rendered, and a footprint that exports. All four are georeferenced to EPSG:5514 (S-JTSK / Krovák East-North), a non-UTM projected CRS that OLV does not currently resolve. This is a standalone v0.6.6 win ("iphone/laz support better") and the prerequisite for the SP2 sphere-accuracy study, SP3 diameter-vs-DBH, and SP4 cross-instrument terrain.

Out of scope: E57 (not in this dataset), any evidence-grade promotion (SP2+), automated tree/sphere detection.

## Background facts (verified from the data)

- Four `.laz` files, all EPSG:5514, co-registered over one forest plot. TLS 345M pts (PDRF2 v1.2), ZEB 141M, LA03 31M, iPhone 2.2M (PDRF7 v1.4, mm scale).
- Coordinates are negative (X≈−744k, Y≈−1036k) because 5514 negates Krovák's native south/west axes to present East/North. Axis sign is the critical correctness point.
- The GroundTruth workbook gives 16 surveyed reference spheres with exact EPSG:5514 coordinates — a built-in oracle to validate the CRS math against.

## Current-state findings (verified in code)

- `src/geo/CrsRegistry.ts` — no EPSG:5514 entry; `CrsRegistryEntry = { epsg, kind: 'projected'|'geographic', … }`.
- `src/convert/epsg.ts` `epsgToProj4(epsg)` — a `STATIC_DEFS` map plus parametric UTM/MGA ranges; returns `null` for Krovák.
- `src/export/lonLatMapper.ts` `makeLocalToLonLat` — reprojects via `utmConverter.toGeographic(...)`, which is UTM-only, so a non-UTM projected CRS cannot export a footprint (the v0.6.6 KML gap).
- EPT/streaming decode already supports PDRF 6–8; the local-LAZ decode path for PDRF7 v1.4 must be confirmed.

## Design

Four components, each independently testable.

### C1 — Krovák in the CRS registry

Add EPSG:5514 (S-JTSK / Krovák East-North) as a projected `CrsRegistryEntry`, linear unit metre. This lets the Inspector resolve the scans by name and makes the resolved-CRS authority (already the system's source of truth) describe them correctly. Interface: unchanged; one new entry. Dependency: none.

### C2 — Krovák proj4 definition

Add EPSG:5514 to `STATIC_DEFS` in `epsgToProj4` with the standard Krovák-East-North proj4 string (`+proj=krovak … +ellps=bessel +towgs84=589,76,480,0,0,0,0`, with the axis handling that yields the negated East-North coordinates). proj4 is already shipped and used in `src/convert/reproject.ts`. Correctness is validated against the surveyed sphere coordinates (C5): reprojecting a sphere's 5514 coordinate to WGS84 and back must round-trip, and forward agreement with an independent tool (proj/GDAL `cs2cs`) is the cross-check. Dependency: C1 (entry exists to resolve).

### C3 — Universal footprint reprojection

Generalize `makeLocalToLonLat` so any resolved projected CRS with a proj4 definition reprojects to WGS84 lon/lat, instead of only UTM. Approach: when the resolved CRS is a UTM zone, keep the existing `utmConverter` fast path unchanged; otherwise, if `epsgToProj4` yields a definition, reproject through proj4. Keep the existing Y-up and antimeridian guards. This fixes the footprint-KML gate universally, with Krovák as the first real non-UTM customer. `UtmConverter.ts` is not modified. Dependency: C2.

### C4 — iPhone PDRF7 v1.4 local decode

Confirm the local-LAZ decode path reads PDRF7 v1.4 (RGB triple at the extended offset, mm scale, v1.4 header). If a gap exists, extend the local decoder to match the EPT path's 6–8 support. Dependency: none.

### C5 — Real-scan-derived tests (clouds stay out)

The 4.5 GB clouds are never committed. Tests use: (a) the LAS headers as fixtures (Krovák resolution, PDRF7 field layout, negative-coordinate handling); (b) the surveyed sphere coordinates from GroundTruth as the CRS oracle — a small committed CSV of known 5514↔WGS84 pairs, cross-checked once against GDAL and pinned; (c) a footprint-reprojection test that a Krovák extent produces plausible WGS84 lon/lat over the Czech Republic. Every study artifact cites the Zenodo DOI. Dependency: C1–C4.

## Data flow

Scan load → CRS resolved to EPSG:5514 (C1) → resolved-CRS authority describes units/frame (existing) → measurement/report read metre units → footprint export reprojects via proj4 (C3, using C2's def) → KML. iPhone scan additionally exercises the PDRF7 decode (C4).

## Error handling

- Unknown/unconfirmed CRS still fails closed (existing behaviour) — C1 only adds a resolvable option, it does not auto-assume.
- `epsgToProj4` returning `null` for a CRS with no proj4 def keeps the footprint export gated (no silent wrong reprojection).
- PDRF7 decode: a malformed extended record throws the existing typed decode error, never silently mis-reads.

## Testing

Unit: Krovák registry resolution; `epsgToProj4(5514)` round-trip against the sphere oracle; footprint reprojection of a Krovák extent; PDRF7 header/field parse. Cross-implementation: 5514→WGS84 agreement with GDAL `cs2cs` on the sphere coordinates, pinned. Browser verification: load each of the four scans in the preview and confirm CRS resolves, coordinates/units read correctly, colours render, and footprint exports.

## Success criteria

1. OLV resolves EPSG:5514 for all four scans (by registry, no hand-typed WKT).
2. Coordinates and metre units read correctly under Krovák's negated axes.
3. iPhone PDRF7 v1.4 scan loads with RGB.
4. Footprint KML exports for a Krovák scan (v0.6.6 gap closed, universally for proj4-defined CRS).
5. CRS math cross-checks against GDAL on the surveyed sphere coordinates.
6. No raw cloud committed; Zenodo DOI cited; gates green (tsc, unit, monolith, release-truth).

## Risks

- Krovák axis/sign convention is easy to get wrong; the sphere oracle (C5) is the guard.
- Generalizing `makeLocalToLonLat` could regress the UTM path; mitigated by keeping the UTM fast path untouched and testing both branches.
