# Known limitations: OpenLiDARViewer v0.6.8

## No evidence promotion this cycle

The register holds 34 claims: 2 at E1, 6 at E2, 9 at E3 and 17 at E4. No product
is at E5, and none moved this cycle. One was added: generalized contours are now
their own claim at E2, because the cross-implementation study behind the CONTOURS
E4 ran on the analytical geometry and a simplified line is not covered by it. The E5 work in v0.6.8 is preparation, not
promotion: the Rogue tiles are registered, the dev and holdout split is
deterministic and exposure-honest, and the manifests recompute their class
histogram and ground invariants. The holdout itself has not been run. A product
reaches E5 only against surveyed field reference, and nothing here is that.

## Code that ships but is not reachable

The registration stack (`registrationModel`, `planarIcp`, `generalIcp`,
`rigidSolve`, `tiePointAlignment`, `transformStore`) and the stockpile
area-weighted volume estimator are implemented and tested, and no user path
reaches them. They are recorded in `docs/validation/unreachable-modules.json`,
which a lint enforces, so they are inventory rather than a delivered feature. Do
not read the registration work as epoch alignment you can run.

Three provenance modules are in the same state: the scientific artifact passport
(`scientificArtifactPassport`), the evidence boundary inspector
(`evidenceBoundaryInspector`) and the DTM surface digest (`dtmProductDigest`).
No export constructs a passport, no interface renders the inspector, and no
delivered surface is passed to the digest. Earlier drafts of this release's
notes described all three as delivered, including a DTM surface carrying its own
SHA-256; that wording is corrected. The report and manifest digests that do ship
are unaffected and remain real.

## Touch is verified on one engine

Pinch, rotate and two-finger gestures are exercised end to end on Chromium only.
The WebKit and Firefox legs skip those specs because the test harness cannot
grant the permission they use to read their result. The gesture arithmetic is
unit-tested independently of any engine, so what is unverified is the
integration, not the maths.

## Hovering the canvas changes the shading pipeline

Every pointer move over the canvas opens a 350 ms render-activity window, and
the renderer reads that window as camera movement, so Eye Dome Lighting turns
off and comes back once it lapses. Moving the mouse across a parked scene
therefore changes its shading without changing the view. The same signal feeds
the adaptive resolution and refinement decisions.

Separating "this frame needs drawing" from "the camera is moving" means two
windows and a decision at each of the eleven places that currently open one.
That is a change to the render-quality policy, and its effect is a visual one
that this release cannot verify: the touch and rendering legs run headless, and
what a reader would need to see is whether the brightness pops. It is recorded
here rather than changed unverified under the freeze.

## Firefox and WebKit are advisory in CI

The blocking browser gate is Chromium. Firefox and WebKit run the full
deterministic suite, and a regression in either would not by itself stop a
release. Both are green on the commit this document describes. The release has not been cut, so nothing here reports a tagged run.

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
- Three unit defects that were recorded here are now fixed, and all three fail
  closed on an unresolved linear unit rather than presenting a metric figure.
  A measurement CSV or GeoJSON named its columns `length_m`, `area_m2` and
  `volume_m3` whatever the scan's unit turned out to be, so a row printed the
  `units-unverified` retraction in its evidence field while the column name
  still asserted metres to any program parsing the header; with no resolved
  scale those columns are now `length_source`, `area_source2` and
  `volume_source3`. The floor-plan wall band is a physical slice 0.7 to 1.8 m
  above the detected floor, and an inert scale of 1 applied those metres to
  source coordinates, so a foot-unit capture traced skirting at roughly 0.21 to
  0.55 m instead of wall. That changed which points were analysed, not merely
  how they were labelled, so the plan is refused outright until the CRS is
  confirmed. The grid and contour-interval recommender reads extent and relief
  that are in source units and picks from metre ladders, which sized a foot
  capture about 3.3 times too large; those inputs are converted now, and the
  recommendation is withheld entirely when no scale resolves.

