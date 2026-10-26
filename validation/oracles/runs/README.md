# Runs inside the pinned oracle image

Each file here is one reference run executed inside the pinned oracle image,
written by `scripts/pin-oracle-image.sh`: the environment record the image's
entrypoint produced (`containerPinning: "executed"`, base image digest, lock
digest), the `reference-runs.json` the run wrote, the image's content digest
and the source commit the run read. `oracle-pins.json` names one of these
files in `containerPinning.runReference`, and `verify:oracle-versions` checks
that the named file exists and ran inside the image.

The rasters a run produced are not committed; they were written to a scratch
copy of the tree. Adopting the image for a leg means re-running that leg and
updating the digest its own record carries.
