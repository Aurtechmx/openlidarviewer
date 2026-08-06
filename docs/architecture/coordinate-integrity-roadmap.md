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

### 5. Converter and LAS writer are axis-blind — FIXED (a094859)

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

### 8. Change detection computes before checking compatibility — FIXED (a094859), verified narrower than reported

Verified narrower than reported: `compareDtms` already ran a substantial
preflight (geographic volumes refused, origin offset, CRS, vertical datum, all
with unknown-side handling) — the genuine defect was that a PROVEN mismatch
still computed and shipped its figures under a caveat. Fixed: a differing
horizontal CRS or vertical datum is `frameIncompatible` — the summary leads with
the refusal and withholds every number while keeping the diagnosis, and the
difference raster is not offered. An unknown frame stays indicative-with-caveats,
so two undeclared scans still compare. The Z-up assumption is closed upstream by
the gather normalisation (`cf19b96`).

### 9. Exports can label coordinates with a different CRS than they used — FIXED (a094859)

`exportGeoContext` takes its label from source metadata while KML transforms via
`crsService.current()`, so after an override a file can carry coordinates in one
CRS and a WKT naming another. Worse than an absent CRS, because a reader places
it confidently.

Fix: one effective spatial context per export — source reference for provenance,
effective reference for coordinates, labels and embedded metadata.

## P1 — before a stable v0.6 research release

