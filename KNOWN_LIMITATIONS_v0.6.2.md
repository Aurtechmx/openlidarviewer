# Known limitations: OpenLiDARViewer v0.6.2

This is a validation-and-correction release. Ten validation suites were added, eighteen defects were fixed, and four defects that reached published v0.6.1 output are corrected. The limits below are the v0.6.1 limits with the closed items removed, plus what the new suites named as uncovered. They are recorded here rather than hidden, in keeping with the project's honesty contract.

Four v0.6.1 statements or outputs are corrected in `docs/release/ERRATUM_v0.6.2.md`. One of them is a correction to the previous version of this file: its scope statement for the `geodesicFill` unit-mixing defect was wrong.

## The two monoliths are still monoliths

`src/main.ts` is 7,360 lines and `src/render/Viewer.ts` is 7,104, against stated targets of 2,500 and 2,000. The composition root is finished (no module-level mutable application state remains in `main.ts`) and the architecture is written down with a drift check, but that is the scaffolding for the decomposition, not the decomposition. The remaining blocks to lift, and the measured dependency surface of the first one, are in `docs/architecture/architecture-map.md`.

## The shared project frame is carried, not applied

`ProjectSpatialFrame` / `LayerSpatialTransform` (value types + pure transform math) are tested and documented (`docs/architecture/project-spatial-frame.md`). This release carries **step 1** of the wiring plan: the app now owns a live project frame (`src/app/projectFrame.ts`, on `AppContext`), reseeded from the loaded layer set on every change, choosing one shared origin and deriving each layer's translation into it. A single layer anchors the frame at its own origin, so its transform is the identity and the single-scan path is unchanged.

**Physical multi-layer mounting is DISABLED in v0.6.2** (`MULTI_LAYER_MOUNT_ENABLED = false`). The mount mechanism exists and is tested — a layer's placement in the project frame is a per-layer Float64 translation held beside the cloud, applied per mesh by the renderer and per read by the analysis consumers, so rendering, picking, terrain, lasso, profiles, volumes and exports all read one frame — but it is not the shipped behaviour. Multiple layers may be loaded and analysed individually; they are not co-registered and are not merged into one estimator. Turning mounting on waits on browser verification of two-layer placement (docs/architecture/float64-transform.md, step 6). Still staged for this release:

