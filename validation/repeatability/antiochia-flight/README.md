# Two flights, one hillside

Two UAV LiDAR flights over the same archaeological site, 2022-07-07, sixteen
minutes apart, same sensor, same processing chain, independent trajectory
solutions. Where their swaths overlap the same ground was measured twice. This
records how far apart the two measurements are.

This is a property of the capture. It is not a measurement of any software, this
project's included, and it is not an accuracy figure: neither flight is truth,
and no surveyed ground control exists for either. What it bounds is how much of
a single-flight product can be attributed to the ground rather than to the
flight that observed it. Nothing here is registered as evidence for any claim.
Whether it ever is, is not this record's decision.

## The data

`small_bath_area-north-south`, Antiochia ad Cragum, Turkey. OpenMMS with a Livox
sensor, LAS 1.2 PDRF 3, EPSG:32636 with an undeclared vertical datum, millimetre
scales, `las2las (version 220613)`.

| | Flight A (`first_half`) | Flight B (`second_half`) |
|---|---|---|
| Points | 6,512,459 | 6,406,010 |
| GPS time span | 41,542.99 to 42,296.53 s | 42,504.62 to 43,271.69 s |
| sha256 | `2e9d877f…0a0326` | `86fcb4dc…2489f` |

Their starts are 961.6 s apart. Source: Zenodo 10.5281/zenodo.13864073, CC BY
4.0. The clouds are not committed; `reference-runs.json` pins them by digest.

Both files carry `Classification = 0`, `NumberOfReturns = 0` and
`ScanAngleRank = 0` for every point. Ground had to be derived, and neither scan
geometry nor a published classification was available to lean on.

## What overlaps

The headers share a 314 x 383 m box, but the swaths inside it do not. A covers
50,873 of the 121,275 one-metre cells, B covers 53,799, and 10,600 are covered
by both.

The shared ground is a narrow diagonal corridor along the mutual edge of the two
swaths, running up a wooded hillside whose slope over the compared cells has a
median of 14.9° and a 95th percentile of 33.0°. That corridor is the outer
margin of each flight's coverage, where incidence angles are worst in both. The
only place these two flights can be compared is the place each of them is
weakest.

## Cell size: 1.0 m

Measured, not assumed. After ground classification each flight leaves 19.0 (A)
and 17.3 (B) ground returns per covered square metre. Running the same rules at
four cell sizes, with the return floor scaled by area so it means the same
thing:

| cell | shared cells | median ground returns, A / B | comparable cells |
|---|---|---|---|
| 0.25 m | 58,935 | 2 / 2 | 0 |
| 0.5 m | 32,966 | 3 / 5 | 638 |
| 1.0 m | 10,600 | 11 / 19 | 1,723 |
| 2.0 m | 2,930 | 46 / 72 | 401 |

One metre is the finest cell at which both flights determine most cells on their
own, and it yields the largest comparable sample. Over the 1,723 cells that
survive, the counts are a median of 22 (A) and 27 (B) with 5th percentiles of 10
and 11.

Each cell's elevation is a plane fitted to that flight's ground returns and
evaluated at the cell centre, not the cell mean. On a 30° slope two flights that
happened to sample opposite halves of a cell differ by about 0.2 m for no reason
but where their points landed. The plane removes that, and its residual is what
the exclusion rule tests.

## Exclusion rule, and what it cost

| Step | Rule | Cells left |
|---|---|---|
| E0 | ground returns from both flights | 10,600 |
| E1 | at least 10 ground returns from each flight | 4,732 (−5,868) |
| E2 | each flight's ground fits a plane to 0.30 m rms or better | 2,731 (−2,001) |
| E3 | at least 2 m inside the overlap boundary | 1,723 (−1,008) |

That leaves 1,723 comparable cells, 16.3 % of the shared ones.

E1 and E3 remove cells where one flight only clipped a corner, or the edge of
the overlap. E2 is the vegetation and structure rule: on a wooded hillside
carrying standing masonry, a cell whose "ground" returns will not lie on a plane
is a cell where the ground is not what was measured. Every rule reads one flight
at a time and none of them sees the difference, so nothing here selects for
agreement.

## The difference, B minus A

| | metres |
|---|---|
| mean | +1.373 |
| median | +1.711 |
| standard deviation | 2.104 |
| RMS | 2.512 |
| 5th / 50th / 95th percentile | −2.007 / +1.711 / +4.205 |
| NMAD | 2.364 |
| min / max | −3.761 / +6.730 |

### Bias against scatter

The median offset of +1.711 m accounts for 46 % of the mean square. Removing it
leaves an RMS of 2.131 m and the standard deviation unchanged at 2.104 m, so a
constant vertical offset is not the dominant term, and an RMS quoted on its own
would misdescribe this data.

The remaining 2.104 m is not noise either. Subtracting a running local median
leaves progressively less:

| window | residual sd | residual NMAD |
|---|---|---|
| 9 m | 0.434 | 0.256 |
| 15 m | 0.658 | 0.424 |
| 25 m | 0.875 | 0.606 |
| 41 m | 1.100 | 0.726 |

The two surfaces agree to about 0.26 m (NMAD) over ten metres and drift apart
over hundreds. What separates them is a long-wavelength vertical field, not a
step and not white noise, which is the signature of two independent trajectory
solutions rather than of ranging error.

## Co-registration

Not assumed. If B is A shifted horizontally by **s**, then `dz = s · grad(z)`,
so regressing the difference on the terrain gradient reads the shift off
directly and its constant is the vertical offset.

