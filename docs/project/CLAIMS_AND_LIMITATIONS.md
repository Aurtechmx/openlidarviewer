# Claims and limitations policy

This is the canonical reference for what OpenLiDARViewer publicly claims and
what it explicitly does not. Every other document, README, release notes,
validation reports, exported PDFs, the website, should reference these
definitions rather than restate them. One authoritative source is the
strongest protection against contradictory or overly broad claims appearing
as the project evolves.

The policy is version-controlled on purpose: a claim changes by changing this
file in a commit, with the evidence that justifies the change, and in no
other way.

## Vocabulary

The project uses these words with these meanings, and no others.

**Validated**, compared against a named reference under recorded conditions,
with the tolerance, fixture, and result written down. "The slope raster is
validated against GDAL 3.13.1 on the analytic fixture" is a complete claim;
"validated" without a reference is not a claim this project makes.

**Verified**, a fact the software established mechanically and records: a
checksum matched, a frame compatibility ladder was climbed, a gate exited 0.
Verification names its mechanism.

**Agreement**, the measured difference between this implementation and a
reference. The project reports agreement figures (maximum difference, RMSE)
rather than accuracy figures: agreement against a named reference is
checkable by anyone; accuracy is a claim about the world.

**Deterministic**, the same input on the same toolchain produces the same
output. This is a property the project tests for, not an accuracy statement.

**Numerically stable**, an implementation that does not lose precision to
its own arithmetic (origin-relative coordinates, Float64 transforms). Says
nothing about how well the data represents the ground.

**Evidence level (E0 to E6)**, the ladder recorded in
`docs/validation/claim-register.yaml`. E3 is synthetic known-truth against our
own implementation; E4 is cross-implementation agreement with an independent
reference; E5 is field validation against ground truth. A claim's level is
machine-checked by `lint:claim-register` and changes only with new evidence.

## Words this project does not use as claims

**Accurate / accuracy**, never claimed. The word appears only when naming an
external standard ("ASPRS accuracy standards", NVA, VVA) or when stating what
is NOT claimed. Accuracy is nearly impossible to defend; agreement against a
named reference is what we publish.

**Survey-grade**, never claimed, anywhere, for anything. It appears only in
negations ("not survey-grade unless validated against ground-truth control"),
which every terrain export carries.

**Professional / certified / precise / exact**, not used as quality claims.
A report is "technical", a workflow is described by what it does, precision
is stated as a measured figure with units, and exactness is claimed only for
discrete properties a test pins (byte-identity, exact inverses).

**Marketing superlatives**, "best", "industry-leading", "most accurate",
"state-of-the-art", "world-class", "ultimate", never, in any document.
`lint:claims-language` fails the gate if one appears.

## What the software currently claims

- Seventeen products are at E4. Five are algorithm checks against GDAL:
  `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA`
  each agree with GDAL 3.13.1 and with the closed-form gradient on the same
  frozen analytic fixture within their tolerances (0.5° for slope
  and aspect, 1.0 level on the 0 to 255 scale for hillshade; the slope, hillshade
  and contour tolerances were preregistered, while aspect's was carried over from
  slope in the same change that produced its result). This validates those
  algorithms on one fixture. Aspect is compared as a circular quantity, and only where the
  surface is steeper than 2°, a level cell has no aspect to compare. The
  hillshade tolerance is weaker than it looks: GDAL encodes the shared
  intensity as `1 + 254·h` where we write `255·h`, and that fixed offset
  consumes most of the one-level budget on its own, so the hillshade claim
  rests on the closed-form agreement (6×10⁻⁵ of a level) and on our intensity
  reproducing GDAL's raster exactly under GDAL's own encoding, rather than on
  the tolerance test alone.
- The remaining E4 products are the surface grids, checked against PDAL: `DSM`
  (max return) and `DTM` (min return) each agree with PDAL 2.10.2
  `writers.gdal` over 7500 cells on three seeded synthetic clouds, to a maximum
  difference under 4×10⁻⁶ m, under a 0.05 m tolerance registered before the
  references were generated. `CHM` (clamped DSM minus DTM) agrees with the PDAL
  max grid minus the PDAL min grid on the same clouds over 7500 cells to under
  8×10⁻⁶ m, under a 0.1 m registered tolerance. These cover the cell gridding on
  clouds where the reference radius is below half a cell. They do not validate
  ground classification (`GROUND-FILTER` stays partial) or real-terrain void
  interpolation, so the DTM's own required bar remains E5.
- The two terrain descriptors are each checked three ways against an independent
  tool and the closed form on a controlled analytic
  fixture: `TPI` agrees with gdaldem 3.13.1 and the closed-form quadratic
  curvature to under 9×10⁻⁷ within a 1×10⁻⁵ tolerance, on a
  low-amplitude quadratic chosen so the reference's float32 accumulation stays
  below tolerance; `VRM` agrees with SAGA 7.8.2 within 1×10⁻⁴ and reproduces the
  closed-form Sappington VRM to under 1×10⁻⁹, on a smooth tilted quadratic
  chosen so Horn and SAGA normals converge. They do not cover under-resolved
  sharp features (VRM) or high absolute elevations (TPI).
