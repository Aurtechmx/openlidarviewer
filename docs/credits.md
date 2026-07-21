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

### The start-screen sample scan

The "Try a sample scan" action on the start screen streams ONE specific object,
recorded here so the attribution is not inferred from the bucket in general —
the AWS Registry of Open Data notes that terms vary per dataset and directs users
to each dataset's own licence.

| Field | Value |
| --- | --- |
| Object | `data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz` |
| Bucket | `open-lidar-data` (eu-central-1), FLAI Open LiDAR Data |
| Dataset | swissSURFACE3D (2022) |
| Original publisher | swisstopo (Swiss Federal Office of Topography) |
| Terms | Swiss open government data; consult swisstopo's own licence for the dataset |
| Approx. size | 83.8 MB (streamed progressively — the viewer fetches only the resident set) |
| Transport verified | HTTP 206 partial content, `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *` (checked 2026-07-19) |

Nothing is uploaded: the object is fetched by range request straight into the
browser, and the same consent gate that covers any remote scan applies before the
first byte. If the object is ever withdrawn or moved, the action fails through the
normal remote-open error path (a toast naming the fetch failure) rather than
hanging — the start screen stays usable and every other entry point is unaffected.

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
