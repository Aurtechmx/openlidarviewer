v0.5.8 is a foundation release. v0.5.7 made OpenLiDARViewer more honest about what kind of scan is being shown: survey, object, interior, handheld, terrestrial, or local-frame data. v0.5.8 continues that work one layer down, making generated outputs state which build, which method, and which unit assumptions produced them.

This release does not ship Contour Studio. It hardens provenance, scientific method tracking, build identity, and science-layer boundaries first, so that kind of feature can be built safely later.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Build identity in every artifact

A release version tells you the public version number. It does not always tell you the exact build that produced a PDF, terrain export, report, or validation artifact.

v0.5.8 stamps a resolved build identity into export provenance and report metadata:

- application version;
- git commit when available;
- dirty-tree flag;
- build time;
- Node.js version;
- release channel;
- reproducible-build support through `SOURCE_DATE_EPOCH`.

When git metadata is unavailable, the build reports `unknown` instead of inventing a commit. Unknown provenance stays visibly unknown.

## Picked-point units are no longer overclaimed

The Inspector previously showed picked projected coordinates with a metre suffix even when the source coordinate system used feet, or when the source units were unknown.

v0.5.8 changes the display rule:

- metre-based coordinates show metres;
- foot-based projected coordinates show feet;
- unknown or local units show no suffix.

A coordinate label should not claim a unit the file never provided.

## Contour intervals gated in their own units

The interval honesty-gate compared a metre-valued hold-out RMSE against source-unit contour intervals, so a foot-CRS surface could offer intervals finer than its true vertical error. The RMSE is now expressed in the interval's own units before gating, and the recommendation stays invariant to the declared vertical scale.

## Scientific methods now have stable identities

v0.5.8 introduces a method registry for the scientific operations OpenLiDARViewer runs. Each operation carries a stable `id@version`, so reports and future validation artifacts can name the exact algorithmic path behind a number. A later release can improve one method without changing the meaning of every other method in the application.

## Runtime evidence checked against the claim register

v0.5.7 introduced the evidence model and claim register. v0.5.8 makes that registry harder to drift from the runtime code. The runtime evidence registry is now generated from the claim register, and a claim-register lint check fails the build if the documented claims and runtime entries fall out of sync, or if prohibited wording returns to a release path.

## Science and core modules kept away from the UI

v0.5.8 adds a layer-boundary lint check. Science and core modules under `terrain`, `validation`, `analysis`, and `science` must not import the UI layer or three.js. That keeps analytical code easier to test, easier to move into workers, and free of presentation concerns.

## A canonical scientific-analysis record has started

This release adds the first version of a shared scientific-analysis record, now embedded in the one provenance object every terrain export stamps. The purpose is to move toward a single authoritative result model that feeds UI previews, PDF reports, terrain exports, validation artifacts, and provenance JSON. The record is not yet the only source for every output. Later releases will make more export paths derive strictly from it.

## Fixes

- typed-unit constructors reject NaN or Infinity at the source, so a bad number fails loudly instead of propagating into a measurement;
- the source archive can no longer ship missing a tracked module: a new `lint:no-ignored-src` check fails the build if any `src/` file is git-ignored;
- the plain-build chunk-isolation contract now runs on every release through `test:build`, not only the obfuscated live-build budget.

## Known limitations

- The evidence model is a documentation and internal-governance layer. It does not yet enforce evidence badges or automatic validation gates throughout every interface and export.
- The canonical scientific-analysis record is embedded in export provenance but is not yet the sole source for every deliverable.
- Existing limitations of the underlying measurement, terrain, filtering, and export tools still apply.

## Compatibility and scope

Everything from v0.5.7 remains available. The one visible change is more careful unit labelling in picked-point coordinates. Survey, object, E57, terrain, and local-frame display behavior from v0.5.7 continues to work. This release is mostly architectural. It makes future features safer to build rather than forcing anyone to relearn the viewer.

## What this release does not claim

v0.5.8 is not a survey-certification release. It does not claim externally validated terrain accuracy, survey-grade contour output, full standards compliance, independent field validation, a completed Contour Studio, or complete runtime enforcement of every future evidence gate.

> v0.5.8 strengthens build provenance, unit honesty, method traceability, evidence-registry discipline, and science-layer architecture so future research deliverables can be more reproducible and less prone to overclaiming.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff`:

- Version: 0.5.8
- Release date: 2026-07-08
- License: MIT

When the tagged release is archived on Zenodo, cite the version DOI assigned to that snapshot.

Live demo: <https://lidar.aurtech.mx/>  
GitHub: <https://github.com/Aurtechmx/openlidarviewer>

Open Source • Open Data • Open Exploration
