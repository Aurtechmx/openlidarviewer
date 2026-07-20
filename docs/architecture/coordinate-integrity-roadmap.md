# Coordinate integrity — findings and repair order

The risk this document tracks is not obviously wrong numbers. It is **coordinates
that look reasonable but belong to the wrong axis, unit, CRS, vertical reference,
datum or layer frame** — output that passes review and misplaces a deliverable.

Every item is marked with how it was established:

- **verified** — reproduced here by running the code, with the observed value recorded.
- **traced** — established by reading the call chain end to end, not executed.
- **reported** — raised by an external audit and not yet independently checked.

Nothing is listed as verified on the strength of a report alone.

## Current safe envelope

The subsystem is dependable inside a narrow envelope, and that envelope should be
stated plainly rather than implied: **one Z-up scan, a projected metre-based CRS,
matching horizontal and vertical units, no datum transformation, no cross-layer
analysis, no compound or dynamic CRS.** Outside it, several paths produce
plausible but spatially wrong results.

Two things are genuinely solid and worth not re-litigating:

- **UTM projection maths** — agrees with proj4 to under 1 mm across both
  hemispheres, zone edges and ±80° latitude (verified, 8 points; an external pass
  reports the same over 147 points via pyproj). The formulas are not the problem;
  the missing domain validation around them is.
- **Horizontal datum-shift honesty** — NAD27, GDA94↔GDA2020 and NAD83↔WGS84
  caveats are computed and surfaced on the convert path (traced).

## P0 — before alpha.2 can claim coordinate correctness

### 1. EPSG codes parsed out of display names — FIXED (b51d510)

`parseEpsg` in `src/terrain/export/demPackage.ts` makes the `EPSG:` prefix
optional, so it returns the first 3–6 digit run in any string. It is fed
`dtm.crs`, which is the CRS *display label* (`terrainAnalysisRunner.ts` →
`cur.name`), and `dtm.verticalDatum`.

Observed: `Mexico ITRF2008 / LCC` → **2008** (should be 6362); `CH1903+ / LV95`
→ **1903** (2056); `Estonian Coordinate System 1997` → **1997** (3301);
`Baltic 1977` → **1977** (5705). Any CRS whose name carries a year — ITRF2008,
CH1903, GDA2020, EGM2008 — yields a structurally valid GeoTIFF stamped with a
wrong horizontal or vertical CRS.

Fix: carry the code as a number from the resolver rather than recovering it from
prose. Where a string must be accepted, anchor it (`/^EPSG:(\d{4,6})$/i`) and
treat it as a defensive fallback, never a primary source.

### 2. Terrain analysis has no axis input — FIXED (cf19b96)

`gatherTerrainPositions` hands positions through unrotated, `ScanShape` does not
expose the up-axis it detects internally, and `terrainAnalysisRunner` has no axis
parameter. The pipeline therefore reads X/Y as the horizontal plane and Z as
elevation, unconditionally.

Observed: a Y-up height field classifies as `terrain`, `nonTerrain: false`,
confidence 0.85 — so it routes *into* that pipeline. For a mesh spanning X 158 m,
Y 6 m (elevation), Z 158 m, the DTM is built over a 158×6 m footprint with 158 m
of "elevation". Reachable from any drone photogrammetry mesh exported as
OBJ/glTF.

Corrupts DTM/DSM/CHM, slope, aspect, hillshade, contours, density, confidence,
and the latitude correction. The export origin mapping (`demPackage`,
`contourDeliverableBuild`, `contourFeatureModel`) is the same defect surfaced one
layer later — fixing analysis without the exports leaves the package wrong.

Fixed by normalising at the gather boundary rather than threading an axis
contract: a Y-up buffer is rotated into the canonical Z-up frame (`(x, y, z) →
(x, −z, y)`, a rotation, not a mirroring swap) before anything reads it, and
the recentre origin makes the same trip through a shared accessor. Analysis,
cache fingerprints and all three exporters stay correct with no changes of
their own. A mixed Y-up + Z-up gather declines — the union describes no single
surface. The equivalence suite runs the real Horn derivatives over one
analytic hill authored in both frames and requires identical slope AND aspect;
a reflection passes the elevation check and fails the aspect one.

### 3. KML substitutes zero for a value it cannot format — FIXED (b51d510)

`fmt` in `src/export/kmlExport.ts` returns `'0'` for any non-finite number, so a
failed conversion places a feature at 0°N 0°E instead of failing.

Related and already fixed today: the mapper in `main.ts` used to fall back to raw
easting/northing, which the grid-range gate made reachable; it now refuses. The
`'0'` substitution is the same class one layer down and is still open.

Fix: conversion returns a result type; on failure abort the export or omit the
feature and disclose it. Never substitute.

### 4. Session up-axis defaults silently to Y — FIXED (b51d510)

`src/io/session.ts:343` — `upAxis: raw.upAxis === 'z' ? 'z' : 'y'`. A missing,
misspelled or corrupted value becomes Y-up with no warning, reinterpreting every
stored measurement.

Fix: parse to `'z' | 'y' | null`; a null must refuse the restore or prompt,
not guess.

### 5. Converter and LAS writer are axis-blind — traced

