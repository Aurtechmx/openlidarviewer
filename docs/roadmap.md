# Roadmap

OpenLiDARViewer is an R&D-stage project. This roadmap is intentionally ambitious but honest. Items here are not implemented yet. Current capabilities are listed in the [README](../README.md#features). Priorities may change, and nothing here is a delivery commitment.

## Core viewer

- [ ] Performance presets for large datasets
- [ ] Level-of-detail rendering
- [ ] Sample datasets and demo scenes

## Format support

- [x] E57 import — terrestrial laser-scanner data (ASTM E2807)
- [ ] Broaden LAS / LAZ point-format coverage
- [ ] Broaden E57 coverage — spherical coordinates, uncommon schema features
- [ ] PCD, PTS / PTX import
- [ ] COPC LAZ for cloud-optimised point clouds
- [ ] 3D Tiles / PNTS streaming
- [ ] Better iPhone LiDAR export compatibility
- [ ] Better drone LiDAR workflow compatibility

## Navigation

- [ ] Camera path recording
- [ ] Mobile and tablet inspection mode
- [ ] Configurable control bindings

## Measurement

- [x] Polyline measurement
- [x] Area measurement — own-plane and horizontal
- [x] Height-difference measurement
- [x] Angle and slope measurement
- [x] Measurement editing, units toggle, and JSON session export/import
- [ ] Cross-section and profile tools
- [ ] Annotation tools

## Performance

- [ ] Tiled and streamed point-cloud datasets
- [ ] Streaming workflows for billion-point clouds

## Export and reporting

- [ ] Exportable scan reports
- [ ] More export targets

## Research features

- [ ] Slicing and clipping tools
- [ ] Box-selection feeding the analysis modules
- [ ] A deeper analysis-module suite
- [ ] More automated tests for core parsing and export utilities
