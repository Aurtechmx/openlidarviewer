# Changelog

The format is based on Keep a Changelog and the project follows Semantic Versioning.

## [0.4.0] - 2026-06-03

### Added

- Terrain analysis (preview): a confidence-aware DTM and contour pipeline with
  a mounted Analyse panel. Classifies ground, validates the surface, gates a
  professional export behind quality (CRS, vertical datum, coverage), and
  exports evidence-graded contours as GeoJSON, SVG, and DXF.
- Cross-section profiles export a full-page, scaled PDF with a
  station / elevation / grade table and civil summary.

### Fixed

- Long measurement readings and dataset/layer names no longer overflow their
  panels.

## [0.3.10] - 2026-06-02

Browser-based LiDAR and point-cloud viewer. Loads LAS, LAZ, E57, PLY, PCD,
PTS, PTX and streams COPC, EPT, and 3D Tiles, entirely client-side on WebGPU
with a WebGL2 fallback. Includes measurement, annotation, classification,
cross-section profiles, volume, PDF reporting, and image export.
