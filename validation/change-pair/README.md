# Co-UDlabs Chassieu flight pair: co-registration and controlled change

Two drone lidar flights over the Django Reinhardt stormwater infiltration tank in Chassieu, Lyon, 34 minutes
apart on 16 May 2023, with a documented set of solids laid on the tank floor between them. Co-UDlabs
(H2020 grant 101008626), WP6 Task 6.1, INSA Lyon. DOI 10.5281/zenodo.15175591, CC BY 4.0.

This directory records what the pair supports and what it does not. It moves nothing:
`docs/validation/claim-register.yaml` is untouched, no study manifest was written under
`validation/cross-implementation/studies/`, no evidence level changed, and none of OLV's acceptance
thresholds were run. Whether any of this becomes evidence is a separate decision.

## What the source document states about the placed solids

The narrative says flight #1 is the reference, and flight #2 followed after "some solids of various sizes and
shapes have been laid at various locations on the bottom of the tank, sometimes in an easily visible position,
sometimes partly hidden by or under the vegetation".

Table 1 lists them. **The table is a raster image inside the PDF with no text layer behind it.** `pdftotext
-layout` returns its caption and nothing else, so the dimensions are not machine-extractable from this file.
The values in `table1.json` were read off the rendered page and are labelled `read-from-rendered-page-image`.
No OCR engine was installed on this host to corroborate them, so they are a careful transcription rather than
extracted data. Anything downstream that depends on an exact dimension should go back to the PDF.

As transcribed: 22 item types, 62 individual items. The tallest stated item is a 50 cm construction cone
(4 placed). 18 items have a stated height of 15 cm or more. 10 items, the 5 bags of sand and the 5 buckets of
soil, have no stated dimensions at all, only "25 kg" against the sand. Several items are flat (wooden plank
1 cm, Plexiglas lid 1 cm) or open mesh that a lidar pulse passes through (iron cage, fine grid, wide grid).

**The document gives no coordinates and no placement map.** Nothing in the dataset says where any individual
item went, so there is no ground truth to score a detection against, only a population to compare a count with.

## Co-registration, which comes first

Both files carry EPSG:2154 (RGF93 v1 / Lambert-93) with EPSG:5720 (NGF-IGN69) heights and were produced by
DJI TERRA 3.11.13.0. GPS times put flight #1 at 13:12:50 to 13:18:13 UTC and flight #2 at 13:52:10 to
13:57:03 UTC, a gap of 34.0 minutes. `Classification` is 0 for every point in both files, so there are no
ground labels to inherit.

Stable ground was taken outside the tank: epoch-1 min-Z at or above 200.5 m, which is the embankment and the
surrounding hard standing, restricted to cells whose within-cell relief is at most 0.10 m in **both** epochs.
That is 231,839 cells, 2,318 m<sup>2</sup>.

| Quantity | Value |
|---|---|
| Vertical offset, median of the min-Z difference | **-0.0188 m** (epoch 2 lower) |
| Vertical offset, median of the mean-Z difference | -0.0210 m |
| Scatter about that offset, NMAD | 0.0326 m (min-Z), 0.0278 m (mean-Z) |
| Tilt, least-squares plane | 0.250 mm/m, +50.7 mm across the 205 m east-west extent, -11.6 mm across the 332 m north-south extent |
| Residual scatter after removing the plane, NMAD | 0.0250 m |
| Median offset per 25 m block (53 blocks) | -0.0505 m to +0.0208 m |
| Horizontal shift, minimising the difference NMAD over sub-cell shifts | east -0.017 m, north +0.025 m |
| Horizontal shift, Nuth and Kaeaeb on stable slopes of 5 to 45 degrees | amplitude 0.0093 m |

The bias and the scatter are reported separately on purpose. A single RMS over the stable ground would be
0.14 m and would be almost entirely tail, hiding both the 1.9 cm bias and the fact that the residual is not
uniform across the site.

**The two epochs are co-registered.** Horizontally the two independent estimators agree at about 1 to 3 cm,
which is a quarter of the analysis cell and well inside the sensor's stated 10 cm horizontal system accuracy.
Vertically there is a systematic offset of 1.9 to 2.1 cm, inside the stated 5 cm vertical accuracy, plus a
spatially varying component: a 0.25 mm/m tilt, and a block-to-block spread of about 7 cm peak to peak that the
plane does not absorb. Every change number below is quoted after subtracting that fitted plane.

Both components sit inside the sensor's own published system accuracy for this flying height, which is the
relevant yardstick here. No comparison against any other epoch pair in this repository is made, because none
was measured in this work.

## Cell size

