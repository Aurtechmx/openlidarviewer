# OpenLiDARViewer v0.6.7

v0.6.7 is a licensing and engineering release. The license changes to AGPL-3.0-only, and underneath it a memory-safety hardening wave reworks the read paths so a malformed or oversized input is refused before it can allocate past budget. The 3D Tiles path gained a correctness pass alongside it, and two ingest paths join them: heavy local files stream out of core rather than loading whole, and 3D Tiles implicit tiling opens where an earlier release read only an explicit hierarchy. The Measurements rail was reworked so its readouts are no longer cut. No new scientific evidence claim is made in this release; the twelve products at E4 stay exactly as validated in v0.6.6.

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

On the test machine, a 1.74 GB LAZ opened in about 1 minute 41 seconds through this path, against about 2 minutes 43 seconds on an earlier build. That is one field observation on a single machine and browser, recorded in `docs/benchmarks.md`; open time varies with thermal state and cache.

## 3D Tiles implicit tiling

Quadtree and octree implicit subtrees now open and stream. An earlier release opened a 3D Tiles set only where the tileset declared an explicit tile hierarchy; the implicit form is read now, so a set that encodes its hierarchy as subtrees loads rather than being refused.

## 3D Tiles geometry correctness

The 3D Tiles transform handling gained three fixes that change where geometry is drawn and refined, not just how much is loaded.

- Geometric error is now version-aware. 3D Tiles 1.0 does not apply the tile transform to a tile's geometric error, while 1.1 scales it by the transform's largest stretch. The viewer scaled unconditionally, so a scaled 1.0 tileset refined at the wrong level of detail; it now leaves 1.0 unscaled and scales 1.1.
- The transform's largest stretch is measured as the true largest singular value of its upper-left three-by-three, not the longest of its three columns. The column length is right for a rotation with axis-aligned scale but under-reports a shear or a composed non-uniform transform, so a bounding sphere could be sized too small and cull valid geometry. A unit shear now reads about 1.618 where the column measure read about 1.414.
- PNTS surface normals are transformed by the inverse-transpose of the tile transform and renormalised. Carrying a normal through the plain transform leaves it no longer perpendicular to its surface under any non-uniform or sheared transform; normal-based shading now points the right way.

## Memory-safety hardening

This wave was worked from an adversarial audit of the read paths, and it changes how the viewer behaves on a hostile or oversized file rather than what it computes on a good one.

- One shared decoded-byte budget caps the LAZ chunk table, the LAZ chunks and windows, the LAS record batches, the COPC nodes and the out-of-core tiles together. A malformed multi-gigabyte input is refused before it can allocate past that budget, instead of each reader holding its own uncapped allowance.
- The peak-memory estimate charges the compressed bytes twice on a laz-perf decode, once for the JavaScript buffer and once for the copy laz-perf stages into its WASM heap, and the local windowed path drops the extra slice it used to make, so the budget reflects what is actually resident during decompression.
- COPC, EPT binary and PNTS bound the peak that spans both decode phases, not only the first. A node whose compressed and raw records pass the decompression cap but whose decoded channel arrays would then push the working set over budget is refused before the first allocation.
- PNTS admission counts the raw tile body together with its decoded channels rather than the decoded arrays alone, and a phone uses a lower ceiling than a desktop, so a single large point tile that would exceed the mobile budget is refused rather than downloaded and then rejected.
- The remote transport caps a body with no trustworthy Content-Length at 64 MiB, and a mobile 3D Tiles tile download is capped to the mobile decode budget, so transport assembly cannot exceed the memory the decoder is allowed. A declared-length body streams into one exact buffer once enough real bytes have arrived, rather than growing through doubling buffers, and abandoned EPT and 3D Tiles response bodies are cancelled before a retry.
- EPT and COPC reconcile the point total across the hierarchy against the declared total, and refuse to call a partially loaded cloud complete; an EPT laszip tile whose LAS header count disagrees with its hierarchy entry is refused before laz-perf runs, and an EPT hierarchy that cannot open its root fails rather than opening as an empty scan.
- Full-cloud grading refuses a sample above its safe point and byte ceilings before allocating, and requires the decoded node count to match the plan.
- The out-of-core store in the Origin Private File System is leak-free. Every open takes a unique id, the store is promoted only inside the failure guard, each cancel or attach path either commits the store or deletes it, a short write is handled rather than left behind, and a startup janitor sweeps any store a previous session abandoned.
- First-node streaming admission reads the device it runs on rather than assuming a fixed ceiling, an over-ceiling non-streaming format fails closed instead of attempting a whole read, size caps were added to the batch converter and the metadata readers, and a truncated tile or source is refused rather than presented as a smaller complete scan.

## Interface

The Measurements rail was reported as cut on the right, and the profile chart's x-axis dropped a tick and clipped its last label. Both are fixed.

- The profile chart's x-axis labels fit the chart's real width rather than a fixed floor, so a wide chart carries every label it has room for at an even spacing and none loses a leading digit at the edge.
- The Measurements panel fills the workspace rail instead of carrying its own narrower fixed width, so the Data / Work / Analyse / Output tabs, the Clip box card and the panel share one width and one right edge. Long readouts, such as a volume's fill, cut and net line, wrap onto further lines rather than being cut, and no readout forces a horizontal scrollbar.
- The panel's resize grip widens the whole rail rather than the one panel, so the stack stays aligned at every width, and a trackpad scroll over the panel reaches the column that scrolls.

## Corrected behaviour

- The profile PDF max-grade carries the sign the on-screen panel and the callout already show, so the exported sheet no longer disagrees with the panel it was printed from.
- The Inspector elevation rows read the source vertical unit instead of assuming metres.
- Panel-rail observers that leaked are disposed.
- A degenerate profile no longer reports full coverage over zero returns.
- Closing the profile workbench restores the Analyse panel, so its contour controls no longer disappear with it.

## No new evidence claim

v0.6.7 adds no new scientific evidence claim, no new E4 promotion and no new validation study. The twelve registered products at E4 stay exactly as validated in v0.6.6, and the engineering and memory-safety work above is covered by the test suite rather than by a scientific claim.

Two evidence descriptions were corrected without changing what the evidence says. An exported terrain product that has reached cross-implementation validation but not field validation is now described as such, rather than as pre-cross-implementation and unchecked against an independent tool, so the terrain report and the map sheet agree on a product's standing. The aspect-raster tolerance is recorded as carried over from the slope tolerance in the same change that produced its result, not as preregistered ahead of it, which the slope, hillshade and contour tolerances were. See `VALIDATION_REPORT_v0.6.7.md` and `KNOWN_LIMITATIONS_v0.6.7.md`.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.7.md`. It carries the v0.6.6 limits forward. The two monoliths are unchanged this cycle, there is still no cross-CRS reprojection into a common viewer frame, and the residual streaming flicker at the point-budget boundary is unchanged in the default configuration. The decode-memory budget is device-aware for PNTS; the other formats share a single ceiling rather than a per-device one.

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
