# Roadmap

OpenLiDARViewer is an R&D-stage project. This roadmap is intentionally ambitious but honest. Items here are not implemented yet. Current capabilities are listed in the [README](../README.md#features). Priorities may change, and nothing here is a delivery commitment.

## Core viewer

- [ ] Performance presets for large datasets
- [ ] Level-of-detail rendering
- [ ] Sample datasets and demo scenes

## Format support

- [ ] Broaden LAS / LAZ point-format coverage
- [ ] E57 import
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

- [ ] Polyline measurement
- [ ] Area measurement
- [ ] Height-difference measurement
- [ ] Cross-section and profile tools
- [ ] Annotation tools

## Performance

- [ ] Tiled and streamed point-cloud datasets
- [ ] Streaming workflows for billion-point clouds

## Export and reporting

- [ ] Exportable scan reports
- [ ] More export targets

## Research features

- [ ] Scan metadata: detect the capture sensor or equipment and the date from the file header (for example the LAS System Identifier, Generating Software, and creation date) and show them in the Scan Report
- [ ] Slicing and clipping tools
- [ ] Box-selection feeding the analysis modules
- [ ] A deeper analysis-module suite
- [ ] More automated tests for core parsing and export utilities
