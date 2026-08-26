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
| Switzerland — swisssurface3D (2022) | **swisstopo**, via FLAI | [swisstopo free geodata terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices), © swisstopo |
| Slovenia — GURS CLSS (2023) | **GURS**, via FLAI | CC BY 4.0 (© GURS) |

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
| Object | `data/SI/GURS/CLSS_2023/copc/GKOT_433_100.copc.laz` |
| Bucket | `open-lidar-data` (eu-central-1), FLAI Open LiDAR Data |
| Dataset | Slovenia GURS CLSS 2023 |
| Original publisher | GURS (Surveying and Mapping Authority of the Republic of Slovenia) |
| Terms | CC BY 4.0, © GURS |
| Approx. size | 202 MB (streamed progressively — the viewer fetches only the resident set) |
| Record verified | 2026-05-29, the `verifiedAt` its catalog record carries. No range-request check against this object is recorded in this repository. |

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
[THIRD_PARTY_NOTICES.md](project/THIRD_PARTY_NOTICES.md).
