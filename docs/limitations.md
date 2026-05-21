# Current Limitations

OpenLiDARViewer is an active R&D-stage project focused on lightweight visualization and interaction. It is not meant to replace full GIS, photogrammetry, or survey-grade processing tools. Being clear about the limits is part of the design.

## Known limitations

Large files are limited by browser memory and GPU performance. Clouds above the point budget are voxel-downsampled.

Format coverage is still evolving. Some LiDAR formats need preprocessing or conversion before they load. See [supported-formats.md](supported-formats.md).

Measurement is for visual inspection. Straight-line distance is meant for inspection and documentation. It is not survey-grade and should not be treated as such unless it has been validated against survey-grade data and procedures.

Coordinate reference systems are handled only loosely. The viewer recenters large coordinates for precision, but it does not do full CRS handling or reprojection.

Classification visualization depends on classification attributes actually being present in the file, and many scans carry none.

Very large datasets, on the order of billions of points, need tiling, downsampling, or streaming formats that are not implemented yet.

WebGPU feature support varies by browser. Where it is unavailable, the viewer uses its WebGL 2 fallback.

OBJ and glTF meshes are shown as their vertices. Faces and materials are not rendered.

## Not in scope, for now

Full GIS layers and analysis, photogrammetry, survey-grade measurement, CRS reprojection, and editing of point data are deliberately left to dedicated tools.

## Reporting issues

If something does not work as described, please open an issue. See [CONTRIBUTING.md](../CONTRIBUTING.md). Do not attach sensitive scan data to public issues. See [SECURITY.md](../SECURITY.md).