Measured, not habitual. The two files hold 48,360,428 and 47,893,585 points. Occupied 5 cm bins give a covered
area of 34,187 m<sup>2</sup> and 34,185 m<sup>2</sup>, so the density is **1,415 and 1,401 points/m<sup>2</sup>**.

| Cell | Cells with data in both epochs | Median points/cell | Fraction with 4 or more points in both |
|---|---|---|---|
| 0.05 m | 12,037,268 | 3 | 0.279 |
| **0.10 m** | **3,935,602** | **11** | **0.796** |
| 0.20 m | 1,039,432 | 45 | 0.961 |
| 0.50 m | 170,840 | 282 | 0.985 |

0.10 m is the smallest cell that still carries a double-figure sample per epoch. It is also the largest cell
that can resolve the documented items, whose plan dimensions run from 6 cm to 1.23 m and are mostly between
0.2 and 0.5 m. 0.05 m would put a median of 3 points in a cell, which is too few for a per-cell extremum;
0.20 m would smear a 0.2 m object across a single cell. Cells with fewer than 4 points in either epoch are
dropped.

## Change inside the tank

The tank floor is epoch-1 min-Z below 198 m. That area is 19,472 m<sup>2</sup>, against the document's stated
bottom area of "approx. 2.1 ha", which is an independent check that the mask is the right feature.

### What was excluded and what it cost

| Exclusion | Cost |
|---|---|
| Fewer than 4 points in either epoch | 2,636 m<sup>2</sup>, 13.5% of the tank floor |
| Vegetation, via epoch-1 relief over a 0.5 m window above 0.35 m | a further 8,989 m<sup>2</sup> |
| Remaining searchable floor | **7,846 m<sup>2</sup>, 40.3% of the tank floor** |

Vegetation is the binding constraint, and the epoch-1 relief threshold is the honest way to state it. The
scatter of the surface difference scales directly with how vegetated the reference epoch was:

| Epoch-1 relief over 0.5 m | Area | NMAD of the difference | 5 x NMAD |
|---|---|---|---|
| 0 to 0.15 m | 1,089 m<sup>2</sup> | 0.017 m | 0.08 m |
| 0.15 to 0.25 m | 4,002 m<sup>2</sup> | 0.021 m | 0.10 m |
| 0.25 to 0.35 m | 2,755 m<sup>2</sup> | 0.029 m | 0.15 m |
| 0.35 to 0.50 m | 2,901 m<sup>2</sup> | 0.037 m | 0.18 m |
| 0.50 to 1.0 m | 2,454 m<sup>2</sup> | 0.068 m | 0.34 m |
| 1.0 to 3.0 m | 1,916 m<sup>2</sup> | 0.133 m | 0.67 m |
| above 3.0 m | 1,718 m<sup>2</sup> | 0.244 m | 1.22 m |

Over the 3,634 m<sup>2</sup> of floor carrying more than 1 m of epoch-1 relief, the difference between two
flights 34 minutes apart has an NMAD of 0.13 to 0.24 m and a long tail reaching several metres. That is the
lidar reaching the ground under a bush on one pass and not the other. No 20 cm object is recoverable there,
and the tank floor is described in the source document as progressively vegetated.

The other exclusion is a wet drainage channel. Cells with epoch-1 min-Z between 193.8 and 194.2 m form a
narrow dendritic feature on the north part of the floor where the difference is several times more likely to
exceed 0.10 m than on the surrounding floor, and almost always downward, which is not a physical surface
change. It is 548 m<sup>2</sup> of the searchable floor. It was not masked out; it is left in and it is the main reason the
falling-direction count below is as high as it is.

### Detector, and its own false-positive measure

Solids can only add material, so the same detector run in the falling direction measures its own false
positives. Both directions run over the tank and, separately, over the stable ground outside it.

Stage 1 works on the per-cell max-Z difference at 0.10 m after subtracting the stable-ground plane: connected
components above +0.10 m, 4 to 200 cells, at least 45% fill of their bounding box, aspect ratio at most 4:1,
epoch-1 relief at most 0.60 m, and a quiet 3-cell surround (90th percentile of the absolute difference below
0.15 m).

Stage 2 re-tests every candidate against the raw points, with no raster in the path. A ground plane is fitted
robustly to the points in a 0.60 to 1.35 m annulus in each epoch, and the returns inside a 0.55 m core are
counted above 0.15 m. A candidate passes only if the before-epoch has 10 or fewer such returns, the
after-epoch has 60 or more, the peak stands at least 0.18 m above local ground, and both ground-plane fits
have an RMS at or below 0.06 m.

