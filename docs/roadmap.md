# Roadmap

OpenLiDARViewer is an R&D-stage project. This roadmap is intentionally ambitious but honest. Items here are not implemented yet. Current capabilities are listed in the [README](../README.md#features). Priorities may change, and nothing here is a delivery commitment.

## Core viewer

- [ ] Performance presets for large datasets
- [ ] Level-of-detail rendering
- [ ] Sample datasets and demo scenes

## Rendering

- [x] Eye Dome Lighting depth shading
- [x] Adaptive point sizing, with a fixed mode
- [x] Round, antialiased points
- [ ] Background themes — dark / scientific / presentation (0.3.0)
- [ ] Premium loading-state transitions (0.3.0)
- [ ] Mobile-adaptive rendering — graceful degradation on weak GPUs (0.3.0)

## Format support

- [x] E57 import — terrestrial laser-scanner data (ASTM E2807)
- [ ] Broaden LAS / LAZ point-format coverage
- [ ] Broaden E57 coverage — spherical coordinates, uncommon schema features
- [ ] PCD, PTS / PTX import
- [x] COPC LAZ for cloud-optimised point clouds — progressive octree streaming (0.3.0)
- [ ] 3D Tiles / PNTS streaming
- [ ] Better iPhone LiDAR export compatibility
- [ ] Better drone LiDAR workflow compatibility

## Navigation

- [ ] Camera path recording
- [ ] Mobile and tablet inspection mode
- [ ] Configurable control bindings

## Measurement and inspection

- [x] Polyline measurement
- [x] Area measurement — own-plane and horizontal
- [x] Height-difference measurement
- [x] Angle and slope measurement
- [x] Measurement editing, units toggle, and JSON session export/import
- [x] Annotations — categorised markers, notes, panel, and search (0.2.8)
- [x] Camera-state capture and inspection-session persistence (0.2.8)
- [x] Live point probe and an extended point inspector (0.2.8)
- [ ] Cross-section and profile tools

## Performance

- [x] Budget-aware fast loading — header preflight, stride decode, memory guard (0.2.7)
- [x] Streamed point-cloud datasets — COPC progressive octree streaming (0.3.0)
- [ ] Streaming workflows for billion-point clouds

## Export and reporting

- [x] Screenshot export with measurement and annotation overlays (0.2.8)
- [ ] Exportable scan reports
- [ ] More export targets

## Research features

- [ ] Slicing and clipping tools
- [ ] Box-selection feeding the analysis modules
- [ ] A deeper analysis-module suite
- [ ] More automated tests for core parsing and export utilities
