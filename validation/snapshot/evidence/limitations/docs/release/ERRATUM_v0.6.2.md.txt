# Erratum: corrections to v0.6.1

Four defects were present in the published v0.6.1. All four are corrected in
v0.6.2. Each one could have reached output a user still holds, so each entry
below states what the software did, which outputs carry the error, and what
recovers a correct figure.

One of the four sits in a truth document rather than in code: the v0.6.1
limitations file described a narrower scope for a fill defect than the code
supported.

## 1. The geodesic fill scope statement in `KNOWN_LIMITATIONS_v0.6.1.md` is wrong

`KNOWN_LIMITATIONS_v0.6.1.md` says of the `geodesicFill` unit-mixing defect that
it "affects the non-default geodesic interpolation mode only; the default fill
is unaffected". Both halves of that sentence are false.

`src/terrain/ground/surfaceFromRaster.ts` exports
`LIVE_INTERPOLATION = 'geodesic'`, and `src/terrain/contour/analyseContours.ts`
reads that constant on the live path. Geodesic is not an optional mode. It is
the void fill that built every DTM surface the application produced, including
the surface the hold-out validation measures.

What the defect did: the Dijkstra step cost summed a horizontal step in raw
source units with a vertical rise in raw vertical units, over one isotropic cell
size used for both grid axes. The corrected cost converts both terms to metres
through the same per-axis conversion the slope stage uses.

The range of affected output is narrower than the range of affected code paths,
because the inverse-distance weights are normalised over the samples they
collect. A single common factor applied to every path cost cancels exactly. So:

- Projected frames with one unit throughout, metre horizontal over metre
  vertical or foot over foot, produce the same interpolated heights before and
  after the fix. The grid cells are square there, and the unit change is a
  uniform scale.
- Geographic (degree) frames are affected. A degree step is about 1e-5 beside
  metre heights, so the cost went effectively vertical-only and the
  down-weighting of a path that climbs over a ridge stopped working. The
  east-west and north-south cells also differ by cos(latitude), which no single
  factor absorbs.
- Compound frames whose vertical unit differs from the horizontal one are
  affected for the same reason: two different factors do not cancel.

Interpolated void heights in those two cases come from a differently weighted
blend in v0.6.1 than in v0.6.2, and so does everything derived from them:
contours, the terrain derivatives, volumes, the hold-out figures.

Measured cells are kept verbatim by the fill, in any frame.

There is no in-place correction for an existing deliverable. Regenerate from the
source cloud in v0.6.2. A deliverable from a metre-over-metre or foot-over-foot
projected scan needs no action, because its heights did not move.

## 2. PDF report footprint read a Y-up scan's extents as Z-up

`footprintMetres` (`src/report/reportFootprint.ts`) assumed the source frame was
Z-up. PLY, OBJ and glTF load in their native Y-up frame, where Y carries height
and Z carries ground depth. The on-screen Scan Report swizzled by `isZUpFormat`
and was correct; the PDF path did not, so the two disagreed on every mesh-format
scan.

Three figures on the page were wrong for those formats. Depth printed the
building's height and Height printed the ground depth, while Density divided the
point count by a vertical cross-section rather than by the ground footprint.

Measured on a 30 x 40 m footprint 8 m tall with 120,000 points: Depth read 8 m
where 40 m is correct, and density read 500 pts/m2 where 100 pts/m2 is correct,
a fivefold overstatement. On a compound CRS the vertical unit factor also landed
on a horizontal span, so Height read 12.192 m where 2.4384 m is correct.

Affects every PDF report generated from a PLY, OBJ or glTF scan by v0.6.1 or
earlier. LAS-family, COPC and EPT scans are Z-up by specification, so their
reports are unchanged.

Recovery for a single-unit scan: the printed Depth and Height are each other's
values, and the correct density is the printed density multiplied by the printed
Depth and divided by the printed Height. For the example above, 500 x 8 / 40 =
100 pts/m2. On a compound CRS the unit factor is on the wrong axis as well, so a
swap does not recover the figures. Regenerate the report in v0.6.2.

## 3. A declared linear unit that could not be resolved was answered as metres

`crsFromGeoTiff` (`src/io/crs.ts`) mapped `ProjLinearUnitsGeoKey` (3076) through
a table of 9001 metre, 9002 international foot and 9003 US survey foot. A
projected CRS declaring any other code fell through to the projected-CRS default
of metre with a factor of 1. For a British-foot CRS (9095), `toMetres(100)`
returned 100 where roughly 30.48 is correct. Every length, area, volume or
density derived from such a file went to the page in metres while the numbers
were still in the source unit. The wrong answer was also unreachable by any
gate: a file declaring a unit the software cannot honour resolved identically to
a file declaring no unit at all, so nothing downstream could tell the two apart
and no refusal could fire.

v0.6.2 resolves a declared-but-unmappable code to `unknown`, which the
downstream `linearUnit !== 'unknown'` gates read and withhold the label for. An
absent key still takes the GeoTIFF default.

The correction makes such a file refusable, not convertible. The application
still cannot convert 9095. Figures already produced from one of these files are
not repaired by opening it in v0.6.2; they need the unit supplied and the
measurement re-derived, or the file relabelled with a downstream tool.

Affects any GeoTIFF-georeferenced source whose `ProjLinearUnitsGeoKey` falls
outside 9001/9002/9003. That is LAS 1.2, COPC and EPT, plus any LAS 1.4 file
carrying a GeoKeyDirectory.

## 4. LAS 1.4 vertical CRS was discarded on read

`parseCrsFromVlrs` (`src/io/crs.ts`) treated the OGC WKT record and the
GeoKeyDirectory record as alternatives: when a WKT was present it returned
`crsFromWkt(...)` and dropped the GeoKeyDirectory entirely.

This application's own LAS 1.4 writer places the vertical datum (GeoKey 4096)
and the vertical unit (4099) beside a horizontal-only WKT. That is what LAS 1.4
permits, and it is what v0.6.1 changed the writer to do. Most WKT describes the
horizontal frame only, including every WKT `wktForEpsg` derives, so the read path
threw away the only record carrying the vertical.

`verticalEpsg` and the vertical unit read back as `undefined`.

A file declaring neither leaves the terrain tools falling back to metres, so a
NAVD88 height in US survey feet was taken for metres, wrong by a factor of 3.28.
Every elevation inherits that, and so does every contour interval, slope figure
and cut/fill volume computed from it. The written files are correct, because the
loss is on read: the defect does not damage an archive, it damages what was
computed from one. Affects every file this application wrote as LAS 1.4 with a
source WKT or a `wktForEpsg`-derived one, whenever that file was opened again in
v0.6.1.

Recovery: reopen the file in v0.6.2 and regenerate anything derived from it. The
vertical datum and unit read back from the GeoKeys, with the WKT still the sole
authority on the horizontal frame and on any vertical axis it declares itself.
Nothing about the file on disk changes.

## What is not corrected here

A vertical reference the source never declared cannot be recovered by any of
these fixes. Files written by v0.6.0 and earlier carry no vertical GeoKeys
beside a WKT at all, because the writer treated the two records as alternatives
until v0.6.1. Those files state no vertical reference and reading them in v0.6.2
does not invent one.
