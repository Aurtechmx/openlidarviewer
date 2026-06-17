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
| Autzen · "360 for you" · Key Bridge · Puerto Rico (FEMA 2018) · Sofia · Cahokia Mounds | **Hobu, Inc.** | Public demo data |
| Mill site | **Entwine** (Hobu, Inc.) | Public demo data |
| SF Coast · Los Angeles · Denver · Golden Gate · Grand Canyon NP · San Francisco · Denver Metro (DRCOG) | **USGS 3DEP** | Public domain |
| Switzerland — swisssurface3D (2022) | **swisstopo**, via FLAI | Swiss open data |
| Slovenia — GURS CLSS (2023) | **GURS**, via FLAI | CC BY 4.0 |
| Netherlands — AHN4 (2020–22) | **AHN**, via FLAI | Public domain |

USGS 3DEP streams from the AWS Registry of Open Data bucket and asks for the
courtesy citation: "Data available from U.S. Geological Survey, National
Geospatial Program."

## Formats & tooling

Built on the open point-cloud ecosystem from **Howard Butler** and **Hobu, Inc.**:

- **laz-perf** (Apache-2.0) — the in-browser LAZ decoder
- **COPC** — the streaming format
- **EPT / Entwine** — the hierarchical tiling format and builder

Thank you to Howard Butler, Hobu, and the PDAL / COPC community.