- **Two-scan placement is unverified in a browser** — and cannot be verified while mounting is off, because nothing places them. That confirmation belongs to the cycle that turns mounting on.
- **Mounting no longer rewrites the data.** Earlier alphas mounted by adding the project offset into the Float32 positions in place, which was lossy and made the round trip inexact. That mechanism is removed: source geometry is immutable (byte-identity pinned by `tests/sourceGeometryImmutable.test.ts`), and mount/unmount are exact inverses because setting and clearing a Float64 placement re-quantises nothing. The mm-precision refusal gates REMAIN as conservative admission rules — they model the retired mechanism's measured cost via `PointCloud.rebaseQuantum` (two tiles 1 km apart would have cost ~0.02 mm; 100 km a full millimetre) — until mounting is revisited with browser evidence.
- Elevation colour ramps are normalised PER LAYER (each layer's own min/max), so a frame offset cancels in the normalisation and per-layer colours are correct — verified empirically. What ramps do NOT do is share one scale across layers, so the same colour on two layers does not mean the same absolute height; that is a pre-frame design choice, and a scene-shared ramp is the open step-5 decision. The measurement datum DOES follow the frame when every loaded layer is in it (step 4), and falls back to the pre-frame unanimity rule otherwise.

For this release:

- Cross-layer operations require a shared CRS, and no layer is moved: every layer stays in the frame its file declared.
- **Multi-dataset comparison is experimental.** Compare Studio, cross-layer measurement, shared clipping and elevation ramps do not yet read the frame's offsets (steps 3–5 of the plan).
- Results that depend on a common frame should be treated as indicative when common-frame compatibility can't be established.
- Integrated Spatial Workflows are **not** claimed complete.
- A layer whose declared CRS disagrees with the project's is excluded from the shared origin and reported as unaligned; it is never silently reprojected. Reprojection remains a downstream tool's job.

## Cross-layer results require PROVEN frame compatibility

Each layer carries what it has established about the project frame:
`verified` (horizontal and vertical both proven), `horizontal-only`
(horizontal proven; vertical undeclared or different), `unknown` (no declared
CRS), or `incompatible` (a different frame).

Only `verified` layers are merged into a combined estimator — terrain/DTM,
profile, cut/fill volume, lasso — and only `verified` layers are aligned in Z.
A `horizontal-only` pair is placed in plan, where the agreement is real, and
keeps its own heights, because orthometric and ellipsoidal references differ by
tens of metres and metre against foot by a factor of three. Undeclared is
treated as unproven, not as agreement.

**This is a deliberate refusal, not a limitation of the maths.** Loading an
unreferenced mesh (PLY/OBJ/GLB) beside a georeferenced scan will now leave it
out of combined results rather than merging frames that were never shown to
correspond. A single layer is `verified` by definition, so single-scan work is
unaffected.

A mount is additionally refused when it would cost more than a millimetre of
Float32 resolution. The step is judged **per axis group** — horizontal through
the horizontal unit, vertical through the vertical one — because a compound CRS
can be feet across and metres up, and putting a Z step through the horizontal
factor understated a 1.95 mm error as 0.6 mm. Either axis alone can refuse. An
undeclared unit refuses rather than borrowing the other axis's, and
**geographic (degree) frames are refused outright** — a degree is not a length,
and what it stands for depends on latitude.

**Streaming sources meet the same bar, and are never merged with static ones
in this release.** A stream's points are local to its own render origin and a
static cloud's to its own — independent numbers — so agreeing on CRS is not
occupying the same space. Merging requires a shared MOUNTED frame, and nothing
is mounted here, so a stream is analysed on its own. Alone, it is fully usable.

**The vertical anchor comes only from verified layers.** A horizontal-only
layer helps set the horizontal origin and never the Z origin.

**Excluded layers say so** in the layer panel, with the reason — a silent
exclusion would leave a figure computed from fewer inputs than it appears.

**Single layers are exempt.** Proof of a shared frame is required to MERGE
layers; one visible layer is analysed in its own frame, whatever its
compatibility state, because no combination is taking place.

**No longer open: the transform is held in Float64 beside source-local
vertices**, never written into them. The in-place Float32 rewrite the earlier
alphas disclosed here is removed (docs/architecture/float64-transform.md,
steps 1–5); positions stay byte-identical through mount, unmount and every
read path, pinned by test. The refusal gates above are kept unchanged as
conservative admission rules — they still quote the retired mechanism's
measured cost — and multi-layer mounting itself remains disabled and
browser-unverified (step 6).

## Contour GeoJSON ships in two frames

`<name>.geojson` is RFC 7946: WGS 84 longitude/latitude, no `crs` member, with
the source CRS recorded in `metadata` as provenance. `<name>-native-EPSG<code>.geojson`
carries the scan's own projected coordinates and the pre-RFC `crs` member for
GIS that wants the survey grid — it is deliberately NOT RFC 7946, and its
filename says so.

Earlier builds wrote projected coordinates into `<name>.geojson` and declared
them with the `crs` member. A compliant reader discards that member and reads
an easting as a longitude without erroring, so files exported before this
change should be treated as native-frame regardless of their name.

When the source CRS cannot be converted to lon/lat, the RFC file is refused
rather than written with projected numbers in degree fields, and only the
native file is produced.

Each contour's `elevationUnit` now states the unit the elevation is actually in.
Until v0.6.1 every contour was labelled `metre` while the value stayed in the
source vertical unit, so a compound CRS with feet over a metre grid shipped
100 ft labelled 100 m. The label is derived from the resolved vertical factor,
and a factor that cannot be resolved reads unknown rather than defaulting to
metre.

The RFC file's geometry is **2D unless the vertical reference is proven to be
WGS 84 ellipsoidal height**, which is the only thing RFC 7946 permits in a
position's third element. Elevations always ride as `elevation`,
`elevationUnit` and `elevationDatum` properties. KML geometry is **2D unless the vertical reference is a
known metric orthometric one** (NAVD88, MSL height, EGM2008, EGM96), since
KML `absolute` means metres above mean sea level specifically — a WGS 84
ellipsoidal height is not that, and a depth axis is sign-flipped as well. The
source elevation, its unit and its datum are disclosed in each placemark
description, so the omitted ordinate is stated rather than lost.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is **opt-in and not wired** into the live scheduler — enabling it must first reconcile with the scheduler's ancestor-protection and be verified visually in a browser. Some budget-boundary "regions pulsing" may remain in this build.

## Startup bundle above the early-warning line

The live entry chunk measures 718 KiB against a hard 720 KiB ceiling — **2 KiB of headroom**, and above the 680 KiB early-warning threshold. Treat the ceiling as effectively reached: shed weight before adding any, and do not raise it. The figure is machine-derived into `docs/validation/test-evidence.json` and checked by `lint:evidence`, because three documents once quoted a size for a build that produced a different one.

## Mutation and coverage evidence is advisory, not archived

`npm run coverage` and `npm run mutation` both pass (numeric-core mutation score 87.23 % at the time of writing). The release-mode gate runs both as blocking stages, records them in the attached evidence, and ships their output inside `gate.log`; ordinary branch CI still runs neither, so between releases treat the figures as a working measurement rather than a preserved claim. `terrainRunnerDensityWiring.test.ts` is excluded from the coverage run only — v8 instrumentation makes it take about 75 s per test — and still runs in the release buckets.

## LAS 1.4 CRS encoding depends on the source

LAS 1.4 requires the horizontal CRS as OGC WKT for point data record formats
6-10. The writer emits a `LASF_Projection` record 2112 with global-encoding bit
4 set whenever a WKT is available, and a WKT is derived for WGS 84 UTM zones and
WGS 84 geographic, whose parameters follow exactly from the code.

Codes outside that set — ETRS89 or NAD83 UTM zones, national grids — still fall
back to a GeoTIFF `GeoKeyDirectoryTag` with bit 4 clear. Those share a
projection with a derivable zone but not a datum, and a datum is not something
to infer when the difference is metres on the ground. Such a file records its
code faithfully and every common reader resolves it, but a strict 1.4 reader
may decline to take the CRS from it. The conversion log says which encoding was
used.

The two records are no longer alternatives. The WKT the writer emits is
horizontal-only, while the vertical datum (GeoKey 4096) and the vertical unit
(4099) exist only in the GeoKeys, so treating one record as excluding the other
dropped both from every WKT-encoded file: a NAVD88 height in US survey feet came
out declaring no vertical datum and no vertical unit, and a reader that assumes
metres is wrong by a factor of 3.28. LAS 1.4 permits both records, so v0.6.1
writes the vertical GeoKeys alongside the WKT. The WKT remains the sole
horizontal authority, the GeoKey record carries the vertical keys and nothing
else, and no GeoKey record is written at all when there is no vertical to add.

What remains true is that a vertical reference the source never declared cannot
be recovered. The file states what the source stated.

An earlier build derived nothing, so a scan georeferenced by GeoKeys alone -
what LAS 1.2 carries, and what PDAL commonly writes - came back out as a 1.4
file with the right code in the wrong encoding.

The read side matched the write side only from v0.6.2. Until then `parseCrsFromVlrs` returned the WKT and discarded the GeoKeyDirectory, so the vertical keys the v0.6.1 writer had just started emitting were dropped again on load. `docs/release/ERRATUM_v0.6.2.md` states which output that reached.

## Evidence ceiling: three cross-implemented products, no field validation

Three products have been compared against an independent implementation. Slope, aspect and hillshade each agreed with GDAL 3.13.1, and with the surface's closed-form gradient, on one frozen analytic DEM, within tolerances registered before the references were generated. `SLOPE-RASTER`, `ASPECT-RASTER` and `HILLSHADE` are at E4 on that basis.

The hillshade tolerance carries a caveat the other two do not: the byte-encoding difference between the two implementations spends most of a one-level budget on its own, so the ours-against-GDAL leg is a weak instrument by itself and the claim rests on the closed-form leg and on an exact re-encoding identity. `docs/validation/cross-implementation.md` states it in full.

Every other `REFERENCE_SLOT` still ships `pending`, and every other terrain product tops out at E3, which is synthetic known-truth against this project's own implementation.

E5 is unreached. Nothing here is field-validated, and the three E4 results validate the algorithms on one analytic fixture rather than the point-cloud-to-DTM pipeline. This release does not claim survey-grade accuracy, standards compliance or independent field validation.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).

