# EXAMPLE preregistered protocol

This document is the target of `preregistration.protocolPath` in
`studies/EXAMPLE-DTM-FIELD-CHECK.field.json`. It exists so the example record
has a real file to hash, and so the shape of a preregistration is visible.

**No fieldwork has been done. Nothing below has been carried out.** The numbers
are the ones a protocol has to fix in advance, not measurements.

## What would be tested

The DTM produced by OpenLiDARViewer from an airborne scan of the site, compared
against surveyed checkpoints that were held back from every step of producing
that DTM.

## Fixed before anyone goes to the site

- Tolerance: 0.15 m absolute vertical, at the stated confidence level of the
  reference instrument.
- Minimum usable checkpoints: 40 overall, 12 per land-cover stratum. A stratum
  below the floor is reported as insufficient, not merged into a pooled figure.
- Required fraction within tolerance: 0.95.
- Strata: open-ground, low-vegetation, dense-canopy.
- Checkpoint independence: every checkpoint is observed after the DTM is frozen,
  and none of them is used for registration, control, parameter tuning or manual
  correction. `src/validation/checkpointAccuracy.ts` refuses a sample that
  breaks this, and `scripts/verify-field-study.mjs` refuses a record that does.

## Reduction

Residual is DTM elevation minus surveyed elevation at the checkpoint, positive
where the product sits high. Pooled and per-stratum RMSE, bias, NMAD, and a
bias confidence interval under the normal approximation stated in
`CI_ASSUMPTION`. The survey's own uncertainty is combined by a rule named in the
record; with no rule named, the combined figure stays null rather than the
observed RMSE relabelled.

## What this would not cover

Any other site, any other sensor, any other flight geometry, any season other
than the one flown, and any claim about a product that is not the DTM.
