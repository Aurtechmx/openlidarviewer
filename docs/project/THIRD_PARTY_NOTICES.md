# Third-Party Notices

OpenLiDARViewer ships with (and links against) a number of
third-party open-source packages and fonts. This document lists each
runtime dependency, its upstream project, and its license. The copyright
lines of every bundled package and the full text of every licence that applies
to them are reproduced in "Copyright notices and full licence texts" at the end
of the file.

OpenLiDARViewer itself is licensed under AGPL-3.0-only from v0.6.7 (MIT through
v0.6.6). The project license does not change the license of any component listed
here. Each component keeps its own license and notice. Every runtime component
is compatible with AGPL-3.0-only: the bundled libraries are MIT, Apache-2.0,
Zlib, or 0BSD, and the fonts are under the SIL Open Font License, all
permissive licenses that AGPL-3.0-only distribution may include. See
[../../LICENSING.md](../../LICENSING.md).

## Runtime dependencies (bundled into the shipped build)

The direct runtime dependencies declared in `package.json` are listed first,
with their upstream projects, declared range, and the version resolved in
`package-lock.json`. The complete bundled set (these plus every transitive
package that ships in the built app) follows in "Complete bundled set",
grouped by license, so attribution covers everything the build carries and not
only the direct entry points.

| Package | Declared range | Resolved | License | Upstream |
| --- | --- | --- | --- | --- |
| three | ^0.186.0 | 0.186.0 | MIT | https://github.com/mrdoob/three.js |
| @loaders.gl/core | ^4.5.2 | 4.5.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/gltf | ^4.5.2 | 4.5.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/obj | ^4.5.2 | 4.5.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/ply | ^4.5.2 | 4.5.2 | MIT | https://github.com/visgl/loaders.gl |
| laz-perf | ^0.0.7 | 0.0.7 | Apache-2.0 | https://github.com/hobuinc/laz-perf |
| pdf-lib | ^1.17.1 | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| proj4 | ^2.22.0 | 2.22.0 | MIT | https://github.com/proj4js/proj4js |
| @fontsource-variable/inter | ^5.3.0 | 5.3.0 | OFL-1.1 | https://github.com/rsms/inter |
| @fontsource/manrope | ^5.3.0 | 5.3.0 | OFL-1.1 | https://github.com/sharanda/manrope |
| @fontsource/jetbrains-mono | ^5.3.0 | 5.3.0 | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono |

### Complete bundled set (direct and transitive), grouped by license

The list below is the full production dependency set from `sbom.json`
(CycloneDX, generated with `--omit dev`): the direct runtime dependencies above
plus every transitive package they pull into the production graph. Versions are
the ones resolved in `package-lock.json` and recorded in `sbom.json`. A few
entries (`@types/*`, `undici-types`) are TypeScript type declarations that carry
no executable code; they belong to the production graph and are listed for
completeness. All of these licenses are permissive and compatible with
AGPL-3.0-only distribution; none require the distributor to relicense.

MIT (29 packages):

- @loaders.gl/core 4.5.2
- @loaders.gl/draco 4.5.2
- @loaders.gl/gltf 4.5.2
- @loaders.gl/images 4.5.2
- @loaders.gl/loader-utils 4.5.2
- @loaders.gl/obj 4.5.2
- @loaders.gl/ply 4.5.2
- @loaders.gl/schema 4.5.1
- @loaders.gl/schema-utils 4.5.2
- @loaders.gl/textures 4.5.2
- @loaders.gl/worker-utils 4.5.2
- @math.gl/core 4.1.0
- @math.gl/types 4.1.0
- @pdf-lib/standard-fonts 1.0.0
- @pdf-lib/upng 1.0.1
- @probe.gl/env 4.1.1
- @probe.gl/log 4.1.1
- @probe.gl/stats 4.1.2
- @types/geojson 7946.0.16
- @types/node 25.9.8
- json-with-bigint 3.5.12
- ktx-parse 0.7.1
- meshoptimizer 1.2.0
- mgrs 1.0.0
- pdf-lib 1.17.1
- proj4 2.22.0
- three 0.186.0
- undici-types 7.24.6
- wkt-parser 1.5.5

Apache-2.0 (4 packages):

- apache-arrow 21.2.0
- draco3d 1.5.7
- flatbuffers 25.9.23
- laz-perf 0.0.7

