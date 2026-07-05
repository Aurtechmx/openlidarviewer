# Third-Party Notices

OpenLiDARViewer ships with — and links against — a number of
third-party open-source packages and fonts. This document lists each
runtime dependency, its upstream project, and its license. The full
text of every license referenced here is reproduced or linked at the
end of the file.

## Runtime dependencies (bundled into the shipped build)

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| three | ^0.184.0 | MIT | https://github.com/mrdoob/three.js |
| @loaders.gl/core | ^4.4.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/gltf | ^4.4.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/las | ^4.4.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/obj | ^4.4.2 | MIT | https://github.com/visgl/loaders.gl |
| @loaders.gl/ply | ^4.4.2 | MIT | https://github.com/visgl/loaders.gl |
| laz-perf | ^0.0.7 | Apache-2.0 | https://github.com/hobuinc/laz-perf |
| pdf-lib | ^1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| proj4 | ^2.20.8 | MIT | https://github.com/proj4js/proj4js |
| @fontsource-variable/inter | ^5.2.8 | OFL-1.1 | https://github.com/rsms/inter |
| @fontsource/manrope | ^5.2.8 | OFL-1.1 | https://github.com/sharanda/manrope |
| @fontsource/jetbrains-mono | ^5.2.8 | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono |

## Development-only dependencies (not bundled into the shipped build)

The following are used during typecheck, test, lint, or build only.
They are NOT distributed in `dist/` and do not need re-distribution
of their license text alongside the shipped artifact. They are listed
here for transparency.

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| typescript | ~6.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| vite | ^8.0.12 | MIT | https://github.com/vitejs/vite |
| vitest | ^4.1.7 | MIT | https://github.com/vitest-dev/vitest |
| @playwright/test | ^1.60.0 | Apache-2.0 | https://github.com/microsoft/playwright |
| @types/three | ^0.184.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| rollup-plugin-visualizer | ^7.0.1 | MIT | https://github.com/btd/rollup-plugin-visualizer |

## License texts

### MIT License (applies to: three, @loaders.gl/*, pdf-lib, proj4, vite, vitest, rollup-plugin-visualizer, @types/three)

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

### Apache License 2.0 (applies to: laz-perf, typescript, @playwright/test)

The Apache 2.0 license text is reproduced at:
https://www.apache.org/licenses/LICENSE-2.0

Copyright holders for the Apache-2.0-licensed packages:
- laz-perf: Howard Butler / Hobu, Inc. and contributors
- typescript: Microsoft Corporation
- @playwright/test: Microsoft Corporation

### SIL Open Font License 1.1 (applies to: Inter, Manrope, JetBrains Mono)

The Inter, Manrope, and JetBrains Mono font families are each distributed under
the SIL Open Font License, Version 1.1 (OFL-1.1). The full license text is
reproduced at: https://openfontlicense.org/open-font-license-official-text/

Copyright (c) 2016-2024 The Inter Project Authors (https://github.com/rsms/inter)
Copyright (c) 2018 Mikhail Sharanda (Manrope, https://github.com/sharanda/manrope)
Copyright (c) 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono)

## How to refresh this notice

When a new runtime dependency is added to `package.json`:

1. Identify the license from the package's upstream repository
   (the `LICENSE` file, or `license` field in its `package.json`).
2. Add a row to the appropriate table above.
3. If the license is one not already listed, append its full text or
   a stable URL to the "License texts" section.

When a runtime dependency is removed: drop its row from the table.
Leave the license-text section intact unless every package using
that license has been removed.

## Test fixtures (not shipped in the deployed app)

These small files live under `tests/` and are used only by the automated
test suite; they are not part of the published web app.

- `tests/bunnyFloat.e57` — the "Stanford Bunny", from the Stanford Computer
  Graphics Laboratory 3D Scanning Repository
  (https://graphics.stanford.edu/data/3Dscanrep/). Provided for research use;
  credited here as a courtesy. Used only to exercise the E57 reader.
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

The streamed sample datasets (USGS 3DEP, swisstopo, GURS, AHN) are not bundled;
they are fetched from public open-data buckets on user request, with attribution
recorded in `public/credits.html`.

## Bundled sample data (shipped in the deploy)

These files live under `public/samples/` and ship with the deployed app so the
in-app "try a sample" affordance can open them.

- `public/samples/pumpARowColumnIndexNoInvalidPoints.e57` — a pump-room laser
  scan (gridded, XYZ + intensity + RGB) from the libE57 example/test data
  (http://www.libe57.org/data.html). © 2008 Carnahan-Proctor and Cross, Inc.
  Released under the libE57 Test Data License: free use, reproduction, display,
  distribution, publication, and transmission, with the copyright notice
  required in source (non-binary) copies and the data provided "as is". Full
  text at http://www.libe57.org/data.html (section 17). Ships as the E57
  terrestrial-scan sample (v0.5.7). The `.e57` itself is a binary file, so the
  licence's notice requirement is met here and in `public/credits.html` rather
  than inside the file.
- `public/samples/tiny.*` — minimal point clouds generated by the project; no
  third-party data.
