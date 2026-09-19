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

## Inherited from v0.6.9, not yet reproduced

The v0.6.9 limitations are not carried into this document automatically. Each is
reproduced or cleared through the implementation ledger, and only what survives
that check appears here.

## The two monoliths are still monoliths

`src/main.ts` is 4,977 lines and `src/render/Viewer.ts` is 6,223, unchanged from
v0.6.9. A shrink-only lint fails the build when either passes its recorded
baseline, so a raise is a hand edit to
`docs/validation/monolith-size-baseline.json` and always shows in the diff. It
caught one added line during this cycle. Fan-out is 112 for the shell, 77 for
the renderer and 23 for the Analyse panel, across 843 modules with no
dependency cycles.

## The shell has little headroom

The eager bundle measures about 805 KiB against an 812 KiB ceiling. New work
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