MIT AND Zlib (1 package):

- pako 1.0.11 (dual-licensed): both the MIT text and the Zlib text below apply.

0BSD (1 package):

- tslib 2.8.1

SIL Open Font License 1.1 (3 packages):

- @fontsource-variable/inter 5.3.0
- @fontsource/manrope 5.3.0
- @fontsource/jetbrains-mono 5.3.0

## Development-only dependencies (not bundled into the shipped build)

The following are used during typecheck, test, lint, or build only.
They are NOT distributed in `dist/` and do not need re-distribution
of their license text alongside the shipped artifact. They are listed
here for transparency.

| Package | Declared range | Resolved | License | Upstream |
| --- | --- | --- | --- | --- |
| typescript | ~7.0.2 | 7.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| vite | ^8.3.0 | 8.3.0 | MIT | https://github.com/vitejs/vite |
| vitest | ^5.0.0 | 5.0.1 | MIT | https://github.com/vitest-dev/vitest |
| vitepress | 1.6.4 | 1.6.4 | MIT | https://github.com/vuejs/vitepress |
| vite-plugin-javascript-obfuscator | ^3.1.0 | 3.1.0 | MIT | https://github.com/elmesutupu/vite-plugin-javascript-obfuscator |
| @playwright/test | ^1.63.0 | 1.63.0 | Apache-2.0 | https://github.com/microsoft/playwright |
| @types/three | ^0.186.0 | 0.186.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| rollup-plugin-visualizer | ^7.1.1 | 7.1.1 | MIT | https://github.com/btd/rollup-plugin-visualizer |
| @vitest/coverage-v8 | ^5.0.1 | 5.0.1 | MIT | https://github.com/vitest-dev/vitest |
| @stryker-mutator/core | ^10.0.0 | 10.0.0 | Apache-2.0 | https://github.com/stryker-mutator/stryker-js |
| @stryker-mutator/vitest-runner | ^10.0.0 | 10.0.0 | Apache-2.0 | https://github.com/stryker-mutator/stryker-js |
| @types/proj4 | ^2.19.0 | 2.19.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @loaders.gl/las | ^4.5.2 | 4.5.2 | MIT | https://github.com/visgl/loaders.gl |

## License texts

The full licence texts, each bundled package's copyright lines, and the NOTICE
file shipped by apache-arrow are reproduced in "Copyright notices and full
licence texts" at the end of this file. That section is generated from the
installed packages. Points it cannot read from the packages themselves:

- laz-perf (the WASM LAZ decoder) and draco3d are Apache-2.0 but their
  published packages ship no LICENSE or NOTICE file; the standard Apache-2.0
  text is reproduced for them and their copyright holders are taken from their
  upstream repositories.
- pako is distributed under `(MIT AND Zlib)`. Its own code is Copyright (C)
  2014-2017 Vitaly Puzrin and Andrei Tuputcyn; the zlib algorithms it ports are
  (C) 1995-2017 Jean-loup Gailly and Mark Adler. Both texts are reproduced.
- tslib is 0BSD, which requires no attribution; its text is reproduced anyway.

Development-only dependencies are not distributed, so their texts are not
reproduced. Their licences are listed in the table above.

## How to refresh this notice

The "Complete bundled set" list must match the production dependency set in
`sbom.json` (regenerate it with
`npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.json`). When a
dependency changes:

1. Regenerate `sbom.json` and diff its component set against the "Complete
   bundled set" list above.
2. For each added package, identify the license from its upstream repository
   (the `LICENSE` file, or `license` field in its `package.json`) and add it to
   the matching license group. Add its declared range to the direct-dependency
   table too if it is a new direct dependency.
3. Run `node scripts/gen-third-party-notices.mjs` to regenerate the copyright
   lines and licence texts from `node_modules`. If a new licence appears,
   confirm it is compatible with AGPL-3.0-only distribution, and flag it here if
   it is not.
4. For a removed package, drop it from the list (and the table, if direct).
   Leave a license-text block intact unless every package under it is gone.

`node scripts/lint-sbom.mjs` fails if any `sbom.json` component is absent from
this file or from the generated licence section, so a regenerated SBOM that
drifts from this notice is caught in CI. `npm run lint:notices` regenerates the
section in memory and fails if the committed text differs.