Over the whole field that fit returns a vertical offset of +1.701 m
[1.578, 1.835] and an apparent shift of −1.737 m east [−2.185, −1.299] and
−0.956 m north [−1.374, −0.554], 1.98 m in magnitude, from 2,000 bootstrap
resamples. It explains 4.7 % of the variance. The correlations behind it are
weak: −0.187 with `dz/dx`, −0.128 with `dz/dy`, −0.118 with slope.

That fit cannot be taken at face value. In a corridor this narrow, running
straight up the fall line, the terrain gradient and the position along the
corridor are close to the same variable, so a long-wavelength vertical field is
free to arrive dressed as a horizontal shift. Repeating the fit on the
difference after the local median is removed separates the two, because a real
planimetric offset survives detrending and a warp does not:

| window | east shift (95 % CI) | north shift (95 % CI) | R² |
|---|---|---|---|
| 9 m | +0.027 [−0.086, +0.150] | +0.125 [+0.019, +0.232] | 0.005 |
| 15 m | −0.037 [−0.244, +0.159] | +0.040 [−0.130, +0.199] | 0.0003 |
| 25 m | −0.003 [−0.217, +0.216] | −0.005 [−0.208, +0.162] | 0.000003 |
| 41 m | −0.018 [−0.275, +0.282] | −0.006 [−0.254, +0.212] | 0.00002 |

The metre-scale shift disappears.

What survives is a bound. No horizontal misregistration is resolvable above
about 0.25 m, and the slope correlation in the raw fit is the vertical field
showing through the terrain rather than planimetry. The disagreement between
these two flights is vertical.

## Controls

The same code, the same ground and the same rules, applied to two passes of a
single flight over the same cell:

| | cells | median separation | sd | NMAD |
|---|---|---|---|---|
| Flight B | 691 | 227 s | 0.280 | 0.229 |
| Flight B, gap 90 to 200 s | 25 | | 0.212 | 0.174 |
| Flight B, gap 200 to 400 s | 652 | | 0.267 | 0.228 |
| Flight A | 41 | 665 s | 0.826 | 0.325 |
| Flight A, gap 400 to 800 s | 26 | | 0.967 | 0.492 |

The control is not at the same separation as the comparison, and it grows with
separation: 0.174 m at 90 to 200 s, 0.228 m at 200 to 400 s, 0.492 m at 400 to
800 s. The two flights are 961.6 s apart, past the end of that range, so the
matched figure is the last row rather than the first. Against 0.492 m the two
flights disagree by roughly five times, not by the ten times a comparison
against the 227 s figure would suggest.

What the control does establish is that the machinery is not manufacturing the
difference, and that a gap of this size within one flight does not reach 2.36 m.
What separates the two cases is a second trajectory solution, which the
within-flight pairs do not have.

Four ways of turning points into a surface, over the identical 1,723 cells:

| estimator | mean | sd | RMS |
|---|---|---|---|
| PDAL `writers.gdal` radial mean | +1.365 | 2.105 | 2.508 |
| point-in-cell mean | +1.375 | 2.103 | 2.512 |
| point-in-cell plane at centre | +1.373 | 2.104 | 2.512 |
| 5th percentile of all returns, no ground filter | +1.298 | 2.106 | 2.473 |

Their standard deviations span 0.003 m. The last line owes nothing to SMRF, so
the ground filter is not the source of the result either.

Decoders were checked too. laspy's `Laszip` (C++ LASzip), `Lazrs` and
`LazrsParallel` (one Rust codebase, threaded two ways) return byte-identical
points, and PDAL's own reader agrees on counts and extrema to 6 × 10⁻¹¹ m.
`LazrsParallel` is laspy's default and shares its upstream with WhiteboxTools,
which is why WhiteboxTools was not used here as a second opinion on anything
downstream of a decode.

## Tools

PDAL 2.10.2 (crop, `filters.outlier`, `filters.smrf`, `writers.gdal`),
GDAL 3.13.3 (`gdal_translate`), laspy 2.7.0, numpy 2.4.6, scipy 1.17.1,
Python 3.11.15, darwin/arm64. Every invocation, with its exit code, stderr and
output digests, is in `reference-runs.json`; the six PDAL pipelines are in
`pipelines/`. No container was used, so the resolved executable paths and the
recorded command lines stand in for an image digest.

`filters.smrf` refuses a file whose `NumberOfReturns` is zero. The pipelines
assign `NumberOfReturns = ReturnNumber` first, which makes every return its own
last return. That invents nothing, because the file never recorded a pulse's
return count, so the effect is to use all returns. It is applied identically to
both flights.

## Files

| File | What it is |
|---|---|
| `results.json` | the distribution, the fits, the controls |
| `reference-runs.json` | every external command, versions, source digests |
| `comparable-cells.csv` | one row per compared cell: position, both elevations, both counts, both plane residuals, the gradient |
| `pipelines/*.json` | the PDAL pipelines, paths redacted to `<dataset>` and `<work>` |
| `../../../scripts/repeatability/measure-antiochia-repeatability.py` | produces all of the above from the two source clouds |

## What this does not say

It does not say either flight is right.

It does not transfer to another site, another sensor, another overlap geometry,
or to the interior of a swath rather than its edge. It is one pair of flights
over 1,723 square metres of one wooded hillside. The finding that travels
furthest is the shape of the disagreement rather than its size: a metre-scale
vertical field varying over hundreds of metres, under a decimetre of
short-range scatter, with no resolvable horizontal component.
