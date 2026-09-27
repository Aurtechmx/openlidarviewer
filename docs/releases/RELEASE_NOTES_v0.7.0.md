# OpenLiDARViewer v0.7.0

> Draft in progress for the release freeze. Every `[FREEZE: ...]` marker is a
> figure the release step copies from `docs/validation/test-evidence.json` or
> the claim register after the final gate run. Remove this note when none
> remain. `lint:release-sync` fails while the phrase "in progress" is here.

v0.7.0 is the first Community Stable release of the 0.7 line. It reorganises
the workspace so each side of the rail does one task at a time, adds evidence
rasters to the DEM package, adds the Observatory as a preview, describes files
it cannot open instead of refusing them, and makes Firefox, WebKit and Windows
blocking in CI.

The register holds [FREEZE: claim count] claims: [FREEZE: E1] at E1,
[FREEZE: E2] at E2, [FREEZE: E3] at E3 and [FREEZE: E4] at E4, none at E5.

OpenLiDARViewer remains browser-native and local-first: local files stay on
the user's device, and no account is required.

## Capability status

`docs/validation/capability-manifest.json` lists each capability as stable,
preview or hidden. Stable capabilities follow `docs/project/STABILITY_POLICY.md`. Preview
capabilities can change or be withdrawn in a minor release. Hidden ones ship
in the code but no user path reaches them. In this release Flow Pulse,
Terrain Access, the Observatory and the open-any-file probe are preview.

## The workspace

- The left rail has one vertical scroller per mode. Nested scroll boxes are
  gone, and a long station table shows ten rows and a "Show all" button.
- A workspace router holds one page per mode. The dock, the M, A and I keys,
  the command palette and the Tools launcher run the same command for each
  scene tool, and Tools shows one tool at a time under a task header with a
  Back button.
- Analyse opens on a home with one row per analysis: Terrain, Flow Pulse,
  Terrain Access, Observatory and Objects and space, plus Feature candidates
  and Range frames when the scan carries them. Each row reads Ready, Review or
  Blocked with a one-line reason taken from Process Studio's own rules, and a
  blocked row offers the fix when the app can carry it out. A row that depends
  on the terrain run never reads better than Terrain.
- Data opens on the layer list with a Classes row and a Source and metadata
  row. Classes is its own page. Layer Health stays in the Inspector.
- On a phone the sheet has the desktop modes as tabs (Data, Tools, Analyse,
  Export) plus View for the Inspector, and one router drives both layouts.
  Tabs and task headers are 44 px tall. Large touch screens in landscape get
  their own layout, and overlays no longer cover controls.
