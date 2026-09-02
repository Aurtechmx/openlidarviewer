# Third-Party Notices

OpenLiDARViewer ships with — and links against — a number of
third-party open-source packages and fonts. This document lists each
runtime dependency, its upstream project, and its license. The full
text of every license referenced here is reproduced or linked at the
end of the file.

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
| three | ^0.184.0 | 0.184.0 | MIT | https://github.com/mrdoob/three.js |
| @loaders.gl/core | ^4.4.5 | 4.4.5 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/gltf | ^4.4.2 | 4.4.3 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/obj | ^4.4.5 | 4.4.5 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/ply | ^4.4.5 | 4.4.5 | MIT | https://github.com/visgl/loaders.gl |
| laz-perf | ^0.0.7 | 0.0.7 | Apache-2.0 | https://github.com/hobuinc/laz-perf |
| pdf-lib | ^1.17.1 | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| proj4 | ^2.21.0 | 2.21.0 | MIT | https://github.com/proj4js/proj4js |
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

MIT (46 packages):

- @loaders.gl/core 4.4.5
- @loaders.gl/draco 4.4.3
- @loaders.gl/gltf 4.4.3
- @loaders.gl/images 4.4.3
- @loaders.gl/loader-utils 4.4.3
- @loaders.gl/obj 4.4.5
- @loaders.gl/ply 4.4.5
- @loaders.gl/schema 4.4.3
- @loaders.gl/schema-utils 4.4.3
- @loaders.gl/textures 4.4.3
- @loaders.gl/worker-utils 4.4.3
- @math.gl/core 4.1.0
- @math.gl/types 4.1.0
- @pdf-lib/standard-fonts 1.0.0
- @pdf-lib/upng 1.0.1
- @probe.gl/env 4.1.1
- @probe.gl/log 4.1.1
- @probe.gl/stats 4.1.1
- @types/command-line-args 5.2.3
- @types/command-line-usage 5.0.4
- @types/geojson 7946.0.16
- @types/node 24.13.2
- ansi-styles 4.3.0
- array-back 6.2.3
- chalk 4.1.2
- chalk-template 0.4.0
- color-convert 2.0.1
- color-name 1.1.4
- command-line-args 6.0.2
- command-line-usage 7.0.4
- find-replace 5.0.2
- has-flag 4.0.0
- json-bignum 0.0.3
- ktx-parse 0.7.1
- lodash.camelcase 4.3.0
- mgrs 1.0.0
- pdf-lib 1.17.1
- proj4 2.21.0
- supports-color 7.2.0
- table-layout 4.1.1
- texture-compressor 1.0.2
- three 0.184.0
- typical 7.3.0
- undici-types 7.18.2
- wkt-parser 1.5.5
- wordwrapjs 5.1.1

Apache-2.0 (5 packages):

- @swc/helpers 0.5.23
- apache-arrow 21.1.0
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
| vite | ^8.2.1 | 8.2.1 | MIT | https://github.com/vitejs/vite |
| vitest | ^4.1.7 | 4.1.10 | MIT | https://github.com/vitest-dev/vitest |
| vitepress | 1.6.4 | 1.6.4 | MIT | https://github.com/vuejs/vitepress |
| vite-plugin-javascript-obfuscator | ^3.1.0 | 3.1.0 | MIT | https://github.com/elmesutupu/vite-plugin-javascript-obfuscator |
| @playwright/test | ^1.62.1 | 1.62.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| @types/three | ^0.184.1 | 0.184.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| rollup-plugin-visualizer | ^7.1.1 | 7.1.1 | MIT | https://github.com/btd/rollup-plugin-visualizer |
| @vitest/coverage-v8 | ^4.1.11 | 4.1.11 | MIT | https://github.com/vitest-dev/vitest |
| @stryker-mutator/core | ^10.0.0 | 10.0.0 | Apache-2.0 | https://github.com/stryker-mutator/stryker-js |
| @stryker-mutator/vitest-runner | ^10.0.0 | 10.0.0 | Apache-2.0 | https://github.com/stryker-mutator/stryker-js |
| @types/proj4 | ^2.19.0 | 2.19.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @loaders.gl/las | ^4.4.5 | 4.4.5 | MIT | https://github.com/visgl/loaders.gl |

