# OpenLiDARViewer v0.6.7

v0.6.7 is a licensing and engineering release. The license changes to AGPL-3.0-only, and underneath it a memory-safety hardening wave reworks the read paths so a malformed or oversized input is refused before it can allocate past budget. Two ingest paths join them: heavy local files stream out of core rather than loading whole, and 3D Tiles implicit tiling opens where an earlier release read only an explicit hierarchy. No new scientific evidence claim is made in this release; the twelve products at E4 stay exactly as validated in v0.6.6.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Licensing change

v0.6.7 is the first release published under AGPL-3.0-only. Releases through v0.6.6 were published under MIT and remain available under those terms; the change is not retroactive and nothing already distributed changes license.

The change covers this project's own source. It does not alter the license of any bundled third-party dependency, which each keeps the terms it already carried, and it does not alter the license of any test or validation dataset. The dataset citations and their licenses are recorded where they were before.

The current terms and the surrounding documents are:

- `LICENSE` carries the GNU AGPL v3 text.
- `LICENSING.md` states what the license means for a user and a redistributor.
- `COMMERCIAL-LICENSING.md` describes the separate commercial option for use that AGPL-3.0-only does not fit.
- `docs/CLA.md` is the contributor licensing agreement.

## Reading heavy local files out of core

A very large uncompressed LAS and a chunked LAZ are no longer read whole into memory. Each is indexed into temporary browser storage in the Origin Private File System and streamed from that index, or refused with guidance when the device cannot hold even the index. A stratified preview sample renders at once so the scan is visible immediately, and it is marked incomplete until the full index swaps in behind it, so a partial view is never mistaken for the whole cloud.

## 3D Tiles implicit tiling

Quadtree and octree implicit subtrees now open and stream. An earlier release opened a 3D Tiles set only where the tileset declared an explicit tile hierarchy; the implicit form is read now, so a set that encodes its hierarchy as subtrees loads rather than being refused.

## Memory-safety hardening

This wave was worked from an adversarial audit of the read paths, and it changes how the viewer behaves on a hostile or oversized file rather than what it computes on a good one.

- One shared decoded-byte budget caps the LAZ chunk table, the LAZ chunks and windows, the LAS record batches, the COPC nodes and the out-of-core tiles together. A malformed multi-gigabyte input is refused before it can allocate past that budget, instead of each reader holding its own uncapped allowance.
- The out-of-core store in the Origin Private File System is leak-free. Every open takes a unique id, the store is promoted only inside the failure guard, each cancel or attach path either commits the store or deletes it, a short write is handled rather than left behind, and a startup janitor sweeps any store a previous session abandoned.
- First-node streaming admission reads the device it runs on rather than assuming a fixed ceiling.
- An over-ceiling non-streaming format fails closed instead of attempting a whole read.
- Size caps were added to the batch converter and to the metadata readers.
- A truncated tile or source is refused rather than presented as a smaller complete scan.

## Corrected behaviour

- The profile PDF max-grade carries the sign the on-screen panel and the callout already show, so the exported sheet no longer disagrees with the panel it was printed from.
- The Inspector elevation rows read the source vertical unit instead of assuming metres.
- Panel-rail observers that leaked are disposed.
- A degenerate profile no longer reports full coverage over zero returns.
- Closing the profile workbench restores the Analyse panel, so its contour controls no longer disappear with it.

## No new evidence claim

v0.6.7 adds no new scientific evidence claim, no new E4 promotion and no new validation study. The twelve registered products at E4 stay exactly as validated in v0.6.6, and the engineering and memory-safety work above is covered by the test suite rather than by a scientific claim. See `VALIDATION_REPORT_v0.6.7.md` and `KNOWN_LIMITATIONS_v0.6.7.md`.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.7.md`. It carries the v0.6.6 limits forward. The two monoliths are unchanged this cycle, there is still no cross-CRS reprojection into a common viewer frame, and the residual streaming flicker at the point-budget boundary is unchanged in the default configuration.

## Compatibility

Unchanged from v0.6.6. Modern Chromium browsers prefer WebGPU where the platform and adapter provide it and fall back to WebGL 2 otherwise; Firefox and Safari take the WebGL 2 path. Existing sessions remain compatible, and a session saved before this release loads unchanged.

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
