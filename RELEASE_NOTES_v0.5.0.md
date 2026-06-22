# OpenLiDARViewer v0.5.0

The first release on the v0.5 line: measure to real points, place a scan on the
map, compare two epochs of the same site, and share the result in a format
people already open. Still browser-native and local-first. Nothing is uploaded.

## Measure to real points

The measure tools can now snap. A toggle on the measure rail cycles Off, Point,
and Geometry. Point mode pulls a placed vertex to the nearest actual return in
the cloud; Geometry mode also snaps to the vertices, midpoints, and crossings of
measurements already placed. The readout names what each click landed on, so a
snap to a real return reads differently from a snap to constructed geometry — a
measurement never implies a point that isn't there.

## Compare two epochs

Load two scans of the same site and the Layers section offers Compare elevation.
It builds a ground surface for each scan on one shared grid and differences them,
reporting cut and fill volumes and how much of the area changed beyond the
detection floor. Change detection is the easiest analysis to mislead with, so the
comparison states its co-registration plainly: if the two epochs sit at different
origins, use different coordinate systems, or declare different vertical datums,
it says so and treats the difference as indicative rather than measured.

## Place and share: KML export

A georeferenced scan can export its annotations, measurements, and saved views as
a KML file that opens in Google Earth or QGIS without the point cloud. Every
feature carries its own description with the coordinate system, the units, and a
"not survey-grade unless validated" note, so the caveat travels inside the file
and cannot be lost when a single placemark is copied out of it. Offered only when
the scan is georeferenced, since KML needs latitude and longitude.

## Layers

Loaded scans get a per-layer manager: show or hide each one, isolate a single
layer, and lock a layer so it stays drawn but is excluded from picking and
measuring — a reference scan cannot steal a click from the one being worked on.
When two layers do not share a coordinate system or vertical datum, the panel
flags the mismatched rows and explains that an overlay may be misaligned, rather
than stacking mismatched coordinates silently.

## Clip box

A clip control isolates a region of the scan: enable it, choose keep-inside or
keep-outside, set the six box extents or fit them to the scan, and read the exact
count of points kept. Useful for measuring or reporting on one part of a large
cloud.

## Fixes

- **Cut/fill volume on Y-up scans.** The Volume measurement read heights along a
  fixed Z axis even on Y-up clouds (iPhone and mobile PLY, OBJ, GLB/GLTF), while
  its reference plane already used the cloud's real up-axis — so the two
  disagreed and the reported volume was wrong. The sampler now reads the cloud's
  configured up direction. Z-up surveys (LAS/LAZ/E57) and streaming COPC/EPT,
  which are Z-up by spec, were unaffected.
- **Clip control on first load.** The clip control no longer raises an error on a
  fresh page load before a scan is open.
- **One sRGB colour curve.** The linear-to-sRGB encode used by the colour
  provenance card and the neighbourhood splat now reads from a single
  definition, so the displayed colour cannot drift from the curve the renderer
  uploads.

The confidence figures and quality grades describe the delivered data; they are
not a survey-grade certification. Treat terrain products, exports, and epoch
comparisons as deliverable-ready only when the assessment reads **Good**, and
validate against ground control where survey-grade accuracy is required.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
