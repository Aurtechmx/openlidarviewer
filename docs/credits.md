# Data sources & credits

OpenLiDARViewer streams its sample datasets directly from public, openly hosted
buckets. The project does not host or own them. The providers are credited
below. To change or remove a dataset, email info@aurtech.mx.

## Sample datasets

| Dataset | Provider | Terms |
| --- | --- | --- |
| San Francisco · Los Angeles block 2 · Denver Metro (DRCOG) · Grand Canyon NP | USGS 3DEP | Public domain |
| Switzerland: swisssurface3D (2022) | swisstopo, via FLAI | [swisstopo free geodata terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices), © swisstopo |
| Slovenia: GURS CLSS (2023) | GURS, via FLAI | CC BY 4.0 (© GURS) |

The sample datasets are shown for demonstration. They are the publishers' data as
published, with no warranty from OpenLiDARViewer of their accuracy, completeness
or availability, and they are not survey evidence for any purpose. A provider can
move or withdraw a file at any time.

USGS 3DEP streams from the AWS Registry of Open Data bucket and asks for the
courtesy citation: "Data available from U.S. Geological Survey, National
Geospatial Program."

### The start-screen sample scan

The "Launch a sample" button on the start screen streams one object, recorded
here because the AWS Registry of Open Data notes that terms vary per dataset and
directs users to each dataset's own licence.

| Field | Value |
| --- | --- |
| Object | `data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz` |
| Bucket | `open-lidar-data` (eu-central-1), FLAI Open LiDAR Data |
| Dataset | swissSURFACE3D (2022) |
| Original publisher | swisstopo (Swiss Federal Office of Topography) |
| Terms | [swisstopo free geodata terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices), © swisstopo |
| Approx. size | 83.8 MB (streamed progressively: the viewer fetches only the resident set) |
| Transport verified | HTTP 206 partial content, `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *` (checked 2026-07-19) |

Nothing is uploaded. The object is fetched by range request straight into the
browser. There is no built-in copy of the sample. The button asks for confirmation
only when the object is 250 MB or more on a cellular connection, or 1.2 GB or more
on a phone, so for this 83.8 MB object no confirmation appears. If the object is
withdrawn or moved, the button fails with a toast naming the fetch failure, and the
rest of the start screen keeps working.

## Formats & tooling

The viewer reads formats and uses tools maintained by Hobu, Inc. and other contributors:

- laz-perf (Apache-2.0): the in-browser LAZ decoder
- COPC (Cloud Optimized Point Cloud): the open streaming format
- EPT / Entwine: the hierarchical point-tile format and the Entwine tool that builds it

## Built with

The viewer is built on these open-source projects:

- three.js: the WebGPU/WebGL rendering engine
- loaders.gl: glTF, OBJ and PLY parsing (LAS is parsed by the project's own reader)
- laz-perf: LAZ decoding
- proj4js: coordinate-system transforms
- pdf-lib: the PDF reports
- spe-check (A. Urias, MIT): the draw precision bound, from "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU"

Fonts: Olv Font, a modified version of Poppins by the Poppins Project Authors,
Inter by Rasmus Andersson, and JetBrains Mono by the JetBrains Mono authors, all
under the SIL Open Font License.

## Privacy

Files you open are processed on your device and are not uploaded. A remote
dataset or sample is downloaded from the server that hosts it. A location search
in the public LiDAR catalogue is sent to Microsoft Planetary Computer, only when
you run one, and opening a result sends a request to its signing service
carrying that tile's address. See [PRIVACY.md](../PRIVACY.md).

Full license details for every bundled dependency are in
[THIRD_PARTY_NOTICES.md](project/THIRD_PARTY_NOTICES.md).

## License and source

OpenLiDARViewer v0.6.7 and later is licensed under AGPL-3.0-only. Releases
through v0.6.6 were distributed under MIT and remain under those terms. The
source is on [GitHub](https://github.com/aurtechmx/openlidarviewer). Commercial
licensing is available separately from Aur Technologies for eligible components
and use cases; write to alex@aurtech.mx.
