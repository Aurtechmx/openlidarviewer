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

## Touch is verified on one engine

Pinch, rotate and two-finger gestures are exercised end to end on Chromium only.
The WebKit and Firefox legs skip those specs because the test harness cannot
grant the permission they use to read their result. The gesture arithmetic is
unit-tested independently of any engine, so what is unverified is the
integration, not the maths.

## Firefox and WebKit are advisory in CI

The blocking browser gate is Chromium. Firefox and WebKit run the full
deterministic suite, and a regression in either would not by itself stop a
release. Both were green when this release was cut.

## Three measurement figures with a known basis problem

- The Analyse ground density and its quality-level chip derive from the resident
  gather, while the Scan Report back-scales to the declared count. The two
  disagree by roughly the stride factor. Both are labelled with their basis; the
  numbers are not reconciled.
- The boundary share seeds its search from every non-measured cell, so on a
  sparse tile most of what it calls boundary is stride gap.
- The oriented bounding box derived by principal components overstates length on
  an elongated footprint. It is labelled unvalidated rather than presented as a
  measurement.

Each would move a published verdict, so each is recorded here rather than
changed under the freeze.

## The shell has little headroom

The eager bundle measures 796 KiB against an 800 KiB ceiling, above its own
warning threshold. The fix is a lazy seam for the report builders, which are
statically imported today, and that is a refactor rather than a tuning step.

## The two monoliths are still monoliths

`src/main.ts` is 5,529 lines and `src/render/Viewer.ts` is 6,407. A shrink-only
lint holds both at exactly those counts, so neither can grow; a change that adds
to one has to take the same amount back out.

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

## Inherited limits

Everything in `KNOWN_LIMITATIONS_v0.6.7.md` that is not listed above still
applies.
