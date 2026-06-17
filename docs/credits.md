# Data sources & credits

OpenLiDARViewer streams its sample datasets directly from public, openly-hosted
buckets — we don't host or own them. A genuine thank-you to everyone who
publishes LiDAR openly, and to the open-source projects that keep moving this
field forward; it's what makes a free, in-browser viewer like this possible.
Credit and thanks go to the providers below. To change or remove a dataset,
email **info@aurtech.mx** and we'll act on it.

## Sample datasets

| Dataset | Provider | Terms |
| --- | --- | --- |
| SF Coast · Los Angeles · Denver · Golden Gate · Grand Canyon NP · San Francisco · Denver Metro (DRCOG) | **USGS 3DEP** | Public domain |
| Switzerland — swisssurface3D (2022) | **swisstopo**, via FLAI | Swiss open data |
| Slovenia — GURS CLSS (2023) | **GURS**, via FLAI | Open data — attribution |
| Netherlands — AHN4 (2020–22) | **AHN**, via FLAI | Public domain |

USGS 3DEP streams from the AWS Registry of Open Data bucket and asks for the
courtesy citation: "Data available from U.S. Geological Survey, National
Geospatial Program."

## Formats & tooling

This viewer runs on open point-cloud formats and tools maintained by
**Hobu, Inc.** and a broad community of contributors:

- **laz-perf** (Apache-2.0) — the in-browser LAZ decoder we use to read compressed point data
- **COPC** (Cloud Optimized Point Cloud) — the open streaming format
- **EPT / Entwine** — the hierarchical point-tile format and the Entwine tool that builds it

With particular thanks to **Howard Butler** and **Hobu, Inc.**, and the wider
PDAL / COPC community.

## Built with

The viewer itself is built on open-source work we're grateful for:

- **three.js** — the WebGPU/WebGL rendering engine
- **loaders.gl** — glTF / LAS / OBJ / PLY parsing
- **proj4js** — coordinate-system transforms
- **pdf-lib** — the PDF reports

Full license details for every bundled dependency are in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
