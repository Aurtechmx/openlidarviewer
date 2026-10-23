# Current Limitations

OpenLiDARViewer is a viewer for inspecting and documenting point clouds. It does not replace full GIS, photogrammetry or survey-grade processing tools.

## Files and memory

- **Large files** are limited by browser memory and GPU performance. A cloud above the point budget loads at reduced density and says so in the status toast.
- **Streaming.** COPC and EPT, local or on a CORS-enabled host, stream progressively. A very large uncompressed LAS, or a chunked LAZ, is indexed into browser storage and streamed the same way. That index is a cache the browser may clear, and when storage is too small an evenly spread sample of the file opens instead, labelled as a sample. One streamed source is open at a time.
- **LAZ speed** is bounded by the decoder. Fast load lowers the memory peak of a large LAZ but does not make it proportionally faster.
- **E57** covers common terrestrial-scanner files (Cartesian XYZ with colour, intensity, classification and normals). A file of about 900 MB or more is refused; convert it to LAS, LAZ or COPC. Scans stored only as spherical coordinates are skipped with a warning. Uncommon schema features may not load.
- **Meshes.** OBJ and glTF are shown as their vertices; faces and materials are not drawn. A glTF must be GLB or self-contained, and Draco-compressed glTF is refused.
- **Other formats** may need conversion first. See [supported-formats.md](supported-formats.md).
- **Remote URLs** that point at private or local network hosts are refused.

## Measurement and terrain

- **Measurement** is for visual inspection and is not survey-grade. Measurements are kept for the browser session; export the session JSON to keep them.
- **Terrain products** (DTM, DSM, canopy height, slope, hillshade, contours, DEM export) carry a Good, Preview, Limited or Blocked verdict. Confidence is a data-quality estimate, not a survey certification. Treat results as deliverable-ready only when the verdict is Good, and validate Preview and Limited results independently. See [terrain-intelligence.md](terrain-intelligence.md) and [validation/terrain-validation-matrix.md](validation/terrain-validation-matrix.md).
- **Volumes** are area-weighted per cell. The uncertainty band is a diagnostic of surface spread, not a confidence interval.
- **Noise and Withheld points.** Epoch change and the volume tools leave out ASPRS noise classes 7 and 18 and state the count. On a voxel-reduced cloud they cannot be separated, and the result says so.
- **Classification** colouring needs classification values in the file, and many scans have none.
- **Precision.** Positions are held as 32-bit floats around a local origin. This is sub-millimetre for a normal survey scan and coarser over very wide extents; the Scan Report states the figure and terrain deliverables are declined above a 10 mm step. On such a scan a measured figure that the step cannot give within 1 cm is withheld with the reason. See [coordinate-precision.md](coordinate-precision.md).

## Coordinate systems

The viewer reads the CRS, vertical datum and units from the file and uses them for measurement, density and export metadata. Metric figures are withheld when the unit is unknown, and area and volume are refused on a geographic-degree grid.

Terrain analysis on Web Mercator data (such as USGS EPT) is scaled for latitude and refused when the scan is too large for one scale to hold; load a smaller area or reproject to a local projected CRS. Scans beyond ±89° latitude, depth-down vertical references and geocentric CRS are refused.

Reprojection happens only on export. It changes X and Y to a chosen EPSG code, leaves Z and its vertical reference unchanged, and refuses NAD27. Measurement, terrain analysis and epoch comparison work in the source coordinates, and a comparison across different datums is blocked.

## Display

WebGPU support varies by browser; the viewer falls back to WebGL 2. Eye Dome Lighting is a screen-space depth cue, not physical lighting, and is off by default on the WebGL 2 fallback and on mobile.

## Not in scope

Full GIS layers and analysis, photogrammetry, survey-grade measurement, vertical-datum transformation and editing of point data are left to dedicated tools.

The complete, itemised list for this release is in [KNOWN_LIMITATIONS_v0.7.0.md](releases/KNOWN_LIMITATIONS_v0.7.0.md).

## Reporting issues

If something does not work as described, please open an issue. See [CONTRIBUTING.md](../.github/CONTRIBUTING.md).