`globalPoints` / `reproject` / `writeLas` treat storage X/Y/Z as easting/
northing/elevation. For a Y-up source, elevation is written as northing and depth
as height.

Fix: normalise to a canonical east/north/up basis before reprojection; exporters
receive canonical axes, never raw storage order.

### 6. LAS vertical unit inferred from the horizontal one — FIXED (9d937ba)

`writeLas.ts` derives GeoKey 4099 from 3076. Reprojecting horizontally to metres
while leaving Z in feet writes "400 metres" over a Z of 400 feet. Independently
confirmed by two audit passes.

Fix: vertical unit is independent input, derived from or checked against the
vertical CRS. Unknown ⇒ omit the key rather than guess.

### 7. Geographic point inspection rounds before converting — FIXED (644f959)

`src/render/pointInfo.ts` rounds world coordinates to 3 decimals immediately, then
feeds them to display, UTM conversion, clipboard and JSON. Three decimals is
millimetres in metres and ~111 m in degrees.

Verified with a narrower shape than reported: the projected path was fine (3 dp
is millimetres), but a GEOGRAPHIC source's world Y — latitude — was rounded to
3 dp (~111 m) and then fed to the UTM derivation, printed at millimetre
formatting, and carried into clipboard and JSON. Fixed by rounding the
horizontal axes to 7 dp (~1.1 cm) when the frame is geographic; elevation stays
at 3 dp, a height being a linear unit either way. The Viewer captures the frame
kind in the `setInspectCoordinateContext` pass-through it already owns.

### 8. Change detection computes before checking compatibility — reported

ICP, rasterisation and differencing reportedly run before CRS/datum/unit warnings
are attached, using the first epoch's unit factor, comparing CRS as strings, on a
hardcoded Z-up path.

Fix: a frame-compatibility preflight that must succeed before any computation;
refuse rather than warn afterwards. A warning attached to a completed computation
does not make it valid.

### 9. Exports can label coordinates with a different CRS than they used — reported

`exportGeoContext` takes its label from source metadata while KML transforms via
`crsService.current()`, so after an override a file can carry coordinates in one
CRS and a WKT naming another. Worse than an absent CRS, because a reader places
it confidently.

Fix: one effective spatial context per export — source reference for provenance,
effective reference for coordinates, labels and embedded metadata.

## P1 — before a stable v0.6 research release

1. **Activate the project frame in the scene.** The frame is computed and live on
   `AppContext` (landed), but layers still mount at their own local zero, so two
   georeferenced scans still overlay. This is step 2 of
   `project-spatial-frame.md` and needs a two-scan browser check.
2. **Replace regex WKT parsing with an AST parser.** The current parser survives
   realistic WKT1 and WKT2 (verified against six shapes including `PROJCRS` with
   nested `BASEGEOGCRS`, `COMPD_CS`, and bracketed names), so this is
   robustness rather than a live defect — but `LENGTHUNIT`/`ANGLEUNIT`, per-axis
   units, axis order, datum ensembles and coordinate epoch are all discarded.
   Until then, an unknown projected unit should resolve to `unknown` with metric
   claims blocked, not silently to metre.
3. **One authoritative EPSG/operation catalog** shared by the picker, type
   detection, unit and datum lookup, projection definitions and area of use. Do
   not offer a reprojection target with no operation definition. `CrsDetection.ts`
   is currently dead code and must be either wired in or deleted — it is not
   acceptable to leave a documented, tested precedence engine that nothing calls.
4. **Per-layer session spatial metadata**, replacing the single global
   origin/up-axis/CRS. A session must never silently redefine the active scan's
   CRS, and a CRS/axis/unit mismatch must be a conflict, not a disclosure.
5. **Separate horizontal and vertical operations.** A horizontal conversion must
   not pass Z through and let a downstream field call it `altMetres`. Heights need
   an explicit value + unit + reference (ellipsoidal / orthometric / depth /
   local / unknown).
6. **Model datum realization and coordinate epoch**, and carry operation
   provenance and accuracy on every transform result.
7. **CHM must not carry an absolute vertical CRS.** It is DSM − DTM, a height
   above ground, not a coordinate in NAVD88 or EGM2008.
8. **Reference fixtures from PROJ/PDAL/GDAL**, so coordinate claims are checked
   against an independent implementation rather than internal self-consistency.
9. **Fail closed** whenever a coordinate operation is unresolved.

## Sequencing

Items 1–4 are done (`b51d510`, `cf19b96`), item 6 is done (`9d937ba`) and
item 7 is done (`644f959`, verified narrower than reported — the projected path
was fine). Remaining P0: item 5 (the axis-blind converter — the terrain-style
boundary normalisation applies) and items 8/9, still `reported` and needing
verification before any fix.

Item 2 (terrain axes) is the largest P0: it changes a contract threaded through
analysis, caching and three exporters, and it should land as one reviewed change
rather than piecemeal, because a half-applied axis contract is harder to reason
about than none.

Items 5, 6 and 9 share a root: the pipeline has no single description of *what
frame the data is in*. They are cheaper together than separately, and they are the
natural on-ramp to the P1 project-frame work.

## What is deliberately not claimed

The scores an external audit assigned to each area are not reproduced here. Some
rest on findings this document marks `reported`, and a number that looks measured
but is not would be the same class of error the document exists to prevent.
