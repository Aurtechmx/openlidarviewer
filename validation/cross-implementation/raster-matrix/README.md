# Raster agreement matrix — slope, aspect, hillshade

Broadens the slope / aspect / hillshade comparisons from one frozen DEM to a
matrix of 24 analytic fixtures, and records where the agreement with GDAL holds
and where it stops.

This directory **promotes nothing**. `docs/validation/claim-register.yaml` and
`REFERENCE_SLOTS` in `src/validation/crossCheck.ts` are untouched.

## Evidence level

An analytic fixture compared against its own closed-form gradient is **E2** —
one implementation against a formula, however many fixtures it spans. Against a
synthetic surface it is E3. It is **E4** only where a second independent
implementation produced the reference.

Every leg in `results.json` carries `reference` and `evidenceLevel`. Only the
`GDAL 3.13.1` legs are cross-implementation. **24 fixtures is not E4 breadth.**

## Reference pinning

| item | value |
| --- | --- |
| `gdalinfo --version` | `GDAL 3.13.1 "Iowa City", released 2026/06/01` |
| resolved `gdaldem` | `gdaldem (GDAL 3.13.1_4, host-installed; see reference-runs.json)` |
| container pinning | `not-executed` — Docker is installed on this host but the daemon is not running, so GDAL was invoked from the host PATH |
| PROJ version | `not-recorded` — `projinfo` on this host has no `--version` flag and `gdaldem` does not report it |

Every exact command line is in `reference-runs.json` (`commandLine`, plus the
raw `argv` and the exit code) and repeated in `results.json` under
`commandLines`.

## Layout

| path | contents |
| --- | --- |
| `fixtures/` | 24 input DEMs as ESRI ASCII Grid, plus a `.prj` for the geographic one |
| `fixtures.json` | fixture manifest: geometry, surface, nodata pattern, comparable and halo cell counts |
| `gdal/` | 101 `gdaldem` outputs |
| `gdal-SHA256SUMS` | hash per GDAL output |
| `olv/` | the same products computed by this project, for side-by-side diffing |
| `olv-SHA256SUMS` | hash per OLV output |
| `reference-runs.json` | environment, argv, exit code and stderr for every `gdaldem` invocation |
| `results.json` | 231 comparison legs with max abs diff, RMSE, mean bias, within-tolerance fraction, and the boundaries |

## Reproducing

```
node scripts/generate-raster-fixtures.mjs
node scripts/run-gdaldem-reference.mjs
npx vitest run tests/rasterAgreementMatrix.test.ts
```

The third step recomputes the OLV side and asserts it still matches the
committed `results.json` and `olv-SHA256SUMS`. It does not rewrite them: a run
that regenerates its own expectation cannot fail. To regenerate after a
deliberate change to the OLV side, run `npm run validation:matrix:update` and
commit the diff. Tolerances live in `FROZEN_TOLERANCES` in the test, with
the derivation each was fixed from before any result was seen.

`results.json` and `olv-SHA256SUMS` are the expectation, not the output, so a
drift fails instead of landing in a diff nobody reads. The release gate runs
this file through the `terrain` bucket, which is what makes the default matter.

## Metrics

Slope uses plain absolute error, which is what a magnitude takes. Aspect uses
circular separation, so 359° and 1° are 2 apart. Hillshade is compared twice and
the two legs are independent: unquantised intensity `h`, then the shipped 8-bit
level. The byte tolerance has to be 2 levels to absorb gdaldem's `1 + 254h`
encoding against our `255h`, which makes it blind to a half-level shading error —
so the intensity leg exists, and one test injects exactly that fault to show
which leg catches it.

## Boundaries found

Recorded in `results.json` under `boundaries`. In short:

- **Border slope is roughly halved.** Under `-compute_edges`, gdaldem
  extrapolates a virtual ring and recovers the true gradient; `hornSlopeAspect`
  clamps, halving the run while the rise stays the same. On a 19.3° plane we
  report 9.9°. Up to 16.2° of shortfall, bias always negative, on the whole outer
  ring.
- **Geographic aspect diverges by 7.5° at latitude 45.** `gdaldem aspect` accepts
  neither `-xscale` nor `-yscale`, so its only model is equal spacing in degrees.
  `gdaldem slope` and `gdaldem hillshade` do accept them. An anisotropic aspect
  reference is `unavailable` from the reference tool.
- **Multidirectional relief is a different model on each side**, diverging by up
  to 50 of 255 levels. It coincides only at zero gradient.
- **Nodata policy differs.** gdaldem propagates nodata through the 3x3 window;
  ours substitutes the centre value and answers for every halo cell, biasing
  slope toward zero near a hole with no marker in the output.
- **Flat-ground aspect reads as due east.** gdaldem writes `-9999` by default and
  `0` under `-zero_for_flat`. `hornSlopeAspect` writes 0 radians in the math
  frame, which is compass 90, and carries no undefined marker.
