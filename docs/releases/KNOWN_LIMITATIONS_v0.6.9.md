# Known limitations: OpenLiDARViewer v0.6.9

## No evidence promotion this cycle

The register holds 34 claims: 2 at E1, 6 at E2, 9 at E3 and 17 at E4. No product
is at E5, and none moved this cycle. Nothing was added or removed. A product
reaches E5 only against surveyed field reference, and nothing here is that. The gate for this release ran the test buckets unit 9,488, export 1,062, terrain 2,943, ui 862, slow 1,240.

## The stockpile volume changed method and did not change level

The interactive stockpile estimate is now integrated over a polygon-clipped
grid, `olv.volume.stockpile-area-grid` at generation 2, rather than summed over
a point sample. VOL-STOCKPILE stays at E3: the method is checked against
synthetic known truth, and its accuracy against surveyed field volume is not
established. The change removes a sensitivity to how many points happened to be
resident; it does not make the figure a survey result.

A streaming source reports PREVIEW until the whole source is resident. A partial
figure is labelled, not withheld, so a PREVIEW number is an interactive estimate
over what is loaded and should not be read as a measurement of the site.

## The canonical stockpile record is not integrated

The area-grid estimate is live in the lasso toast. Nothing beyond the toast
carries it. The session record, the technical report and the measurement CSV
still hold the point-sample cut and fill volume record, so the toast and the
exported record can disagree on the same lasso. What this release delivers is an
interactive area-weighted estimate, not a replaced record.

## Code that ships but is not reachable

The registration stack (`registrationModel`, `planarIcp`, `generalIcp`,
`rigidSolve`, `tiePointAlignment`, `transformStore`), the scientific artifact
passport (`scientificArtifactPassport`), the evidence boundary inspector
(`evidenceBoundaryInspector`) and the DTM surface digest (`dtmProductDigest`)
are implemented and tested, and no user path reaches them. The register in
`docs/validation/unreachable-modules.json` lists 36 modules, and a lint enforces
it, so they are inventory rather than delivered features. The stockpile
area-grid estimator has left that register, because the lasso toast now reaches
it.

## Touch is verified on one engine in CI

Pinch, rotate and two-finger gestures are exercised end to end on Chromium only
in CI. The WebKit and Firefox legs skip those specs because the test harness
cannot grant the permission they use to read their result. Locally the
webkit-mobile, width smoke, mobile smoke and touch suites all pass. The gesture
arithmetic is unit-tested independently of any engine, so what is unverified in
CI is the integration, not the maths.

## Firefox and WebKit are advisory in CI

The blocking browser gate is Chromium. Firefox and WebKit run the full
deterministic suite, and a regression in either would not by itself stop a
release. The Windows job is advisory as well. The progressive LAZ and smoke specs
ran green on all three engines at commit 9cf459f3, the pre-tag freeze candidate,
and earlier at 3915e664, 3480251f and 49b25e56; all four runs are
recorded in `docs/validation/cross-browser-progressive-laz.json` (Chromium 153.0.8010.12,
Firefox 155.0, WebKit 26.6, Playwright 1.63.0, macOS 26.5.2 arm64). The release has not been cut, so nothing here
reports a tagged run.

## Remaining measurement basis limitations

- The Analyse ground density and its quality-level chip derive from the resident
  gather, while the Scan Report back-scales to the declared count. The two
  disagree by roughly the stride factor. Both are labelled with their basis; the
  numbers are not reconciled.
- The boundary share seeds its search from every non-measured cell, so on a
  sparse tile most of what it calls boundary is stride gap.
- The oriented bounding box derived by principal components overstates length on
  an elongated footprint. It is labelled unvalidated rather than presented as a
  measurement.

Each of the three would move a published verdict, so they are recorded here
rather than changed in this release.

## The shell has little headroom

The eager bundle measures about 801 KiB against an 812 KiB ceiling. The ceiling
did not move this cycle, and the decomposition and lazy loading in this release
are what kept the number under it. New shell work is added behind a lazy seam
rather than paid for by a raise. Every raise of this ceiling is recorded beside
the number in `scripts/check-bundle-budget.mjs`.

## The two monoliths are still monoliths

`src/main.ts` is 4,977 lines and `src/render/Viewer.ts` is 6,223, down from
5,557 and 6,423 at v0.6.8. A shrink-only lint fails the build when either passes
its recorded baseline, and `--update` banks a drop and refuses a raise, so
raising a baseline is a hand edit to
`docs/validation/monolith-size-baseline.json` and always shows up in the diff.
Fan-out on the concentration modules is 112 for the shell, 77 for the renderer
and 23 for the Analyse panel, and the module-graph lint prints the table.

Two disposal gaps remain from the decomposition: `NavBar.dispose` has no caller,
and `ViewerRenderCore` has no dispose seam.

## Layout limits in the interface

Between 768 and 1000 px, two open rails leave no top-centre gap wider than the
project card. The collision spec asserts only that the surface stays inside the
viewport in that band, so a card and a chip cannot both be placed there. The
label size across the interface remains 11 px; only the values that carry a
result moved to 12 px, so the surrounding text is unchanged.

## The ground filter is weak on the same scenes

Unchanged. Against the external reference labels (OpenGF expert labels, producer
class-2 ground), the mountain scenes sit near an F1 of 0.5 and the dense-canopy
precision near 0.34. Those figures are the register's, and nothing in this
release moves them.

## Multi-layer mounting is enabled, with a precision refinement outstanding

Physical multi-layer mounting ships enabled, unchanged this cycle. Two
georeferenced layers declaring the same projected CRS mount into one shared
project frame at their real separation, non-destructively, and each boundary
recovers the world coordinate in the frame it names. One item is a precision
refinement rather than a correctness defect: for far-apart mounts the renderer
should fold `renderOrigin` out on the CPU per mesh so the Float32 residual on
the GPU stays small. The mount-precision gate refuses a placement past 1 mm, so
one that cannot hold a millimetre never mounts. Incompatible layers carry no
placement and stay in their own frame.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared; the viewer refuses rather than approximating.

## Inherited limits

Everything in `KNOWN_LIMITATIONS_v0.6.8.md` that is not listed above still
applies.