## License texts

### MIT License (applies to every package marked MIT above: the 46 bundled MIT packages in "Complete bundled set", the MIT development-only dependencies, and pako's MIT half)

```
MIT License

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

Each MIT-licensed package retains its own copyright notice in its
upstream repository (see the "Upstream" column above).

### Apache License 2.0 (applies to bundled: laz-perf, apache-arrow, draco3d, flatbuffers, @swc/helpers; and development-only: typescript, @playwright/test, @stryker-mutator/*)

The Apache 2.0 license text is reproduced at:
https://www.apache.org/licenses/LICENSE-2.0

Copyright holders for the bundled Apache-2.0 packages:
- laz-perf: Howard Butler / Hobu, Inc. and contributors
- apache-arrow: The Apache Software Foundation
- draco3d: Google LLC and the Draco authors
- flatbuffers: Google Inc. and the FlatBuffers authors
- @swc/helpers: the SWC project authors

apache-arrow ships a NOTICE file. Apache-2.0 section 4(d) requires its contents
travel with the distribution:

```
Apache Arrow JavaScript
Copyright 2017-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (http://www.apache.org/).
```

Copyright holders for the Apache-2.0 development-only packages:
- typescript: Microsoft Corporation
- @playwright/test: Microsoft Corporation
- @stryker-mutator/*: the Stryker Mutator project authors

### Zlib License (applies to: pako, in addition to its MIT terms above)

pako is a JavaScript port of zlib and is distributed under `(MIT AND Zlib)`.
The MIT text above covers pako's own code; the Zlib terms cover the
zlib-derived portions. Copyright (C) 2014-2017 Vitaly Puzrin and Andrei
Tuputcyn (pako). The zlib algorithms it ports are (C) 1995-2017 Jean-loup
Gailly and Mark Adler. The Zlib license text is reproduced at:
https://opensource.org/license/zlib/

### BSD Zero-Clause License (0BSD) (applies to: tslib)

Copyright (c) Microsoft Corporation. The 0BSD license permits use, copying,
modification, and distribution for any purpose without conditions, and requires
no attribution notice. Full text at: https://opensource.org/license/0bsd/

### SIL Open Font License 1.1 (applies to: Inter, Manrope, JetBrains Mono)

The Inter, Manrope, and JetBrains Mono font families are each distributed under
the SIL Open Font License, Version 1.1 (OFL-1.1). The full license text is
reproduced at: https://openfontlicense.org/open-font-license-official-text/

Copyright (c) 2016-2024 The Inter Project Authors (https://github.com/rsms/inter)
Copyright (c) 2018 Mikhail Sharanda (Manrope, https://github.com/sharanda/manrope)
Copyright (c) 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono)

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
3. If the license is one not already listed, append its full text or a stable
   URL to the "License texts" section, and confirm it is compatible with
   AGPL-3.0-only distribution, and flag it here if it is not.
4. For a removed package, drop it from the list (and the table, if direct).
   Leave a license-text block intact unless every package under it is gone.

`node scripts/lint-sbom.mjs` fails if any `sbom.json` component is absent from
this file, so a regenerated SBOM that drifts from this notice is caught in CI.

## Test fixtures (not shipped in the deployed app)

These small files live under `tests/` and are used only by the automated
test suite; they are not part of the published web app.

- `tests/fixtures/synthetic.e57` — project-owned SYNTHETIC E57, generated by
  `scripts/make-e57-fixture.mjs` (deterministic, no third-party data). It
  exercises the reader's exact-decode paths — a single named scan, a Float +
  1-bit Integer prototype, single-precision cartesian decode, and a bit-packed
  invalid-state column. It carries no third-party data, so its assertions run in
  CI independently of any external corpus.
- `tests/bunnyFloat.e57` — the BunnyFloat conformance file from the libE57
  example/test data (http://www.libe57.org/data.html), a single-precision Float
  cartesian profile of 30,571 points. The corpus lists it under "Cartesian
  Points" with no per-file copyright holder; the site notice is © 2010 E57.04
  3D Imaging System File Format project. Released under the libE57 Test Data
  License: free use, reproduction, display, distribution, publication, and
  transmission, with the copyright notice required in copies that are not solely
  in binary form, and the data provided "as is". Full text at
  http://www.libe57.org/data.html (section 17). Used to check the Float decode
  path against the extent the writer declared; not shipped in the deployed app.
- `tests/pumpARowColumnIndexNoInvalidPoints.e57` — a pump-room laser scan
  (gridded, XYZ + intensity + RGB) from the libE57 example/test data
  (http://www.libe57.org/data.html). © 2008 Carnahan-Proctor and Cross, Inc.
  Released under the libE57 Test Data License: free use, reproduction, display,
  distribution, publication, and transmission, with the copyright notice
  required in source (non-binary) copies and the data provided "as is". Full
  text at http://www.libe57.org/data.html (section 17). Used only to exercise
  the E57 reader and the v0.5.7 terrestrial-scan display profile; not shipped in
  the deployed app.
- `tests/fixtures/las-pdal/utm15.las` and `synthetic_test.las` — two
  single-point LAS 1.2 files from the PDAL test corpus
  (https://github.com/PDAL/PDAL, `test/data/las/`), each verified byte-identical
  to upstream. Copyright (c) 2025, Hobu, Inc. (howard@hobu.co), released under
  the BSD 3-Clause licence that covers the PDAL distribution; its text is the
  "Overall PDAL license (BSD)" section of
  https://github.com/PDAL/PDAL/blob/master/LICENSE.txt. `utm15.las` carries its
  CRS in GeoTIFF keys rather than WKT and was written by libLAS 1.2 in 2008;
  `synthetic_test.las` carries no CRS. Used to exercise the LAS CRS paths and
  the zero-extent bounding box; not shipped in the deployed app.
- `tests/fixtures/e57-libe57format/` — nine E57 files from the libE57Format
  test corpus (https://github.com/asmaloney/libE57Format-test-data, `self/`),
  generated by libE57Format itself. Dedicated to the public domain under CC0 1.0
  Universal (https://creativecommons.org/publicdomain/zero/1.0/), which requires
  no attribution. Seven are deliberately malformed or degenerate and exercise
  the reader's refusal paths; `ColouredCubeFloat.e57` and
  `ColouredCubeDouble.e57` hold the same cube at two precisions. Not shipped in
  the deployed app.
- iPhone/iPad LiDAR handheld-scan example (added in v0.5.7) — a scan captured
  and provided by the project maintainer; licensed under the project's terms.
  Used to build and test the handheld-scan auto-detection.
- Generated synthetic fixtures (`tests/fixtures/**`, `tests/fixtures/copc/
  synthCopc.ts`, `public/samples/tiny.*`) — created by the project, no
  third-party data; the preferred source for deterministic profile/detection
  tests so coverage does not depend on any external file.
- `tests/fixtures/tiny.las`, `tiny.laz`, `tiny.ply`, and `public/samples/tiny.*`
  — minimal point clouds generated by the project as test/sample fixtures.
  They contain no third-party survey data.

The streamed sample datasets (USGS 3DEP, swisstopo, GURS) are not bundled;
they are fetched from public open-data buckets on user request, with attribution
recorded in `public/credits.html`.

## EPSG coordinate-system parameters

OpenLiDARViewer derives OGC WKT for a set of EPSG codes from their published
parameters (`src/io/epsgWkt.ts`, `src/convert/epsg.ts`). The EPSG Geodetic
Parameter Dataset is © International Association of Oil & Gas Producers (IOGP);
see the EPSG Dataset Terms of Use at <https://epsg.org/terms-of-use.html>. IOGP
does not endorse this software, and recipients of the derived parameters are
subject to those terms.
