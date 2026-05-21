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
- Scan Intelligence panel — point count, dimensions, density, spacing,
  detected attributes, and an Advanced report of integrity diagnostics
- "Project ready" summary card shown on load
- Saved camera views
- Coordinate bridge for precise handling of large georeferenced coordinates
- Embed mode (`?embed=1`)
- Documentation suite (`README`, `docs/`) and reference screenshots

### Planned

- Expanded format support — E57, COPC LAZ, 3D Tiles / PNTS
- Scan metadata — capture sensor / equipment and date detection
- Polyline, area, and height-difference measurement
- Slicing, clipping, and annotation tools
- Large-scale dataset streaming and level-of-detail

See [`docs/roadmap.md`](docs/roadmap.md) for the full roadmap.
