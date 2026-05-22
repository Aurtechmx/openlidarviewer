# Changelog

All notable changes to OpenLiDARViewer are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Browser-based, local-first point-cloud viewer with drag-and-drop loading
- Import: LAS, LAZ, PLY, OBJ, GLB, GLTF, XYZ, CSV
- Export: PLY, OBJ, XYZ, CSV, and PNG snapshots
- WebGPU rendering with an automatic, fully tested WebGL 2 fallback
- Height, intensity, classification, and RGB color modes
- Orbit / Walk / Fly navigation with WASD movement and pointer-lock mouse-look
- Distance measurement inside the point cloud
- Point inspection — click a point to read its real-world coordinates,
  intensity, classification, colour, layer, and index, with one-click copy
  to the clipboard
- Scan Intelligence panel — point count, dimensions, density, spacing,
  detected attributes, and an Advanced report with the georeferenced
  bounding box and integrity diagnostics
- "Project ready" summary card shown on load
- Saved camera views
- Coordinate bridge for precise handling of large georeferenced coordinates
- Capture provenance — sensor, source software, and creation date read from
  the LAS/LAZ header and shown in the Scan Report when the file carries them
- Embed mode (`?embed=1`)
- Documentation suite (`README`, `docs/`) and reference screenshots

### Changed

- Faster loading of large LAS/LAZ scans — a lighter voxel-downsample inner
  loop and a single-pass budget search cut parsing time substantially

### Planned

- Expanded format support — E57, COPC LAZ, 3D Tiles / PNTS
- Polyline, area, and height-difference measurement
- Slicing, clipping, and annotation tools
- Large-scale dataset streaming and level-of-detail

See [`docs/roadmap.md`](docs/roadmap.md) for the full roadmap.
