# OpenLiDARViewer v0.5.6

A point-filtering release. v0.5.6 connects the staged point-filter work to the
live renderer with elevation and intensity filters, and extends those filters to
selection: a hidden point can no longer be picked, measured, or reclassified.
OpenLiDARViewer stays browser-native and local-first: your files never leave the
device, and no account is required.

## Elevation and intensity filters

Hide points outside a chosen height window. You give the window in world units,
and the viewer converts it to the scan's attribute space along its up-axis, so
one control fits Z-up surveys (LAS, LAZ, E57) and Y-up phone scans. Points
outside the window collapse to zero size on the GPU. They still pass through the
vertex stage, but they draw nothing and add no extra draw calls, and clearing
the filter restores the scene exactly. The filter runs on static clouds and on
streaming COPC/EPT nodes, from a control in the Inspector.

The intensity filter works the same way, in the file's raw intensity units. Its
control seeds from the scan's own intensity range and stays hidden for scans
that carry no intensity channel.

## Filters govern selection, not just the picture

Picking, measuring, snapping, focus, probing, annotating, and lasso
reclassification now skip any point a filter has hidden. A point you cannot see
cannot become a measurement vertex or be rewritten by a class edit. Screen and
tools agree point for point.

## Streaming point-cloud export

Export the streamed-in (resident) points of a COPC or EPT scan to LAS or XYZ,
optionally gzip-compressed as `.las.gz`, at display resolution. While the cloud
is still streaming, the export is flagged as a reduced view so it is never
mistaken for the full survey. In-browser LAZ writing is not available yet.

## Loading feedback and error handling

Opening a scan, whether a local file or a public streaming dataset, shows a blue
"Opening…" indicator, so an in-flight load reads the same way from either entry
point. If the GPU cannot render a scan (a shader or pipeline error, which the
graphics backend reports after the scan has already decoded), the reason now
appears as a message instead of a blank canvas. A lost GPU device reports a clear
"reload the page" message rather than leaving a dead canvas.

## Fixes

Streaming scans now seed their elevation and intensity controls from the streamed
data; before this they stayed hidden. Clearing a filter field no longer applies a
stray zero bound while you retype, and re-seeding the extent for a new scan clears
the previous scan's active filter, so the control and the rendered scene always
match. Swapping a static scan for a streaming one clears any leftover filter
state.

Sessions keep every measurement. Profile, box, and volume measurements and their
data (profile chart, corridor width, ground percentile, cut/fill volume record,
resident-only flags) now survive a save-and-reload instead of being dropped on
import.

The empty-state startup path is guarded, so a fresh page load cannot error before
a scan is open.

## Known limitations

Elevation and intensity filtering uses a single up-axis and one reference origin.
A session with several layers at different origins, or a mix of Z-up and Y-up
layers, can filter some layers inconsistently. Per-layer filtering is planned;
the design is written up in `docs/gate2-per-cloud-filter-plan.md`.

## Compatibility and scope

Everything from v0.5.5 is unchanged. The filters are additive and off by default,
so an unfiltered scene renders exactly as it did before.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional
web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff` (version 0.5.6, MIT
licence, released 2026-07-04). When the tagged release is archived on Zenodo,
cite the version DOI Zenodo assigns to that snapshot.
