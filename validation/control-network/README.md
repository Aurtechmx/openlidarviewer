# Control-network measurement + tie-point registration

Two things a shared surveyed control network can prove about a viewer: that it
**measures** the network consistently, and that the network is enough to
**register** two otherwise-unplaceable scans. This leg checks both against real
surveyed targets, through OLV's own code.

## Background

Two scanner-local scans of one site can carry the same physical survey targets,
each expressed in that scan's own local frame (no shared CRS — so the CRS-based
multi-layer mount cannot place them). The targets are the bridge:

- their pairwise distances are a rigid invariant, so the same target network
  measured in either frame must give the same distances;
- the target correspondences determine the rigid transform between the frames.

## What runs where

- `src/geo/tiePointRegister.ts` — `registerTiePoints(src, dst)`, a from-scratch
  rigid (rotation + translation, no scale) solver by Horn's quaternion method.
  It is the least-squares optimum for any number of correspondences ≥ 3 and can
  never return a reflection.
- `tests/tiePointRegister.test.ts` — committed unit test: recovers a known
  transform to sub-micron on 10 m-scale points, refuses a reflection, reports a
  residual at the injected noise level. No external data; runs in CI.
- `tests/controlNetworkExternal.test.ts` — real-data leg. When
  `OLV_CONTROL_NETWORK_DIR` holds `*_vertices.txt` target files, every pair of
  frames sharing ≥ 3 targets is checked for distance invariance (via OLV's
  `geometry.distance`) and frame-to-frame registration residual. The surveyed
  coordinates are public, CC BY 4.0, and registered as `OLV-DS-055` (Zenodo
  10.5281/zenodo.11518223); they arrive with the point clouds they belong to,
  which are not vendored, so CI skips this leg.

## Real-data result

Two scanner-local scans of one site, three shared surveyed targets:

| Check | Result |
|---|---|
| Inter-target distances, measured by OLV in each frame | agree to **≤ 6.7 mm** across the two frames (16.00 m, 23.11 m, 33.13 m legs) |
| Frame-to-frame rigid registration from the 3 targets (`registerTiePoints`) | **3.93 mm** RMS residual; ~45.7 m translation between the setups |

The distance agreement is the survey's own consistency, reproduced by OLV's
measurement path; the registration residual is what a tie-point alignment of the
two clouds would achieve. Both are at the millimetre level on real survey data.

## Status and scope

`registerTiePoints` is a tested primitive, not yet wired to a UI. Interactive
tie-point registration — picking matching targets in two loaded scanner-local
scans and mounting one onto the other's frame from the solved transform — is the
follow-up feature this measurement supports; the CRS-based mount already handles
the georeferenced case.

## Reproducing

```
OLV_CONTROL_NETWORK_DIR=/path/to/vertices \
  npx vitest run tests/controlNetworkExternal.test.ts
```
