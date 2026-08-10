# OpenLiDARViewer v0.6.5

v0.6.5 adds a Process Studio panel that tells you what a loaded scan can safely produce, lands the first feature-extraction and registration cores, hardens the remote-streaming path, and widens the terrain evidence from synthetic fixtures to real airborne LiDAR. Contours reach independent cross-implementation evidence, and slope's existing cross-check now runs on real steep terrain as well as the analytic surface. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Process Studio

- a Process Studio panel sits in the left rail and answers one question for the loaded scan: what can this dataset safely produce? Each product — DTM, DSM, contours, building footprints, cross-epoch change, volume — reads `ready`, `review`, or `blocked` with a plain reason, alongside the adaptive processing stages that apply and a set of independent quality checks. It is display-only: it reads the same capability model the exporters read, so the panel and a real export can never disagree about what is eligible;
- it fails closed. An unconfirmed linear unit blocks the georeferenced products, a missing or differing vertical reference blocks cross-epoch height math, and resident-only streaming coverage cannot back a full-dataset product. An unknown scan fact reads as the conservative state, never as capability. The panel reveals on scan load and hides on close.

## Feature extraction and registration

- a feature-extraction core turns classified building points into footprint candidates: occupancy grid, connected components, boundary trace, Douglas–Peucker simplification, and a dominance-gated orthogonalisation, exported as RFC 7946 GeoJSON whose properties mark the polygons as derived candidates, not surveyed outlines. A conductor primitive fits a principal-direction centerline and a quadratic sag to linear point sets, behind a linearity gate;
- a registration core lands the rigid-alignment maths (a Kabsch/Horn solve, a trimmed general ICP, tie-point alignment, and a non-destructive Float64 transform store). The per-layer frame work these depended on has landed, so the two-scan mount is enabled this cycle: two georeferenced tiles that declare the same projected CRS place into one shared frame at their real separation, non-destructively. The rigid-alignment cores are pure and tested; the interactive surfaces that drive registration from tie points are staged for a later cycle.

## Terrain evidence on real airborne LiDAR

The terrain evidence moves off synthetic fixtures and onto public, cited field data. None of it changes a formal evidence grade on its own; it widens the ground the existing grades rest on and adds two absolute-accuracy results.

- **Absolute accuracy against surveyed checkpoints.** OLV's DTM was compared to independent surveyed ground truth at two public USGS sites, both NAVD88 orthometric so no vertical-datum reconciliation is involved. On the Marsh Island UAS survey (104 RTK check shots), 101 checkpoints agree at 2.8 cm RMSE. On the AZ Coconino 2019 airborne survey, a single forested (vegetated) checkpoint agrees at 3.9 cm. This is external checkpoint agreement on found data, not a preregistered field campaign, and the forest result is one measurement, not a distribution;
- **Slope cross-implementation on real steep terrain.** Slope stays at E4; its cross-check now also runs on a 150 m Coconino crop with 40 m of relief and local slopes to ~45°, where OLV's Horn slope agrees with gdaldem 3.13.1 to a maximum of 0.013° over 19,834 cells;
- **Ground-filter cross-check on real low-relief terrain.** OLV's SMRF-core ground filter and PDAL's full `filters.smrf` agree on 0.99985 of 95,005 returns over a balanced (40% ground) real boreal crop from the Estonian Land Board 2020 survey. The agreement tracks terrain relief: flat ground coincides, steep and complex terrain diverges, so the result is scoped to low-relief terrain. The formal register promotion is a follow-up.

## Contours reach cross-implementation evidence

Contours move from E3 to `E4_CROSS_IMPLEMENTATION_VALIDATED`. Our marching-squares isolines are compared against GDAL's `gdal_contour` on a frozen analytic tilted plane, where linear interpolation is exact so the tolerance measures agreement rather than interpolation noise. The two implementations agree within 0.05 m across every compared vertex, with a maximum separation of 2.9×10⁻⁵ m. The comparison, its command, tool version, and checksums are recorded in a freeze-verified study manifest whose tolerance was registered a month before the reference was generated. The map-sheet export routes as a validated export; survey-grade contours remain a prohibited claim.

## Remote streaming, hardened

- signed remote EPT URLs are scrubbed from transport error messages, so a SAS or presigned dataset's credential can no longer reach a screenshot or a support ticket;
- every remote range read is bounded in bytes and in time: an over-large body is refused mid-stream, and a body that goes quiet is bounded by an idle and a whole-body clock rather than hanging the load;
- the remote object's identity is pinned across a load — validators and total size are checked on every read with `If-Match` where offered — so a file re-uploaded mid-decode fails with a distinct code instead of splicing two versions;
- a streaming scan carries a stable shell id, so the export and terrain scan-identity guards catch a streaming-to-streaming swap the previous null id read as the same scan.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.5.md`. Carried forward from v0.6.4 and unchanged: a large class of terrain and measurement products still fail closed on an unconfirmed unit rather than guess; there is no cross-CRS reprojection into a common viewer frame; and the residual streaming flicker at the point-budget boundary is unchanged. New this cycle: multi-layer mounting is enabled, with one outstanding precision refinement (the renderer's far-apart-mount render-origin fold, bounded and refused past 1 mm by the mount-precision gate) and a dedicated pick/measure-on-a-mounted-tile browser assertion still to be written; the DTM checkpoint results are external agreement on found data, not a preregistered field campaign, and the forest checkpoint is N=1; the ground-filter agreement holds on low-relief terrain and diverges on steep terrain, which is out of scope; the feature-extraction and registration interactive UIs are staged, not shipped.

## Compatibility

Unchanged from v0.6.4. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible. Session files are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.5.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.5
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.4...v0.6.5](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.4...v0.6.5)
