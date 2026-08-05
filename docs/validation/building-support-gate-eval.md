# Building ground-support gate evaluation

This note records a synthetic check of the building ground-support gate added in
PR #277 (`buildingMinSupport`, default 0.66) in
`src/render/class/deriveClassification.ts`.

## Method

The check builds one labeled synthetic corpus and runs `deriveClassification`
twice on the same points, changing only `buildingMinSupport`:

- before #277: `buildingMinSupport = 0` (gate disabled)
- after #277: `buildingMinSupport = 0.66` (default)

Both runs use `cellSizeM = 1.0` so the grid is fully controlled. Every point
carries a ground-truth `isBuilding` label. The corpus has four categories:

1. Real buildings (truth = building): flat, planar, non-green, single-return
   roof patches at z = 5, each embedded in a solid measured ground lattice at
   about 0.4 m spacing. Every nearby cell is measured, so support reads 1.0.
2. Scan-edge artifact roofs (truth = non-building): thin roof columns one cell
   wide, each holding real ground (z = 0) under a flat roof (z = 5). The
   neighboring cell columns are empty void, so the roof points' bilinear
   footprint reaches two measured and two unmeasured corners and support reads
   0.5 exactly.
3. Vegetation controls (truth = non-building): tall patches that are green
   (excess-green at or above 0.06) and multi-return (returnCount = 2).
4. Ground controls (truth = non-building): flat points near z = 0.

Colors (RGB), return number, and return count are provided for all points in
the same order as positions. A point is scored as a predicted building when its
output code equals `DERIVED_BUILDING` (6).

## Results

BUILDING-class confusion against ground truth:

| setting | TP | FP | FN | TN | precision | recall | F1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before (buildingMinSupport 0) | 2646 | 480 | 0 | 13451 | 0.846 | 1.000 | 0.917 |
| after (buildingMinSupport 0.66) | 2646 | 0 | 0 | 13931 | 1.000 | 1.000 | 1.000 |

Per-category points classified BUILDING (before then after):

| category | before | after | total points |
| --- | --- | --- | --- |
| real | 2646 | 2646 | 2646 |
| artifact | 480 | 0 | 528 |
| veg | 0 | 0 | 1764 |
| ground | 0 | 0 | 11639 |

The gate flips 480 of 528 artifact roof points from BUILDING to UNCLASSIFIED
(90.9%). The remaining artifact points sit at strip ends and never classify as
building under either setting. Real-building recall stays at 1.000. Precision
rises from 0.846 to 1.000 and F1 rises from 0.917 to 1.000. Vegetation and
ground controls never classify as building under either setting.

The mechanism is visible in the numbers: the gate removes low-support roofs
(support 0.5) while keeping high-support roofs (support 1.0), so it drops the
false positives and preserves the real buildings.

## What this does and does not establish

This is a synthetic corpus with hand-placed geometry, not a field survey. It
demonstrates the gate's precision and recall tradeoff on controlled scan-edge
voids where the ground support is exactly 0.5. It shows that on these scenes the
gate removes low-support roof false positives without dropping real buildings
whose ground is fully measured. It does not measure behavior on real airborne or
photogrammetric point clouds, on mixed support values, or on scenes where a real
building sits at a genuine coverage edge with support at 0.5. Those cases would
lose real-building recall and are not covered here. The result supports the
change on the failure mode it targets and does not generalize beyond it.

## Reproduce

```
npx tsx scripts/eval-building-gate.ts
```