| Direction and area | Stage-1 candidates | Point-verified | Passing |
|---|---|---|---|
| Tank, rising | 139 | 134 | **3** |
| Tank, falling (physically impossible) | 425 | 414 | **1** |
| Outside the tank, rising | 8 | 8 | 1 |
| Outside the tank, falling | 34 | 34 | 4 |

Stage 1 alone is useless: 425 falling candidates against 139 rising. Stage 2 is what carries the result, and
it still leaves one impossible in-tank fall standing against three rises.

### The three detections

| East | North | Returns above 0.15 m, epoch 1 | epoch 2 | Peak above local ground | Footprint | Volume |
|---|---|---|---|---|---|---|
| 852222.75 | 6517048.50 | **0** | 193 | 0.256 m | 0.135 m<sup>2</sup>, 0.40 x 0.50 m | 0.0207 m<sup>3</sup> |
| 852224.60 | 6517049.85 | **0** | 223 | 0.410 m | 0.170 m<sup>2</sup>, 0.45 x 0.60 m | 0.0357 m<sup>3</sup> |
| 852222.35 | 6517052.00 | **0** | 72 | 0.197 m | 0.135 m<sup>2</sup>, 0.60 x 0.35 m | 0.0125 m<sup>3</sup> |

Zero returns above 0.15 m in the reference epoch against 72 to 223 in the second, over ground whose plane fits
to 0.025 to 0.044 m RMS. Volumes are integrated over the epoch-1 ground plane, so they are the volume standing
proud of the floor, not a displacement. **0.069 m<sup>3</sup> in total.**

PDAL reproduces all three from its own rasteriser. `writers.gdal output_type=max` at 0.10 m over the same
window, differenced and dumped through `gdal_translate -of XYZ`, gives peak rises of 0.193, 0.306 and 0.111 m
before the 0.019 m offset correction, which lands within 0.02 m of the values above once the offset is added.
See `pdal-crosscheck.json`.

All three sit inside one 3 x 4 m patch. That is not a site-wide recovery of the placed set; it is one cluster.

## Does it match the documentation

Partly, and the honest answer is mostly no.

Consistent: three compact objects appear on the tank floor between the two flights and none disappears in the
same neighbourhood. Their heights, 0.20 to 0.41 m, and footprints, 0.35 to 0.60 m across, sit inside the range
Table 1 describes. A 0.41 m peak is consistent with a 50 cm construction cone, whose tip is undersampled; a
0.26 m peak is consistent with the 24 cm jerrican or a 23 cm iron cage; a 0.20 m peak is consistent with a
19 cm brick block, a 19.5 cm jar or a 19.6 cm concrete test tube. No single assignment can be made, because
the document gives no locations.

Not consistent: **3 of 62 placed items were recovered, and 3 of the 18 whose stated height clears the
detection threshold.** At the same settings the detector also returned one in-tank fall that cannot be a laid
solid, so even the three cannot be asserted individually at better than roughly 3:1 against the method's own
false-positive rate. Most of the placed set was never recoverable by surface differencing: 10 items have no
stated dimensions, several are flat to within a centimetre or are open mesh, 20 of the 62 are 6 cm plastic
balls, and the pipes and drains are 10 cm cylinders that never fill a 0.10 m cell.

## What this pair does and does not support

It supports a co-registration statement. Two flights, one sensor, one processing chain, 34 minutes apart,
aligned to 1 to 3 cm horizontally and 1.9 to 2.1 cm vertically with a 0.25 mm/m tilt and a 7 cm block-to-block
spread. Those numbers are measured on 2,318 m<sup>2</sup> of stable ground outside the changed area, and they
are the kind of number a change product needs behind it.

It does not support a change-detection demonstration at the scale the source document implies. The controlled
change is real and deliberate, but it is small relative to what a 1,400 points/m<sup>2</sup> survey can
resolve through the vegetation actually present on this floor, and the source document supplies no placement
map to score against. A tank-wide change volume is not defensible from this pair: 60% of the floor is not
searchable, the recovered set is 3 items in one 3 x 4 m patch, and the falling-direction control does not go
to zero.

The clean result here is the co-registration. The change measurement is a negative result, and it is more
useful stated as one than stretched into a positive.

## Files

- `scripts/run-change-pair.py` reads the two LAS files and writes `coregistration.json` and `detections.json`.
- `pdal/dsm-epoch1.json`, `pdal/dsm-epoch2.json` are the PDAL pipelines, with `DATASET_DIR` and `OUTPUT_DIR`
  placeholders substituted at run time so no committed file names the host.
- `pdal-crosscheck.json` holds the PDAL result at the three detections.
- `table1.json` is the transcription of the source table, with its provenance marked.
- `reference-runs.json` records every tool version, resolved path, command and output digest.