## Axis and compound-unit handling is correct but not yet uniform

alpha.2 fixed the two places where an axis or unit assumption produced a wrong number: box dimensions now follow the scan's up-axis (they previously hardcoded Z as height, which also mis-applied the vertical unit factor on a Y-up frame), and the Scan Report footprint follows the source up-axis. The PDF report's footprint did not follow until v0.6.2, so the on-screen panel and the printed page disagreed on every Y-up scan until then. The unit-integrity suite is what compared the two.

There is still no single explicit model spanning up-axis, horizontal unit, vertical unit and CRS, so an unusual combination is more likely to be silently plausible than loudly refused. That model is a stable-v0.6 requirement.

**Boxes require an axis-aligned frame, and now say so.** A box measurement is stored as min/max corners, so it is axis-aligned by construction and its height can only be an extent along X, Y or Z. Given a genuinely tilted up vector the geometry used to fall back to the *dominant* component — reporting the extent along the nearest axis as the height, and carrying that into the footprint ring, the exported GeoJSON and KML polygons, and the compound-CRS vertical conversion. It now throws instead. No scan can currently trigger this: every world-up the viewer sets is exactly (0, ±1, 0) or (0, 0, ±1), chosen by source format, so the refusal guards the contract rather than gating a feature. Genuinely oriented boxes need a stored basis instead of an axis index, which is a stable-v0.6 item alongside the project frame — the two are the same "arbitrary frames" problem.