1. **Activate the project frame in the scene: multi-scan mount held OFF.**
   `MULTI_LAYER_MOUNT_ENABLED` is false. The placement path is built and gated
   behind the flag: two georeferenced tiles that declare the same projected CRS
   mount into one shared frame at their real separation, non-destructively (the
   placement moves the mesh, never the `.positions`).
   The lone-layer identity keeps the single-scan path byte-identical.
   `tests/e2e/twoScanMount.spec.ts` builds a UTM-33N tile pair with the real LAS
   writer and proves acceptance #1 (real separation), #3 (source geometry
   untouched) and #8 (a horizontal-only mount does not fold Z). Enabling it
   surfaced and fixed a real refusal: `mountPrecision` demanded a usable vertical
   unit even for a horizontal-only mount that applies no Z offset, which blocked
   the common projected-horizontal-CRS-with-no-vertical case; the vertical term
   now gates only a vertical mount. Remaining: the rest of the acceptance battery
   (#2 add/remove no-move, #4 picking, #5 cross-layer measure, #6 profiles/
   terrain/lasso/volume, #7 export world coords, #9 incompatible excluded — the
   CRS-less case is already shown, #10 WebGPU vs forced-WebGL2), and the
   per-cloud elevation-filter CPU pick path.

   Membership is now REVERSIBLE (bac535f). A cloud keeps `sourceOrigin` for its
   lifetime and `restoreSourceFrame()` returns it there; the frame seeds its
   anchor from file origins instead of from origins it had itself written, and
   the anchor persists only while it still describes the current layer set.

2. **Stop writing project offsets into Float32 vertices — data model DONE; the
   picking/measure display fold FIXED (#254); one renderer fold browser-gated.**
   The destructive rebase is gone. Mounting
   no longer rewrites the Float32 buffer: `Viewer.setLayerPlacement` holds the
   layer's Float64 `sourceToProject` as data on the layer entry and sets
   `mesh.position`, and `positions` is written once by the loader and stays
   byte-identical through mount, unmount, hide, restore and export
   (`float64-transform.md` invariant 1, `tests/sourceGeometryImmutable.test.ts`).
   The destination shape every review named is in place for the DATA MODEL:
   source-local vertices, the transform held in Float64 beside the buffer.

   The CPU world coordinate is recovered per boundary, in the frame each one
   names, and audited under a non-identity mount by
   `tests/frameWorldCoords.test.ts`:

   - **Source-frame consumers are world-correct via `sourceOrigin`** —
     `worldXYZ`, `cloudToGlobal`, the exporters (`exportGeoContext` →
     `c.sourceOrigin`), and the two-epoch change comparison (`main.ts` ~5936,
     each epoch built on its own `sourceOrigin`, not the live project origin).
     The placement never enters the sum, so these hold under any mount.
   - **Project-frame estimators fold the translation into their shared
     accumulator** rather than moving points: the picking ray + hit lift
     (`layerPlacement.ts`), terrain gather (`terrainStreamSample.ts:99,108`), and
     the scene-bounds merge (`mergePlacedBounds`). Identity while mounting is
     off, so byte-identical to the pre-fold walk.

   **Remaining, browser-gated** (the P1 #1 acceptance battery, and
   `float64-transform.md` step 6):

   1. The renderer's camera-relative / render-origin fold (mesh position →
      `sourceToProject − renderOrigin`, folded on the CPU per mesh). Bounded and
      refused past 1 mm by the `LayerService` mount-precision gate
      (`PointCloud.rebaseQuantum`: ~0.02 mm at 1 km, ~1 mm at 100 km; geographic
      frames refused outright), so a precision refinement, not a correctness
      defect.
   2. The display-coordinate fold for picking and cross-layer measurement —
      FIXED (#254). `Viewer._infoForHit` had built the inspector's world
      coordinate as the PLACED (project-local) pick point plus `sourceOrigin`,
      double-counting the translation for a non-anchor mounted layer (off by the
      full `sourceToProject`, 2 km in the `twoScanMount` fixture) — correct only
      under the identity placement, which is why it was invisible single-layer.
      It now reads `cloud.worldXYZ(index)` from the hit index, correct mounted or
      not, pinned by `tests/frameWorldCoords.test.ts`. Closes P1 #1 acceptance #4
      (picking) and #5 (cross-layer measure) at the data-model level; a browser
      e2e that picks a point on a mounted non-anchor tile is the remaining
      evidence.

   `src/model/LayerSpatialState.ts` stays an unreferenced scaffold — the runtime
   adopted the `PointCloud.worldXYZ` / `projectXYZ` accessors and the
   `layerPlacement.ts` fold toolbox instead of a per-layer container.
   `docs/architecture/float64-frame-migration-plan.md` records the current
   architecture and keeps the historical `.positions` surface;
   `scripts/lint-positions-reads.mjs` (`npm run lint:positions-reads`,
   report-only) prints the live list.

3. **Replace regex WKT parsing with an AST parser.** The current parser survives
   realistic WKT1 and WKT2 (verified against six shapes including `PROJCRS` with
   nested `BASEGEOGCRS`, `COMPD_CS`, and bracketed names), so this is
   robustness rather than a live defect — but `LENGTHUNIT`/`ANGLEUNIT`, per-axis
   units, axis order, datum ensembles and coordinate epoch are all discarded.
   Until then, an unknown projected unit should resolve to `unknown` with metric
   claims blocked, not silently to metre.
4. **One authoritative EPSG/operation catalog** shared by the picker, type
   detection, unit and datum lookup, projection definitions and area of use. Do
   not offer a reprojection target with no operation definition. `CrsDetection.ts`
   has been DELETED rather than wired in: it misled two audits into citing its
   documented precedence as live behaviour, dead code passing tests is actively
   deceptive, and wiring it in would have changed live resolution pre-release
   with no fixture demanding it. Its catalog-tier and conflict-demotion design
   stays recoverable from history if the stable-v0.6 catalog work wants it.
5. **Per-layer session spatial metadata**, replacing the single global
   origin/up-axis/CRS. A session must never silently redefine the active scan's
   CRS, and a CRS/axis/unit mismatch must be a conflict, not a disclosure.
6. **Separate horizontal and vertical operations — LARGELY DONE.**
   `src/geo/height.ts` carries a height as an explicit value + optional metres
   scale + reference (ellipsoidal / orthometric / depth / local / unknown), wired
   into the inspector (`pointInfo.pointHeight`), scan report, measurement
   confidence and `SpatialContext`. KML export refuses an authoritative altitude
   unless the vertical reference is a proven orthometric-metric surface, and drops
   the ordinate otherwise. Remaining: the converter still returns a bare `Vec3`
   whose Z it documents as passed through unchanged — carrying a `HeightValue`
   there would close the last bare-number path.
7. **Model datum realization and coordinate epoch — provenance + realization
   DONE.** Every reproject result carries transform provenance (#248) and the
   converter method, and the registry preserves realization-specific datum names
   (NAD83(2011), ITRF2008) rather than collapsing them to a generic base.
   Remaining: model the coordinate epoch as a first-class field on the CRS /
   transform result — a dynamic-datum coordinate is only fully specified with its
   epoch — and, optionally, a numeric accuracy estimate on each result.
8. **CHM must not carry an absolute vertical CRS — DONE (9b0ddf7).** The DTM and
   DSM keep the VerticalCSType stamp; the CHM, a height above ground, carries
   none.
9. **Reference fixtures from PROJ/PDAL/GDAL**, so coordinate claims are checked
   against an independent implementation rather than internal self-consistency.
10. **Fail closed** whenever a coordinate operation is unresolved.

## Sequencing

**All nine P0 items are closed** (`b51d510`, `cf19b96`, `9d937ba`, `644f959`,
`a094859`). Three of the reported items (7, 8) verified narrower than the
external audit described, and the fixes were scoped to what was actually true.
What remains is the P1 list — led by the project-frame scene mount (browser
gated) and the cross-implementation reference fixtures.

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