- Every control explains itself on hover and on keyboard focus.
- Pending at the time of drafting: a Results shelf that lists the session's
  results and returns to each one (#1106). [FREEZE: keep this item only if
  #1106 has merged; otherwise move it to the known limitations.]

## EvidenceDEM: what the DEM package says about its own cells

The DEM package writes `terrain_evidence.tif` on the DTM grid. It has six
bands: ground returns per cell, distance to the nearest measured cell, a cell
state, distance to the nearest supporting return, the vertical dispersion of
the cell's ground returns, and distance to the survey edge. The cell states
are measured, interpolated, low support, edge risk, near the edge, and
unresolved reference. The bands describe support, not accuracy, and the
package README says so.

Two more rasters are written only when asked for, from checkboxes in the
Contour Studio export:

- Include sensitivity writes `terrain_sensitivity.tif`: the spread of the
  surface height across a fixed, pre-registered set of terrain settings. A
  low spread means those settings agree at a cell, not that the height is
  correct.
- Include attention writes `terrain_attention.tif`: a level from 0 to 3 and
  the main reason a cell may need a check, with a leave-one-out
  reconstruction residual among the inputs. Level 0 means no reason was
  found, not that the surface is verified. It is off by default because it
  added 37.5 per cent to package export time on the reference dataset, above
  the 10 per cent the protocol allowed for a default.

Each package states an evidence tier from T0 to T3 in its README and
passport. A default export is T2. T3 needs both optional rasters and a
resolved vertical unit. Every raster is listed in `SHA256SUMS` and bound into
the DTM passport, and an independent Python oracle checks each one cell by
cell. The rules were committed before any raster was computed.

## The Observatory (preview)

From declared acquisition stations, the Observatory traces rays through a
bounded voxel grid and reports what the scan observed, what is shadowed and
what nothing addressed. It opens from the palette and from the Analyse home.
The basis is labelled as resident points only, and the panel never reports
full or measured coverage.

Its Planning section suggests further scanner positions, one at a time, that
would observe shadowed voxels. These are candidates ranked by a count, not
optimal positions. Reachability is not checked, and the panel says so. An
assumed station origin is labelled and drops planning to preview.

## Opening a file the viewer does not recognise

A file that no format check recognises is now probed instead of refused. The
probe reads at most 1 MiB in a worker with a 3 s limit. A known format under
the wrong extension, or none, still opens. When nothing opens the file, a
report gives its size, whether it is text or binary, its byte entropy, any
recognised signature of a non-point-cloud format and a repeating record size
if one exists. The report leaves out the file name, path and coordinates, and
the open project stays loaded.

The probe describes a file. It does not recover points from a raw or
headerless file.

## Stability

- Firefox, WebKit and Windows are blocking checks in CI. Each leg fails when
  its Playwright run executed zero tests.
- After a crash or reload the viewer offers to restore the work on a scan:
  view, camera, measurements, annotations, saved views and CRS, not the point
  cloud. Restore is offered only for a file with the same name and header.
  Saved copies expire after 7 days, and Help has a Clear action and an off
  switch.
- "Make available offline" keeps a full copy of the app after stating its
  size, about 9 MB. "Remove offline copy" deletes it.
- The view is redrawn after a lost WebGL context is restored, and the WebGL 2
  path and a boot without optional browser features are tested.
- A remote dataset link asks before it fetches anything, and every remote
  path accepts https only and sends no credentials or referrer. Each parser
  checks declared counts against the bytes present before it allocates. The
  content security policy adds `object-src 'none'` and
  `frame-ancestors 'self'`.
- The deployed build ships `LICENSE` and full third-party notices, credits
  every dataset with committed derived data, and adds `PRIVACY.md`.
- A capability marked stable can be withdrawn when it is wrong or unsafe, by
  the procedure in `docs/project/STABILITY_POLICY.md`.

## Performance

A frame budget governor and a calibration of its starting level are in the
code and off by default. Both are behind maintainer flags that the published
build does not include.

- Governor v1 and v2 failed their comparisons. v3, with criteria fixed before
  measuring, passed on the reference dataset and a held-out one, with p95
  frame time 12 to 59 per cent lower. That is one machine and one browser, so
  it stays off.
- Calibration failed its pre-registered comparison on both datasets. The
  warm-up picked the lowest level in all 70 calibrated runs, so the two arms
  ran the same policy and the failures reflect run-to-run spread. The result
  is inconclusive about calibration itself.

Report code, the snapshot compositor, the annotation editor and the
Inspector's CRS, provenance and report sections load on demand. The live
entry is [FREEZE: bundle.liveEntryKiB] KiB.

## Fixed

- Withheld points are left out of the polygon Volume tool, as they already
  were from terrain, lasso volumes, profiles and density.
- LAS export keeps scan angle, user data and scanner flags.
- Full Dataset is no longer shown for streamed or downsampled sources.
- Camera glides stop exactly after input and stop at once under reduced
  motion.
- Contour lines are removed when their scan closes.
- A blocked terrain surface gives the quality gate's reason.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.7.0.md`. In short: the governor
and calibration are off, recovery of raw files is not shipped, the Observatory
is a preview, and no result here was measured on a real phone or tablet.

## Test evidence

Gate run at commit [FREEZE: commit]: [FREEZE: total.passed] passed /
[FREEZE: total.skipped] skipped. Per bucket: [FREEZE: buckets]. The figures
come from `docs/validation/test-evidence.json`.

## Licensing

Unchanged: OpenLiDARViewer is distributed under AGPL-3.0-only. Releases
through v0.6.6 were published under MIT and stay available under those terms.

## Compatibility

Sessions written by v0.7.0 use schema version [FREEZE: session schema].
Sessions from version 1 onward open. The canonical toolchain is Node
[FREEZE: .nvmrc] with npm [FREEZE: packageManager].

## Verifying this release

`REPRODUCIBILITY_v0.7.0.md` describes how to rebuild the release and verify a
downloaded archive.

## Citing

The version DOI for v0.7.0 is pending Zenodo deposition. Cite the concept DOI
10.5281/zenodo.21544619 for the series.