## Test fixtures (not shipped in the deployed app)

These small files live under `tests/` and are used only by the automated
test suite; they are not part of the published web app.

- `tests/fixtures/synthetic.e57`: project-owned SYNTHETIC E57, generated by
  `scripts/make-e57-fixture.mjs` (deterministic, no third-party data). It
  exercises the reader's exact-decode paths: a single named scan, a Float +
  1-bit Integer prototype, single-precision cartesian decode, and a bit-packed
  invalid-state column. It carries no third-party data, so its assertions run in
  CI independently of any external corpus.
- `tests/bunnyFloat.e57`: the BunnyFloat conformance file from the libE57
  example/test data (http://www.libe57.org/data.html), a single-precision Float
  cartesian profile of 30,571 points. The corpus lists it under "Cartesian
  Points" with no per-file copyright holder; the site notice is © 2010 E57.04
  3D Imaging System File Format project. Released under the libE57 Test Data
  License: free use, reproduction, display, distribution, publication, and
  transmission, with the copyright notice required in copies that are not solely
  in binary form, and the data provided "as is". Full text at
  http://www.libe57.org/data.html (section 17). Used to check the Float decode
  path against the extent the writer declared; not shipped in the deployed app.
- `tests/pumpARowColumnIndexNoInvalidPoints.e57`: a pump-room laser scan
  (gridded, XYZ + intensity + RGB) from the libE57 example/test data
  (http://www.libe57.org/data.html). © 2008 Carnahan-Proctor and Cross, Inc.
  Released under the libE57 Test Data License: free use, reproduction, display,
  distribution, publication, and transmission, with the copyright notice
  required in source (non-binary) copies and the data provided "as is". Full
  text at http://www.libe57.org/data.html (section 17). Used only to exercise
  the E57 reader and the v0.5.7 terrestrial-scan display profile; not shipped in
  the deployed app.
- `tests/fixtures/las-pdal/utm15.las` and `synthetic_test.las`: two
  single-point LAS 1.2 files from the PDAL test corpus
  (https://github.com/PDAL/PDAL, `test/data/las/`), each verified byte-identical
  to upstream. Copyright (c) 2025, Hobu, Inc. (howard@hobu.co), released under
  the BSD 3-Clause licence that covers the PDAL distribution; its text is the
  "Overall PDAL license (BSD)" section of
  https://github.com/PDAL/PDAL/blob/master/LICENSE.txt. `utm15.las` carries its
  CRS in GeoTIFF keys rather than WKT and was written by libLAS 1.2 in 2008;
  `synthetic_test.las` carries no CRS. Used to exercise the LAS CRS paths and
  the zero-extent bounding box; not shipped in the deployed app.
- `tests/fixtures/e57-libe57format/`: nine E57 files from the libE57Format
  test corpus (https://github.com/asmaloney/libE57Format-test-data, `self/`),
  generated by libE57Format itself. Dedicated to the public domain under CC0 1.0
  Universal (https://creativecommons.org/publicdomain/zero/1.0/), which requires
  no attribution. Seven are deliberately malformed or degenerate and exercise
  the reader's refusal paths; `ColouredCubeFloat.e57` and
  `ColouredCubeDouble.e57` hold the same cube at two precisions. Not shipped in
  the deployed app.
- iPhone/iPad LiDAR handheld-scan example (added in v0.5.7): a scan captured
  and provided by the project maintainer; licensed under the project's terms.
  Used to build and test the handheld-scan auto-detection.
- Generated synthetic fixtures (`tests/fixtures/**`, `tests/fixtures/copc/
  synthCopc.ts`, `public/samples/tiny.*`): created by the project, no
  third-party data; the preferred source for deterministic profile/detection
  tests so coverage does not depend on any external file.
- `tests/fixtures/tiny.las`, `tiny.laz`, `tiny.ply`, and `public/samples/tiny.*`:
  minimal point clouds generated by the project as test/sample fixtures.
  They contain no third-party survey data.

The streamed sample datasets (USGS 3DEP, swisstopo, GURS) are not bundled;
they are fetched from public open-data buckets on user request, with attribution
recorded in `public/credits.html`.

## Derived scientific validation data (committed, not shipped in the deployed app)

The terrain-field comparisons under `validation/terrain-field/` are reproducible
without a multi-gigabyte download because small DERIVED artifacts from public
LiDAR datasets are committed: ground-return crops (`crops/*.f32`, `crops/*.bin`),
their crop manifests, and cross-implementation reference rasters
(`references/*.asc`) plus checkpoint records (`references/*.json`). The RAW source
point clouds are NOT redistributed. Full per-dataset records, including bounds
and checksums, are in `validation/terrain-field/datasets/manifest.json`.

Each entry below gives the source and licence, then the committed derivative paths.
Attribution is a licence condition for the Estonian Land Board data (CC BY 4.0);
the U.S. Government sources are public domain or CC0, listed for
traceability rather than obligation.

### Estonian Land Board National LiDAR, 2020 (tile 568539, Tava area)

- Provider: Estonian Land and Spatial Development Board (Maa-amet)
- Licence: CC BY 4.0, attribution required
- DOI: <https://doi.org/10.5281/zenodo.19232743>
- Committed derivatives: `validation/terrain-field/crops/estonia-tava__ground.f32`,
  `crops/estonia-tava.crop.json`, `references/estonia-tava__bincell-dtm.asc`

### USGS Marsh Island / New Bedford MA UAS survey, 2024 (site 2025-009-FA)

- Provider: U.S. Geological Survey data release
- Licence: CC0 1.0 Universal / public domain (U.S. Government work); no use constraints
- DOI: <https://doi.org/10.5066/P19TLXVG>
- Citation: Over, J.R., Cramer, J.M., Millo, A., Brosnahan, S.M., Ackerman, S.D.,
  and Ganju, N.K., 2024, Topographic, multispectral, and GPS data collected during
  UAS operations at Marsh Island, New Bedford, Massachusetts (ver. 2.0, May 2026),
  USGS data release.
- Committed derivatives: `validation/terrain-field/crops/marsh-island__ground.f32`,
  `references/marsh-island__checkpoints.json`

### USGS AZ Coconino B1 2019 airborne LiDAR (project 19049; task order AZ_CoconinoUSFS_2019_B19)

- Provider: U.S. Geological Survey 3D Elevation Program (3DEP) / The National Map
- Licence: public domain (U.S. Geological Survey / The National Map); no use constraints
- Citation: U.S. Geological Survey, 2020, USGS Lidar Point Cloud
  AZ_CoconinoUSFS_2019_B19 (USGS project 19049; NGTOC task order 140G0219F0247,
  contract G16PC00042): U.S. Geological Survey 3D Elevation Program (3DEP). Public domain.
- Committed derivatives: `validation/terrain-field/crops/coconino__ground.f32`,
  `references/coconino-b19-2019__checkpoints.json`, `references/coconino__matched.json`,
  `references/coconino-slope__bincell-dtm.asc`, `references/coconino-slope__gdaldem-slope.asc`,
  `references/coconino-slope__slope-aspect-spotcheck.json`, and the study records
  under `validation/terrain-field/coconino/`

### USGS 3DEP LPC, White Sands NM 2020, tile w3597n3635

- Provider: USGS 3D Elevation Program (3DEP) Lidar Point Cloud
- Licence: public domain (U.S. Government work)
- Committed derivatives: `validation/terrain-field/crops/whitesands-dune__ground.f32`,
  `crops/whitesands-dune.crop.json`, `references/whitesands-dune__bincell-dtm.asc`,
  `references/whitesands-dune__pdal-dtm.asc`,
  `references/whitesands-dune__slope-aspect-spotcheck.json`

### Virginia Tech StREAM Lab Spring 2026 Drone Lidar Survey

- Provider: OpenTopography
- Licence: see the OpenTopography dataset terms at the DOI below
- DOI: <https://doi.org/10.5069/G9NZ85W7>
- Committed derivatives: `validation/terrain-field/crops/sl-field.bin`,
  `crops/sl-field.crop.json`, `references/sl-field__bincell-dtm.asc`,
  `references/sl-field__published-dtm.asc`

### Referenced but not redistributed

Two further datasets appear in the terrain-field manifest with no committed
derivative of any kind. They are cited for provenance only:

- Hyytiala UAV Point Cloud Demo Dataset 2025. Zenodo (Atherton, J. &
  Miettinen, I. E., 2026), <https://doi.org/10.5281/zenodo.20793895>
- Drone LiDAR of Pangandaran coastal tourism hotspots. Zenodo
  (Syamsuddin et al., 2025), <https://doi.org/10.5281/zenodo.17073404>

## Validation datasets with committed derived files

Statistics and small samples computed from these datasets are committed under
`validation/` and `tests/fixtures/` as validation evidence. They are not shipped in the deployed app. Each entry is
taken from `validation/datasets/dataset-register.yaml`.

### OLV-DS-090: Jemez River Basin Snow-off Lidar Survey (2010)

- Creator: National Center for Airborne Laser Mapping (NCALM), distributed by
  OpenTopography
- Title: Jemez River Basin Snow-off Lidar Survey
- Link: <https://opentopography.org/>
- Licence: CC BY 4.0, <https://creativecommons.org/licenses/by/4.0/>
- Modified: decode statistics and ground-filter agreement statistics were
  computed from tile `ot_356000_3972000_1.laz`. The point data is not
  redistributed.
- Committed derivatives: `validation/real-scene/decode-stats/OLV-DS-090.json`,
  `validation/real-scene/gf-strata/OLV-DS-090.json`

### OLV-DS-040: 3DPC of a gypsum slope in Finestrat, Alicante (Spain)

- Creator: A. Abellan (CREALP) and A. Riquelme (University of Alicante)
- Title: 3DPC of a gypsum slope in Finestrat, Alicante (Spain), 2016 epoch
- Link: <https://doi.org/10.5281/zenodo.7576524>
- Licence: CC BY 4.0, <https://creativecommons.org/licenses/by/4.0/>
- Modified: eighteen points were decoded from `Finestrat_2016.e57` and summary
  statistics were computed over the whole file. The source file is not
  redistributed.
- Committed derivatives: `tests/fixtures/e57-pdal/pdal_sample.csv`,
  `tests/fixtures/e57-pdal/pdal-reference.json`

### OLV-DS-093: 2019 USFS Lidar, Rogue River-Siskiyou National Forest, tile 10TDM3449

- Creator: USDA Forest Service and U.S. Geological Survey 3D Elevation Program
- Link: <https://www.fisheries.noaa.gov/inport/item/64356>
- Licence: public domain (work of the U.S. Government); credited as a courtesy

## EPSG coordinate-system parameters

OpenLiDARViewer derives OGC WKT for a set of EPSG codes from their published
parameters (`src/io/epsgWkt.ts`, `src/convert/epsg.ts`). The EPSG Geodetic
Parameter Dataset is © International Association of Oil & Gas Producers (IOGP);
see the EPSG Dataset Terms of Use at <https://epsg.org/terms-of-use.html>. IOGP
does not endorse this software, and recipients of the derived parameters are
subject to those terms.

<!-- generated:licence-texts:begin (scripts/gen-third-party-notices.mjs) -->

## Copyright notices and full licence texts

This section is generated from the installed packages by
`scripts/gen-third-party-notices.mjs`. Each bundled package is listed with
the copyright lines from its own licence and NOTICE files and the licence text
that applies to it; each distinct text is reproduced once at the end.

### Bundled packages

#### @fontsource-variable/inter 5.3.0

Licence: OFL-1.1. Text: T1.

- Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

#### @fontsource/jetbrains-mono 5.3.0

Licence: OFL-1.1. Text: T2.

- Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

#### @fontsource/manrope 5.3.0

Licence: OFL-1.1. Text: T3.

- Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)

#### @loaders.gl/core 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/draco 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/gltf 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/images 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/loader-utils 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/obj 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/ply 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/schema 4.5.1

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/schema-utils 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/textures 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @loaders.gl/worker-utils 4.5.2

Licence: MIT. Text: T4.

- Copyright (c) vis.gl contributors
- Copyright (c) 2015 Uber Technologies, Inc.
- Copyright 2011-2018 CesiumJS Contributors

#### @math.gl/core 4.1.0

Licence: MIT. Text: T5.

- Copyright (c) 2017 Uber Technologies, Inc.
- Copyright (c) 2015, Brandon Jones, Colin MacKenzie IV.
- Copyright © 2010-2017 three.js authors
- Copyright 2011-2018 CesiumJS Contributors

#### @math.gl/types 4.1.0

Licence: MIT. Text: T5.

- Copyright (c) 2017 Uber Technologies, Inc.
- Copyright (c) 2015, Brandon Jones, Colin MacKenzie IV.
- Copyright © 2010-2017 three.js authors
- Copyright 2011-2018 CesiumJS Contributors

#### @pdf-lib/standard-fonts 1.0.0

Licence: MIT. Text: T6.

- Copyright (c) 2018 Andrew Dillon

#### @pdf-lib/upng 1.0.1

Licence: MIT. Text: T7.

- Copyright (c) 2017 Photopea

#### @probe.gl/env 4.1.1

Licence: MIT. Text: T8.

- Copyright Vis.gl contributors.

#### @probe.gl/log 4.1.1

Licence: MIT. Text: T8.

- Copyright Vis.gl contributors.

#### @probe.gl/stats 4.1.2

Licence: MIT. Text: T8.

- Copyright Vis.gl contributors.

#### @types/geojson 7946.0.16

Licence: MIT. Text: T9.

- Copyright (c) Microsoft Corporation.

#### @types/node 25.9.8

Licence: MIT. Text: T9.

- Copyright (c) Microsoft Corporation.

#### apache-arrow 21.2.0

Licence: Apache-2.0. Text: T10.

- Copyright 2017-2025 The Apache Software Foundation

#### draco3d 1.5.7

Licence: Apache-2.0. Text: T10. The published package ships no licence file; the standard text of its declared licence applies.

- Copyright The Draco Authors, Google LLC (https://github.com/google/draco) (from the upstream repository; the package names no holder)

#### flatbuffers 25.9.23

Licence: Apache-2.0. Text: T10.

- Copyright Google Inc. and the FlatBuffers authors (https://github.com/google/flatbuffers) (from the upstream repository; the package names no holder)

#### json-with-bigint 3.5.12

Licence: MIT. Text: T11.

- Copyright (c) 2023 Ivan Korolenko

#### ktx-parse 0.7.1

Licence: MIT. Text: T12.

- Copyright (c) 2020 Don McCurdy

#### laz-perf 0.0.7

Licence: Apache-2.0. Text: T10. The published package ships no licence file; the standard text of its declared licence applies.

- Copyright Hobu, Inc. and the laz-perf contributors (https://github.com/hobuinc/laz-perf) (from the upstream repository; the package names no holder)

#### mgrs 1.0.0

Licence: MIT. Text: T13.

- Copyright (c) 2012, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral, Calvin Metcalf

#### pako 1.0.11

Licence: (MIT AND Zlib). Text: T14, T15.

- Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

#### pdf-lib 1.17.1

Licence: MIT. Text: T16.

- Copyright (c) 2019 Andrew Dillon

#### proj4 2.22.0

Licence: MIT. Text: T17.

- Copyright (c) 2014, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral and Calvin Metcalf

#### three 0.186.0

Licence: MIT. Text: T18.

- Copyright © 2010-2026 three.js authors

#### tslib 2.8.1

Licence: 0BSD. Text: T19.

- Copyright (c) Microsoft Corporation.

#### undici-types 7.24.6

Licence: MIT. Text: T20.

- Copyright (c) Matteo Collina and Undici contributors

#### wkt-parser 1.5.5

Licence: MIT. Text: T17.

- Copyright (c) 2014, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral and Calvin Metcalf

### NOTICE files

Apache-2.0 section 4(d) requires these to travel with the distribution.

#### NOTICE file of apache-arrow 21.2.0 (NOTICE.txt)

```
Apache Arrow JavaScript
Copyright 2017-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (http://www.apache.org/).
```

### Licence texts

#### T1: OFL-1.1

Applies to: @fontsource-variable/inter 5.3.0.

```
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

#### T2: OFL-1.1

Applies to: @fontsource/jetbrains-mono 5.3.0.

```
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

#### T3: OFL-1.1

Applies to: @fontsource/manrope 5.3.0.

```
Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

#### T4: MIT

Applies to: @loaders.gl/core 4.5.2, @loaders.gl/draco 4.5.2, @loaders.gl/gltf 4.5.2, @loaders.gl/images 4.5.2, @loaders.gl/loader-utils 4.5.2, @loaders.gl/obj 4.5.2, @loaders.gl/ply 4.5.2, @loaders.gl/schema 4.5.1, @loaders.gl/schema-utils 4.5.2, @loaders.gl/textures 4.5.2, @loaders.gl/worker-utils 4.5.2.

```
loaders.gl is licensed under the MIT license

Copyright (c) vis.gl contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

Copyright (c) 2015 Uber Technologies, Inc.

loaders.gl includes certain files from Cesium (https://github.com/AnalyticalGraphicsInc/cesium)
under the  Apache 2 License (found in the submodule: modules/3d-tiles):)

Copyright 2011-2018 CesiumJS Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and limitations under the License.
```

#### T5: MIT

Applies to: @math.gl/core 4.1.0, @math.gl/types 4.1.0.

```
MIT License

Copyright (c) 2017 Uber Technologies, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

math.gl builds on docs and code from "gl-matrix", which is MIT licensed as follows:

Copyright (c) 2015, Brandon Jones, Colin MacKenzie IV.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

--

math.gl builds on docs and code from THREE.js, which is MIT licensed as follows:

The MIT License

Copyright © 2010-2017 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

math.gl includes certain files from Cesium (https://github.com/AnalyticalGraphicsInc/cesium) under the Apache 2 License:

Copyright 2011-2018 CesiumJS Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and limitations under the License.

Cesium-derived code can be found in the submodule: modules/3d-tiles
```

#### T6: MIT

Applies to: @pdf-lib/standard-fonts 1.0.0.

```
MIT License

Copyright (c) 2018 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### T7: MIT

Applies to: @pdf-lib/upng 1.0.1.

```
MIT License

Copyright (c) 2017 Photopea

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### T8: MIT

Applies to: @probe.gl/env 4.1.1, @probe.gl/log 4.1.1, @probe.gl/stats 4.1.2.

```
Copyright Vis.gl contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### T9: MIT

Applies to: @types/geojson 7946.0.16, @types/node 25.9.8.

```
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

#### T10: Apache-2.0

Applies to: apache-arrow 21.2.0, draco3d 1.5.7, flatbuffers 25.9.23, laz-perf 0.0.7.

```
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

#### T11: MIT

Applies to: json-with-bigint 3.5.12.

```
MIT License

Copyright (c) 2023 Ivan Korolenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### T12: MIT

Applies to: ktx-parse 0.7.1.

```
The MIT License (MIT)

Copyright (c) 2020 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### T13: MIT

Applies to: mgrs 1.0.0.

```
Copyright (c) 2012, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral, Calvin Metcalf

 Permission is hereby granted, free of charge, to any person obtaining a
 copy of this software and associated documentation files (the "Software"),
 to deal in the Software without restriction, including without limitation
 the rights to use, copy, modify, merge, publish, distribute, sublicense,
 and/or sell copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included
 in all copies or substantial portions of the Software.

 _THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 DEALINGS IN THE SOFTWARE._
```

#### T14: (MIT AND Zlib)

Applies to: pako 1.0.11.

```
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### T15: Zlib

Applies to: pako 1.0.11.

```
This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

#### T16: MIT

Applies to: pdf-lib 1.17.1.

```
MIT License

Copyright (c) 2019 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### T17: MIT

Applies to: proj4 2.22.0, wkt-parser 1.5.5.

```
## Proj4js -- Javascript reprojection library.

Authors:
- Mike Adair madairATdmsolutions.ca
- Richard Greenwood richATgreenwoodmap.com
- Didier Richard didier.richardATign.fr
- Stephen Irons stephen.ironsATclear.net.nz
- Olivier Terral oterralATgmail.com
- Calvin Metcalf cmetcalfATappgeo.com

Copyright (c) 2014, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral and Calvin Metcalf

 Permission is hereby granted, free of charge, to any person obtaining a
 copy of this software and associated documentation files (the "Software"),
 to deal in the Software without restriction, including without limitation
 the rights to use, copy, modify, merge, publish, distribute, sublicense,
 and/or sell copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included
 in all copies or substantial portions of the Software.

 _THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 DEALINGS IN THE SOFTWARE._
```

#### T18: MIT

Applies to: three 0.186.0.

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### T19: 0BSD

Applies to: tslib 2.8.1.

```
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

#### T20: MIT

Applies to: undici-types 7.24.6.

```
MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

<!-- generated:licence-texts:end -->
