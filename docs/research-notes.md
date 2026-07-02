# Research & Development Notes

OpenLiDARViewer is an experiment in one question: how far can modern browser technology go in making LiDAR and point-cloud data easy to reach?

## What the project investigates

It looks at browser-native point-cloud rendering, and how far a pure-browser pipeline can go for real LiDAR datasets without desktop GIS software. It explores a lightweight WebGL/WebGPU rendering path that targets both backends from one code base, including the trade-offs of the WebGPU point primitive, and screen-space depth cueing (Eye Dome Lighting) written once as a node graph that compiles to both backends. It studies human-centered point-cloud interaction, making 3D spatial data approachable through game-inspired navigation rather than GIS conventions. It tests local-first workflows that keep data on-device, with nothing uploaded. And it works on simpler interfaces for complex datasets, compressing scan metadata, quality reporting, styling, and measurement into one understandable panel.

Two practical threads run through all of that: scan metadata and quality visualization (point count, extent, density, spacing, attribute coverage, and integrity diagnostics), and measurement inside point clouds for documentation and research.

## Why a browser

A browser viewer removes installation, platform, and licensing friction. It makes a scan about as easy to open as an image. And because the data never leaves the device, nothing is sent anywhere. The cost is working inside browser memory limits and GPU capabilities, and that constraint shapes the project's performance and format roadmap.

## Scope

The goal is not to replace full GIS, photogrammetry, or survey-grade processing suites. It is to give people a fast, approachable way to open, inspect, navigate, measure, and present point clouds, and to serve as a testbed for browser-native spatial computing ideas.

## Terrain complexity (v0.5.4)

The terrain stack computes two established geomorphometric descriptors, implemented from the primary literature (no third-party implementation consulted — pyTopoComplexity, Lai et al. 2025, doi:10.5194/esurf-13-417-2025, is AGPL prior art and was not read):

- **VRM** (Sappington, Longshore & Thompson 2007, doi:10.2193/2005-723) — slope-decoupled ruggedness in [0, 1] over a **3×3-cell window** (ground-metre size always stated), dimensionless, reported as median + IQR. Chosen over surface-area rugosity (Jenness 2004) and TRI-style measures precisely because those conflate steepness with complexity; VRM's slope-independence is CI-guarded with an analytic constant-45°-plane fixture (`npm run repro`, metric M5).
- **TPI + six-class slope position** (Weiss 2001) — the neighbourhood radius targets ~10 m, clamped to 2–10 cells, with the **achieved radius reported in cells and ground metres**; TPI is in the grid's own Z units (stated), stdTPI and the classes are unit-free.

Both carry the project's honesty envelope: confidence **derived** from data support (valid fraction × window support), median + IQR mandatory, NoData windows shrink and never invent a neighbourhood. When scan density is **below 4 pts/m²** a cited caveat attaches (Münzinger et al. 2022, doi:10.1016/j.ufug.2022.127637 — the reliability threshold; LaRue et al., doi:10.5281/zenodo.6463393 — density-sensitivity evidence): a warning, never a block. Reports and export provenance record metric name, window/radius in cells and ground units, Z units, the Horn slope/aspect convention, confidence, and caveats — reproducible parameters.

**Deferred planned methods:** multi-scale TPI (ten-class landforms), Booth et al. 2009 wavelet curvature, fractal dimension by variogram, arc–chord ratio (Du Preez 2015, doi:10.1007/s10980-014-0118-8), PROTECT-style cross-sections, an optional MCC ground filter (Evans & Hudak 2007, doi:10.1109/TGRS.2006.890412), and per-segment lasso IDs (prior art: Papucci & Yrttimaa 2026, doi:10.5281/zenodo.20395900); archaeological local-relief applications per Niculiță 2020 (doi:10.3390/s20041192).

## Honest positioning

OpenLiDARViewer is an R&D-stage open-source tool. A capability is described as implemented only when the code supports it. Measurement is for visual inspection, not survey-grade use, unless it has been validated against survey-grade data and procedures.