The first three would each move a published verdict, so they are recorded here
rather than changed under the freeze. The unit defects were changed, because a
figure labelled in a unit it is not in is a false statement rather than a
verdict.

## The shell has little headroom

The eager bundle measures 803 KiB against an 812 KiB ceiling, above its own
warning threshold. The fix is a lazy seam for the report builders, which are
statically imported today, and that is a refactor rather than a tuning step.

The ceiling moved from 800 to 812 in this cycle. What grew is the
frame-freshness wiring described under the monoliths below, and it sits in the
eager shell because the shell holds the handles it has to invalidate. The lazy
seam was weighed as the alternative and not taken: making the module registry
asynchronous turns two synchronous error guards into escaping rejections, and
the compiler does not flag that. Every raise of this ceiling is recorded beside
the number in `scripts/check-bundle-budget.mjs`.

## The two monoliths are still monoliths

`src/main.ts` is 5,558 lines and `src/render/Viewer.ts` is 6,424. A lint fails
the build when either file passes its recorded baseline, so neither may grow
beyond the number banked for it. The `--update` flag banks a drop and refuses a
raise, so raising a baseline is a hand edit to
`docs/validation/monolith-size-baseline.json` and always shows up in the diff.

Both baselines were raised inside this cycle: `src/main.ts` in three steps from
5,529 to 5,558, and `src/render/Viewer.ts` in two from 6,407 to 6,426, then
lowered to 6,424 when the classification-input rule moved out of it. Measured
against v0.6.7 the shell is smaller, 5,675 then against 5,558 now, and the
renderer larger, 6,419 then against 6,424 now.

Most of what those raises paid for is the frame-freshness wiring: a
coordinate-system change now invalidates a running terrain analysis, a running
classification derive, an in-flight full-cloud grade and a captured space or
object measurement. It also marks a COMPLETED derived classification stale,
because the classifier converts physical thresholds into source units, so those
classes only mean what they say in the frame they were derived under. The
classes are kept and the analyses built on them go stale; nothing is discarded.

The rest closes two multi-layer defects. New work placed while several layers
are mounted is now stamped in the project frame, which is the frame its
coordinates were already in; and a terrain export whose contributing layers
disagree on their origin publishes no world origin at all, rather than anchoring
the combined surface to whichever layer happened to be active.

Every one of those handles lives in the shell or the viewer, which is why the
wiring does. The decomposition is that much more overdue.

## Multi-layer mounting is enabled, with a precision refinement outstanding

Physical multi-layer mounting ships enabled. Two georeferenced layers declaring
the same projected CRS mount into one shared project frame at their real
separation, non-destructively, and each boundary recovers the world coordinate
in the frame it names. One item is a precision refinement rather than a
correctness defect: for far-apart mounts the renderer should fold `renderOrigin`
out on the CPU per mesh so the Float32 residual on the GPU stays small. The
mount-precision gate refuses a placement past 1 mm, so one that cannot hold a
millimetre never mounts. Incompatible layers carry no placement and stay in
their own frame.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared; the viewer refuses rather than approximating.

## A correction to the v0.6.7 limitations

`KNOWN_LIMITATIONS_v0.6.7.md` records `HOLDOUT-RMSE` and `NVA-VVA` as recomputed
in base R 4.4.1. The two study manifests those claims rest on,
`ACCURACY-RMSE-R-RESIDUALS` and `ACCURACY-NVA95-R-RESIDUALS`, both record
`R version 4.6.1 (2026-06-24)`, and both already did so at the v0.6.7 tag, so
the prose was wrong on the day it shipped. The version that ran is 4.6.1.
`MEAS-PROFILE` cites R 4.4.1, which its own manifest confirms, and is
unaffected. The v0.6.7 file is left as it was published.

## Inherited limits

Everything in `KNOWN_LIMITATIONS_v0.6.7.md` that is not listed above still
applies.