- `MEAS-PROFILE`, the corridor section profile, is the eleventh, and it is a
  measurement rather than a raster. Its reference is built from two tools:
  OGR/SpatiaLite 5.1.0 places every point on the section line and R 4.4.1
  `quantile(type = 7)` reduces each station. Over 751 stations on two committed
  point clouds the largest difference is 3.6×10⁻¹⁵ m, under a 1×10⁻⁶ m tolerance
  registered before the reference existed, and the per-station corridor counts
  match exactly. On the analytic ramp both sides also reproduce the closed form
  the surface implies, to the last bit. It covers the corridor gate, the
  classification gate, the station binning and the type-7 reduction at two
  percentiles on synthetic clouds; it is not accuracy against a surveyed section.
- `E57-INGEST` is the twelfth, and it covers a reader rather than an algorithm.
  The decoded cartesian coordinates, `nor:` namespaced surface normals and colour
  of a public CC-BY terrestrial scan agreed exactly with PDAL 2.10.2
  `readers.e57` over all 1,788,994 points and nine dimensions, compared as an
  exact quantised integer sum at a 1×10⁻⁶ quantum under a tolerance registered
  before the reference existed. The scan is a CloudCompare re-export rather than
  a scanner-native write, so vendor extension blocks, multi-scan files and
  spherical coordinates are untested. Intensity sits outside the comparison
  because PDAL rescales it by 65535/(max − min) without subtracting the minimum.
- `CRS-UTM-PROJECTION` is the thirteenth, and it is a coordinate conversion. Over
  36 frozen WGS-84 coordinates, `latLonToUtm` picked the same zone and hemisphere
  as GeographicLib 2.7 every time, the widened Norway zone 32V and the Svalbard
  zones 31X, 33X, 35X and 37X included. Easting and northing agreed with both
  PROJ 9.8.1 and GeographicLib 2.7 to under a millimetre, the largest differences
  being 4.531×10⁻⁴ m and 9.521×10⁻⁴ m, under a 1.5 mm tolerance set from the
  physical question rather than from the result. The two references agree with
  each other to 2×10⁻⁹ m, six orders below the gate, which is what makes the
  remaining difference the candidate's own. It takes both signs across the
  fixtures, so it is series truncation and not an offset in one direction. The
  fixtures carry WGS 84 on both sides, so no datum transformation and no PROJ
  transformation grid is exercised, and the function takes no height, so vertical
  reference and ECEF are outside what was measured.
- `HOLDOUT-RMSE` and `NVA-VVA` are the fourteenth and fifteenth, and they are
  statistics rather than products of a surface. Base R 4.6.1 recomputed them over
  six frozen residual vectors: bias, RMSE and the maximum absolute residual agree
  to about 4.4×10⁻¹⁶ over eighteen comparisons, and the 95 percent figure, 1.96
  times that RMSE, agrees to about 8.9×10⁻¹⁶ over six, both under a 1×10⁻¹²
  tolerance. That establishes the formula is computed correctly outside
  TypeScript, including that RMSE is the raw second moment rather than a standard
  deviation. It establishes nothing about accuracy: both claims still require E5,
  the held-out points still come from the same source as the interpolated ones,
  and the tolerance was adopted alongside the result rather than preregistered.
  Median, NMAD and P95 are excluded because R interpolates at type 7 while
  `checkpointAccuracy` takes the nearest rank, a difference the study records
  rather than resolves.
- `CHANGE-RASTER` and `CHANGE-VOLUME` are the sixteenth and seventeenth, and
  they are the change pair. GRASS 8.5.0 `r.mapcalc` and `r.univar` recomputed
  them over eight frozen synthetic epoch pairs at one metre. Every case agrees
  with GRASS and with the closed-form volume the pair was built from, on gain
  volume, loss volume, gained cells, lost cells and comparable cells: both sides
  select the same 3007 comparable cells and the largest relative difference is
  7×10⁻⁶ under a 1×10⁻⁵ gate derived from the candidate's Float32 storage. Truth
  is scored first and implementation agreement second, because two programs
  summing the same wrong cells agree perfectly. Only one-metre metre-CRS grids
  were compared, agreement with GRASS on synthetic epoch pairs is not accuracy
  against surveyed field change, and the protocol freeze is `adopted-with-result`
  rather than a preregistration, because it landed in the same commit as the
  first result.
- Every other terrain product tops out at E3. No product is field-validated.
- Local files are processed on this device; remote datasets stream only when
  selected. Nothing is uploaded.
- Source geometry is immutable after load (pinned by test), and spatial
  placement is a Float64 transform, never a rewrite of the data.
- Releases are reproducible to the recorded toolchain, and every published
  figure traces to a machine-generated record (`lint:evidence`).

## What the software does not claim

- Survey-grade results, field accuracy, or standards certification of any
  kind.
- Cross-CRS reprojection. Layers in different frames stay in different
  frames; the software refuses rather than guesses.
- Vertical comparability without an established shared vertical reference.
- Completeness of a streamed or display-sampled dataset: exports disclose
  when they contain a subset, and results computed on a sample say so.

## How other documents should use this file

State the specific claim with its evidence ("agrees with GDAL 3.13.1 within
0.5° on the analytic fixture, see CLAIMS_AND_LIMITATIONS.md for what
'validated' means here") and link here for the definitions. Do not restate
the vocabulary; restatements drift.
