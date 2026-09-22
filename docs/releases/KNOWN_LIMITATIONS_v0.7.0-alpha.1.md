# Known limitations: OpenLiDARViewer 0.7.0-alpha.1

**In development.** This document is written from the final state at freeze. What
follows is the state so far, and every entry is reproduced rather than carried
forward from v0.6.9 by default.

## Classification flags are preserved but not yet acted upon

The decoder keeps Synthetic, Key-Point, Withheld and Overlap, and both LAS
writers emit them. No processing path consumes them yet, so a withheld point
still enters terrain, density and stockpile as an ordinary return. ASPRS says a
producer generally sets Withheld on overlap points culled during flight-line
merging, so this matters on conforming files. A withheld processing policy is
open work.

## Flags do not survive every derivation

Clipping carries them. Voxel downsampling does not: it takes the first point in
each voxel for every attribute, and applying that to a safety flag would let one
withheld point among nine ordinary ones lose its marking. That aggregation is
left undecided rather than guessed. EPT and COPC decode on their own path and
produce no flags, which reads as absent rather than as false zeros.

## Class names are exact only when the format is known

A source that declares a point data record format gets the exact name. A
streaming source declares none here, and the four codes whose meaning differs
between the legacy and extended tables report both readings rather than one
guess.

## What the ledger settled, and what it did not

Every v0.6.9 limitation was reproduced or cleared rather than carried forward.
The implementation ledger records each one with how it was established and the
test that proves its status. Of the inherited set, the boundary share was fixed,
the stockpile split was half closed, and two turned out not to reproduce: the
oriented extent is presented as a principal-axis estimate with its failure mode
named, and truncation is reported rather than hidden.

## The boundary share now measures the survey edge

It seeded a distance field at every cell that was not measured, so on a grid
thinned by a display stride nearly every measured cell sat beside a seed. Over
one geometry it read 33 per cent at full decode and 100 per cent strided. It
seeds only from cells with no reachable data now, and distances travel through
the surveyed region, so neither depends on how densely the surface was sampled.

## One lasso still answers twice

The toast reports an area-weighted grid volume. The stored record holds the
point-sample figure, and they do not agree. The record now names which estimator
produced it, and a record written before that field carries none rather than
being read as the newer method, but the two numbers are still two numbers.
Moving the stored figure changes an exported value and is not done here.

## Two densities, each stating its basis

Analyse reads the resident gather and the Scan Report divides the declared count
by the sampled footprint. They differ by roughly the stride factor. Neither
hides its basis: on a strided load the report says in the value itself that it
is the declared count over the display-sample footprint. What is missing is one
record rather than two computations.

## Registration is not exposed

Six modules implement alignment. No user path reaches them.

A half-wired alignment tool is worse than none, and the workflow it would need
is not built.

## The browser matrix is advisory

Chromium blocks a release; Firefox, WebKit and Windows do not. Touch gestures
run end to end on Chromium only, because the harness cannot grant the permission
the others read their result through. No matrix is recorded for this development
cut: that evidence comes from the engines themselves.

## The two monoliths are still monoliths

`src/main.ts` is 4,972 lines and `src/render/Viewer.ts` is 6,164, fifty-nine below
v0.6.9. Five getters collapsed to make room for a memory accessor and a
size-mode call, and the streamed draw cull then paid for its own wiring by
moving the pass onto the streaming renderer and collapsing two more
expressions. Making the loop request-driven then took another thirty-one out:
the activity deadlines, the reasons a frame is wanted and the scheduler left
together as one object, which is fewer lines here and one thing to reach for
there. The frame gained a decision while the file lost lines. A shrink-only lint fails the build when either passes its
recorded baseline, so a raise is a hand edit to
`docs/validation/monolith-size-baseline.json` and always shows in the diff. It
caught an added line twice during this cycle, and a banked drop once. Fan-out is 110 for the shell, 76 for
the renderer and 23 for the Analyse panel, across 895 modules with no
dependency cycles.

## The shell has little headroom

The eager bundle measures about 810 KiB against an 812 KiB ceiling. New work
goes behind a lazy seam rather than being paid for by a raise.

## Multi-layer mounting is enabled, with a precision refinement outstanding

Physical multi-layer mounting ships enabled, unchanged from v0.6.9. Two
georeferenced layers declaring the same projected CRS mount into one shared
project frame at their real separation, non-destructively, and each boundary
recovers the world coordinate in the frame it names. One item remains a
precision refinement rather than a correctness defect: for far-apart mounts the
renderer does not fold `renderOrigin` out on the CPU per mesh, so the Float32
residual on the GPU is larger than it needs to be. The mount-precision gate
refuses a placement past 1 mm, so one that cannot hold a millimetre never
mounts.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared, and the viewer refuses rather than approximating.
