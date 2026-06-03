# Research & Development Notes

OpenLiDARViewer is an experiment in one question: how far can modern browser technology go in making LiDAR and point-cloud data easy to reach?

## What the project investigates

It looks at browser-native point-cloud rendering, and how far a pure-browser pipeline can go for real LiDAR datasets without desktop GIS software. It explores a lightweight WebGL/WebGPU rendering path that targets both backends from one code base, including the trade-offs of the WebGPU point primitive, and screen-space depth cueing (Eye Dome Lighting) written once as a node graph that compiles to both backends. It studies human-centered point-cloud interaction, making 3D spatial data approachable through game-inspired navigation rather than GIS conventions. It tests local-first workflows that keep sensitive geospatial data on-device, with nothing uploaded. And it works on simpler interfaces for complex datasets, compressing scan metadata, quality reporting, styling, and measurement into one understandable panel.

Two practical threads run through all of that: scan metadata and quality visualization (point count, extent, density, spacing, attribute coverage, and integrity diagnostics), and measurement inside point clouds for documentation and research.

## Why a browser

A browser viewer removes installation, platform, and licensing friction. It makes a scan about as easy to open as an image. And because the data never leaves the device, it keeps confidential survey data private. The cost is working inside browser memory limits and GPU capabilities, and that constraint shapes the project's performance and format roadmap.

## Scope

The goal is not to replace full GIS, photogrammetry, or survey-grade processing suites. It is to give people a fast, approachable way to open, inspect, navigate, measure, and present point clouds, and to serve as a testbed for browser-native spatial computing ideas.

## Honest positioning

OpenLiDARViewer is an R&D-stage open-source tool. A capability is described as implemented only when the code supports it. Measurement is for visual inspection, not survey-grade use, unless it has been validated against survey-grade data and procedures.
