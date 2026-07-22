Nothing here changes what you see. Open alpha.3 next to alpha.2 and the viewer looks and behaves the same.

This cut continues the work under the surface: pulling testable logic out of the two files that hold most of the application, adding guards so that work cannot quietly regress, and measuring the one open coordinate-integrity item so its fix has a number to beat.

Pre-release for evaluation, so pin the commit if you depend on current behaviour. Browser-native and local-first as always: files stay on your device, no account.

## More of the two monoliths is now testable

Six pieces of logic moved off the render class and the app entry into their own modules, each with Node tests it could not have while embedded in a class that needs a WebGL context or the DOM:

- the lasso-volume selection walk,
- the two-finger touch tracker,
- the render-frame decision,
- the streaming compatibility boundary,
- remote-source naming and error text,
- two measure helpers (volume-record shaping and horizontal span).

`Viewer.ts` went from 7,297 to 7,127 lines and `main.ts` from 7,636 to 7,521, but the line count is not the point. The exit condition is that every cluster with a real boundary and a test payoff is extracted; what remains is genuinely view-bound, and moving it would relocate glue without gaining a test.

## Guards so it cannot slip back

Two shrink-only ratchets now run in the release gate. One holds the world-coordinate read surface, the other the two large files: both may fall, never grow. A decomposition step cannot be undone by accident, and no busywork extraction is forced to chase a number.

## The open precision item, measured

The one coordinate-integrity item left is that the project transform rewrites Float32 positions in place. This cut measures exactly what that costs. A mount and unmount moves a point about 0.06 mm at 1 km of separation and 3.9 mm at 100 km, and repeated cycles do not add to it: the error saturates after the first. The defect is exact reversibility, not runaway drift, which is a smaller problem than the roadmap assumed and is what the Float64 transform will close.

Slope reached E4. OpenLiDARViewer's Horn slope was independently cross-implemented against GDAL 3.13.1 on a frozen analytic DEM; OpenLiDARViewer, GDAL and the closed-form gradient agreed over 11,564 interior cells, with an OpenLiDARViewer-to-GDAL maximum difference of about 0.000037 degree, inside the preregistered 0.5 degree tolerance. This is E4 evidence for the slope-raster algorithm on this fixture only. Every other independent-reference slot remains pending, and it does not validate the point-cloud-to-DTM pipeline, other terrain products, field accuracy or survey-grade use.

## Known limitations

Unchanged from alpha.2, and stated in full in `KNOWN_LIMITATIONS_v0.6.0-alpha.3.md`. In brief: multi-layer mounting is disabled, the project transform still rewrites Float32 positions, and there is no cross-CRS reprojection. Slope is cross-implementation validated (E4) against GDAL on the analytic fixture; every other terrain product tops out at internal self-consistency (E3), with no field validation and no survey-grade claim.

## Compatibility

Chromium-based browsers (Chrome, Edge) with WebGPU; Firefox and Safari fall back to WebGL 2. Reads LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX, PTS, and streams COPC and EPT. Everything from alpha.2 remains and behaves the same way.

## Deploy

Static files. GitHub Pages, Netlify, any CDN or conventional host.

## Citing

Metadata in `CITATION.cff`.

* Version: 0.6.0-alpha.3
* Release date: 2026-07-22
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)

Open Source • Open Data • Open Exploration
