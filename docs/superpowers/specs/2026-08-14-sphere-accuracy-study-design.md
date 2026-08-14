# SP2 — Sphere absolute-accuracy study

Date: 2026-08-14
Status: design, awaiting review
Part of: v0.6.6 scanner-comparison evidence program (SP2 of SP1–SP4). Depends on SP1 (EPSG:5514 resolves, native-metre measurement).

## Purpose

Produce **real-data evidence** for OLV's distance/measurement engine, validated against surveyed ground truth, per instrument. The dataset (Zenodo 10.5281/zenodo.15421291) ships 16 "Koule" reference spheres with mm-accurate surveyed EPSG:5514 coordinates — a known distance network. This lets us test what OLV actually computes against a real field survey, not a synthetic fixture, and characterise each scanner (TLS, ZEB, LA03, iPhone) at the same time.

Frame: all measurement is done in **native EPSG:5514 metres** (Krovák is conformal, ~unit scale), so the datum-shift residual from SP1's WGS84 leg never enters distances.

Out of scope: SP3 (DBH), SP4 (terrain); automated in-app sphere detection (a reference-tool step here); any claim beyond N=1 site.

## Evidence question

Two distinct things the spheres let us measure:

- **Engine correctness** — given exact coordinates, does OLV's measurement engine compute the correct inter-sphere distances under a real non-UTM CRS with negative coordinates? (Validates the CRS → unit → measurement chain end to end.)
- **Instrument-plus-OLV fidelity** — from each scanner's *actual points*, recover the sphere centres, measure the inter-sphere distances OLV reports between them, and compare to the surveyed network. (Measures OLV's distance on real, noisy field geometry and characterises each instrument.)

## Design — two layers

### Layer A — Engine correctness on surveyed coordinates (reproducible gate)

Feed pairs of surveyed sphere coordinates through OLV's shared measurement engine (the same `MeasurementEvaluation` the app uses) under a resolved EPSG:5514 context. Assert the computed inter-sphere distances match the surveyed reference distances to sub-millimetre. This pins the whole chain — CRS resolution, metre-unit handling, distance math — on real Krovák coordinates. Committed as a unit/validation test with the sphere network as a small CSV oracle (surveyed coordinates only; no cloud).

Value: modest but real — it catches any CRS/unit regression that would corrupt measurement on a non-UTM negative-coordinate frame. Fast, fully automatable.

### Layer B — Instrument fidelity (the headline evidence)

For each scanner, per surveyed sphere:

1. **Detect the sphere centre** from the scanner's actual points near the surveyed location — a RANSAC sphere fit (fixed known radius) in a reference tool (PDAL/Python, the cross-implementation reference), NOT OLV. Output: a detected centre per sphere per instrument, with a fit residual.
2. **Measure** the inter-sphere distances between detected centres through OLV's engine (Layer A path), per instrument.
3. **Compare** to the surveyed network → per-instrument distance error distribution (RMSE, max), plus a cross-instrument table (expected: TLS ≈ mm, ZEB/LA03 cm, iPhone larger).

Value: this is real-field measurement evidence. It validates OLV's distance on noisy real geometry and produces the cross-instrument accuracy story. It is honest about the division of labour: sphere *detection* is a reference-tool step; OLV owns the *measurement* between detected points.

Evidence claim: OLV distance measurement, checked against a surveyed reference network on real multi-instrument field data → promotes the measurement claim from E3 (synthetic known-truth) toward **E4/E5** (real cross-implementation / field), scoped N=1 site.

## Staging (recommended)

1. Layer A first — quick, pins the chain, needs no cloud processing.
2. Layer B on the small clouds first — iPhone (2.2M) and LA03 (31M) — to prove the detection→measure→compare pipeline end to end.
3. Layer B on ZEB (141M) and TLS (345M, 4.5 GB) — the reference and the densest MLS. TLS is the accuracy anchor.

## Data & reproducibility

Clouds never committed (4.5 GB TLS etc.). The validation study stores: the surveyed sphere network (CSV, from GroundTruth), the per-instrument detected centres + fit residuals, the reference-tool commands + versions (PDAL/Python), the comparison tables, and a manifest citing the Zenodo DOI + md5s. Fits under `validation/` alongside the existing field/cross-implementation studies.

## Success criteria

1. Layer A: OLV distances match the surveyed network to sub-mm under EPSG:5514 (committed gate).
2. Layer B: a per-instrument distance-error table vs the surveyed network, for at least iPhone + LA03 + one of ZEB/TLS, with the reference-tool detection pinned and reproducible.
3. Honest scoping recorded: sphere detection is a reference-tool step; N=1 site; the claim is about measurement between given points, not about OLV detecting spheres.
4. Claim-register updated only if Layer B genuinely supports an E-level move; otherwise recorded as below-grade real-field evidence.

## Risks / open questions

- Sphere radius / fit convergence on the sparse iPhone cloud — a sphere with few returns may not fit cleanly; record detection failures rather than forcing a centre.
- Whether the surveyed spheres are actually present in each scan's extent (iPhone's small footprint contains only ~3 spheres) — the per-instrument sphere set will differ; the comparison is per available sphere, not a fixed set.
- Whether this warrants an E-level promotion or stays "real-field supporting evidence" — decide from the Layer B result, not in advance (scientific-critical-thinking: let the evidence set the grade).

## Methodology decision for review

- **Option A (Layer A only):** fast, modest — validates the measurement chain on real Krovák coordinates. No cloud processing.
- **Option B (Layer A + B):** the real cross-instrument field evidence; needs RANSAC sphere detection on the actual clouds. Recommended, staged (small clouds first).
