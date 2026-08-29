# OpenLiDARViewer v0.6.7

v0.6.7 changes the license to AGPL-3.0-only and hardens the read paths so a malformed or oversized file is refused before it can allocate past budget. Two ingest paths are wired: heavy local files stream out of core rather than loading whole, and 3D Tiles implicit tiling opens where an earlier release read only an explicit hierarchy. Five claims reach cross-implementation evidence this cycle, and the Measurements rail was reworked so its readouts are no longer cut.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Licensing change

v0.6.7 is the first release published under AGPL-3.0-only. Releases through v0.6.6 were published under MIT and remain available under those terms; the change is not retroactive. It covers this project's own source and does not alter the license of any bundled dependency or any test or validation dataset. `LICENSE`, `LICENSING.md`, `COMMERCIAL-LICENSING.md` and `docs/CLA.md` carry the terms, the separate commercial option and the contributor agreement.

## New cross-implementation evidence

Five claims reach `E4_CROSS_IMPLEMENTATION_VALIDATED`, bringing the register to seventeen. Each agrees with an independent implementation on synthetic or analytic fixtures. None is accuracy against surveyed ground truth.

- `CRS-UTM-PROJECTION`: WGS-84 latitude and longitude to UTM, checked against GeographicLib 2.7 and PROJ 9.8.1 over 36 geodetic fixtures. Zone and hemisphere match on every fixture, easting and northing to under 1.5 mm. Same datum stands on both sides, so no datum transformation is exercised.
- `CHANGE-RASTER` and `CHANGE-VOLUME`: per-cell change and integrated cut and fill volume, checked against GRASS 8.5.0 over eight synthetic epoch pairs, and change volume also against the closed-form integral of each pair. Agreement is on synthetic pairs, not surveyed field change.
- `HOLDOUT-RMSE` and `NVA-VVA`: the internal holdout accuracy statistics, recomputed in base R. The check confirms the statistic is computed correctly, not that it is field accuracy: the held-out points come from the same source as the interpolated ones, and neither is ASPRS checkpoint accuracy.

Full figures, tolerances and scope are in `VALIDATION_REPORT_v0.6.7.md`. The twelve products validated in v0.6.6 are unchanged.

## Reading heavy local files out of core

A very large uncompressed LAS and a chunked LAZ are no longer read whole into memory. Each is indexed into temporary browser storage and streamed from that index, or refused with guidance when the device cannot hold even the index. A preview sample renders at once, marked incomplete until the full index swaps in behind it, so a partial view is never mistaken for the whole cloud.

## 3D Tiles

Quadtree and octree implicit subtrees now open and stream, where an earlier release read only an explicit tile hierarchy. Three transform fixes came with them: 3D Tiles 1.0 no longer scales a tile's geometric error the way 1.1 does, so a scaled 1.0 tileset refines at the right level of detail; a sheared or non-uniform tile transform is measured by its true largest stretch, so a bounding sphere is not sized too small and does not cull valid geometry; and PNTS surface normals are transformed correctly, so normal-based shading points the right way.

## Memory-safety hardening

Worked from an adversarial audit of the read paths, this wave changes how the viewer behaves on a hostile or oversized file, not what it computes on a good one. One shared budget caps the LAZ, LAS, COPC and out-of-core readers together, so a malformed multi-gigabyte input is refused before it can allocate past that budget. The COPC, EPT and PNTS decoders account for the full working set of a decode, not only its final arrays, and use a lower ceiling on a phone. Remote transport caps an unknown-length body and a mobile tile to what the decoder is allowed, and cancels abandoned response bodies. EPT and COPC refuse to call a partially loaded cloud complete, and refuse a tile whose declared point count disagrees with its hierarchy. The out-of-core store is leak-free, with a startup janitor that sweeps any store a previous session abandoned.

## Interface

The Measurements panel now fills the workspace rail, so the Data, Work, Analyse and Output tabs, the Clip box card and the panel share one width and one right edge. Long readouts wrap rather than being cut, no readout forces a horizontal scrollbar, the resize grip widens the whole rail so the stack stays aligned, and a trackpad scroll over the panel reaches the column that scrolls. The profile chart's x-axis labels fit the chart's real width, so a wide chart carries an even set of labels and none loses a digit at the edge.

## Fixed

- The profile PDF max-grade carries the sign the on-screen panel already shows.
- The Inspector elevation rows read the source vertical unit instead of assuming metres.
- A degenerate profile no longer reports full coverage over zero returns.
- Closing the profile workbench restores the Analyse panel, so its contour controls no longer disappear with it.
- Two evidence descriptions were corrected without changing what the evidence says: a product that has reached cross-implementation validation but not field validation is described as such rather than as unchecked, and the aspect tolerance is recorded as carried over from the slope tolerance rather than preregistered.
- Panel-rail observers that leaked are disposed.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.7.md`. It carries the v0.6.6 limits forward. The two monoliths are unchanged this cycle, there is still no cross-CRS reprojection into a common viewer frame, and the residual streaming flicker at the point-budget boundary is unchanged in the default configuration.

## Compatibility

Unchanged from v0.6.6. Modern Chromium browsers prefer WebGPU where the platform and adapter provide it and fall back to WebGL 2 otherwise; Firefox and Safari take the WebGL 2 path. A session saved before this release loads unchanged.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.7.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.7
- License: AGPL-3.0-only

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.6...v0.6.7](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.6...v0.6.7)