## Vertical-unit gaps still open

Four of the five vertical-unit gaps the v0.6.1 audit recorded are closed in v0.6.2: the contour deliverable's GeoTIFF states its vertical unit, the async and GPU derivative path carries the `zScale`, `geodesicFill` walks in metres, and the unused elevation-grid hillshade wrappers are deleted. One remains.

- **`toGeoJSONWgs84` writes a source-unit height into an RFC 7946 ordinate.**
  When the vertical datum is EPSG:4979 the elevation goes into the third
  position ordinate, which RFC 7946 requires in metres, while the value is in
  source units. A foot factor together with a 4979 datum is self-contradictory
  and may be unreachable in practice, but nothing in the code enforces that, so
  the combination is not refused either.

## What the validation suites do not cover

Each suite states its own gaps rather than leaving them implicit. A check that cannot fail in the environment it runs in would pass without evidence, so these are named instead of tested.

- **GPU-computed derivatives beyond the engine probe surfaces.** The WebGPU
  backend takes the same cell-metres and `zScale` arguments as the CPU one, but
  Node has no adapter, so the engine falls back to CPU and a unit check there
  would test the CPU path twice. GPU-versus-CPU agreement is established by the
  engine's own equivalence probe, which runs in a browser and covers the probe
  surfaces only.
- **Render-space lengths and the measurement HUD.** Values are read back from
  three.js world transforms, which need a WebGL context.
- **Rasterised report composition.** Colorbar and legend tick labels, the
  on-canvas scan report drawing paths and the PDF report's page composition all
  need a canvas context. Only the pure label and figure builders behind them are
  checked. The unit strings a page prints come from those builders; the rendered
  page itself is not inspected.
- **LAZ output.** `CONVERT_FORMATS.laz.available` is false: there is no LAZ
  encoder, so there is no LAZ file of the application's own to read back. The
  LAZ read path shares record decoding with the `.las` path that is exercised,
  but the compression leg is untested.
- **Third-party writer conformance.** The round-trip suite reads every file back
  with an independent ASPRS spec-offset decoder in float64 alongside the
  application's own loader, which is two readers over one writer. Whether PDAL,
  lastools or a commercial writer produces files this reader handles, and
  whether they accept these files, is not measured.
- **`npm ci` and a build from a clean extract.** The archive-portability suite
  runs the archive's node-only verification inside an extract with no repository
  around it. A tool that cannot start without `node_modules` is recorded as
  needing dependencies, and one that needs a build is recorded as needing a
  build, rather than counted as a pass. Neither the install nor the build is
  performed there.
- **Windows as a reproducibility leg.** The portability matrix is darwin-arm64
  and linux-x64. Untested platforms, other runtime versions and big-endian hosts
  are outside the result.

## The in-memory reconstruction is less precise than the file it came from

Points are held as Float32 local to a render origin, so what the application reconstructs from a LAS file displaces further than the file's own quantisation bound allows. The round-trip suite measures both and reports them separately.

Over a 50 km extent at millimetre scale the file round-trips with zero displacement while the application's read-back reaches 1.9 mm. Over a 5000 km extent, where the writer widens the scale to stay inside int32, the file's own bound is 1.25 mm and the application's read-back reaches 0.123 m. The written file is unaffected either way. What the figures describe is the resolution of what the viewer holds, measures and derives from, and it grows with the extent of the cloud rather than with the declared scale.

A wide-area cloud is the case to watch.

## Cross-platform reproducibility is not yet established

The comparator, the per-platform recorder and a CI matrix over darwin-arm64 and linux-x64 are in place, and both legs always run so that a failed leg cannot leave a one-platform comparison looking green. The only run recorded in the tree is a single darwin-arm64 leg, which reports as `single-platform` with `claimEstablished: false`.

That leg establishes seeded reproducibility on one platform: 15 science-scoped artifact hashes and 18 scalars identical across ten runs at zero tolerance.

Nothing has been compared against them.
