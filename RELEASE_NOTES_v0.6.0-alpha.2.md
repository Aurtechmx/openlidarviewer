v0.6.0-alpha.2 is a stabilization cut, and it is honest about being one: open the viewer next to alpha.1 and you will not see a difference. The work went into making the test gates mean what they claim, starting the decomposition of the two files that hold most of the application, and writing the architecture down so the rest of that work has a target instead of an instruction to "make it smaller".

This is a pre-release for evaluation — interfaces and internals may still change before v0.6.0, so pin the exact commit if you depend on current behaviour.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## The end-to-end suite actually gates now

This is the finding that justified the release. 161 of the 166 end-to-end specs ran under `continue-on-error` — only the smoke and mobile specs, about twelve tests, could ever block a build. A regression in any of the other 161 shipped green. That is the exact shape of gap that let a streaming blank-render bug reach a release.

* **Two Playwright projects** — `deterministic` blocks, `gpu` is advisory. 165 specs now block the build; only the real-WebGPU equivalence probe stays advisory, because it legitimately falls back when a headless runner exposes no adapter;
* **Untagged specs block by default** — a new spec gates until someone shows it is GPU-variable, rather than the other way round.

## A coverage ratchet and a mutation gate

* **Coverage** (`npm run coverage`) is scoped to the pure modules — the numeric, geometric and model code a unit test can genuinely pin. The render and UI layers and the two monoliths are excluded on purpose: a repo-wide percentage there is a number nobody acts on. Baseline lines 90.57, statements 89.19, functions 87.75, branches 82.73, with thresholds set just underneath as a ratchet;
* **Mutation** (`npm run mutation`, advisory) covers the formulas where a wrong number is a silent scientific error rather than a visible crash. It found a real one immediately: the degenerate-input guard in the Horn slope/aspect routine had 17 surviving mutants, so a zero or NaN cell size could have produced an infinite slope that flows into confidence grades, hold-out RMSE bands and terrain ruggedness. Coverage had rated that file about 90 %, because the lines ran. It is pinned now.

> Coverage says a line executed. Mutation says an assertion actually holds the value. The gap between those two is where this release found its bug.

## The decomposition has started

No module-level mutable application state remains in `main.ts`. Saved views, active-scan selection and scan-route pinning moved onto the shared application context behind services, joining the layer service that landed in alpha.1. Eleven copies of the same active-cloud lookup collapsed into one call, and a routing predicate that was spelled out in two places became a single getter.

> Stated plainly: this barely moved the line count, 7,587 to 7,574. It is a coupling change. Its value is that the orchestration blocks can now close over services instead of file-scope variables, which is what makes them movable at all — and moving them is where the size goals are actually met.

## An architecture map that cannot rot quietly

`docs/architecture/architecture-map.md` records the enforced dependency direction, each layer with its real size, which service owns which piece of shared state, and the ten largest blocks inside the two monoliths with a destination for each. A drift check holds it to account: every module path the page names must resolve, or the test fails and the page has to move in the same change. It caught itself on the first run.

## Fixes

* The streaming scheduler tests only ever used a cube at the origin, where subtracting the render origin is a no-op — so the alpha.1 EPT blank-render bug could not have been caught there. A case at UTM-scale coordinates now fails if that localisation path regresses.

## Known limitations

* The two monoliths are still monoliths. `main.ts` is 7,574 lines and `Viewer.ts` is 7,297; the targets are 2,500 and 2,000. This release built the scaffolding for that work and did not do the bulk of it.
* The authoritative project frame remains a tested foundation with a written wiring plan, not an active system, so cross-layer comparison, measurement and clipping stay experimental.
* Some budget-boundary "regions pulsing" may remain while a COPC streams; the anti-thrash option is unit-tested but off by default and needs visual confirmation in a browser.
* The viewer does not reproject between coordinate systems — equal-CRS scans display together, mixed-CRS scans display in their own frames.
* Scientific evidence tops out at internal self-consistency (E3): synthetic known-truth checks, not cross-implementation or field-validated. This alpha does not claim survey-grade accuracy, standards compliance, or independent validation.

## Compatibility and scope

Runs in a modern Chromium-based browser (Chrome / Edge) with WebGPU; Firefox and Safari fall back to WebGL 2. Imports LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX, PTS, and streams COPC and EPT. Everything from v0.6.0-alpha.1 remains available and behaves the same way; the changes here are internal.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff`:

* Version: 0.6.0-alpha.2
* Release date: 2026-07-19
* License: MIT

When the tagged release is archived on Zenodo, cite the version DOI assigned to that snapshot.

Live demo: [https://lidar.aurtech.mx/](https://lidar.aurtech.mx/)  
GitHub: [https://github.com/Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)

Open Source • Open Data • Open Exploration
