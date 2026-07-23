# Claims and limitations policy

This is the canonical reference for what OpenLiDARViewer publicly claims and
what it explicitly does not. Every other document — README, release notes,
validation reports, exported PDFs, the website — should reference these
definitions rather than restate them. One authoritative source is the
strongest protection against contradictory or overly broad claims appearing
as the project evolves.

The policy is version-controlled on purpose: a claim changes by changing this
file in a commit, with the evidence that justifies the change, and in no
other way.

## Vocabulary

The project uses these words with these meanings, and no others.

**Validated** — compared against a named reference under recorded conditions,
with the tolerance, fixture, and result written down. "The slope raster is
validated against GDAL 3.13.1 on the analytic fixture" is a complete claim;
"validated" without a reference is not a claim this project makes.

**Verified** — a fact the software established mechanically and records: a
checksum matched, a frame compatibility ladder was climbed, a gate exited 0.
Verification names its mechanism.

**Agreement** — the measured difference between this implementation and a
reference. The project reports agreement figures (maximum difference, RMSE)
rather than accuracy figures: agreement against a named reference is
checkable by anyone; accuracy is a claim about the world.

**Deterministic** — the same input on the same toolchain produces the same
output. This is a property the project tests for, not an accuracy statement.

**Numerically stable** — an implementation that does not lose precision to
its own arithmetic (origin-relative coordinates, Float64 transforms). Says
nothing about how well the data represents the ground.

**Evidence level (E0-E6)** — the ladder recorded in
`docs/validation/claim-register.yaml`. E3 is synthetic known-truth against our
own implementation; E4 is cross-implementation agreement with an independent
reference; E5 is field validation against ground truth. A claim's level is
machine-checked by `lint:claim-register` and changes only with new evidence.

## Words this project does not use as claims

**Accurate / accuracy** — never claimed. The word appears only when naming an
external standard ("ASPRS accuracy standards", NVA, VVA) or when stating what
is NOT claimed. Accuracy is nearly impossible to defend; agreement against a
named reference is what we publish.

**Survey-grade** — never claimed, anywhere, for anything. It appears only in
negations ("not survey-grade unless validated against ground-truth control"),
which every terrain export carries.

**Professional / certified / precise / exact** — not used as quality claims.
A report is "technical", a workflow is described by what it does, precision
is stated as a measured figure with units, and exactness is claimed only for
discrete properties a test pins (byte-identity, exact inverses).

**Marketing superlatives** — "best", "industry-leading", "most accurate",
"state-of-the-art", "world-class", "ultimate" — never, in any document.
`lint:claims-language` fails the gate if one appears.

## What the software currently claims

- One product is at E4: `SLOPE-RASTER` agrees with GDAL 3.13.1 and the
  closed-form gradient on the frozen analytic fixture within the
  preregistered 0.5° tolerance. This validates one algorithm on one fixture;
  it does not validate the point-cloud-to-DTM pipeline.
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
0.5° on the analytic fixture — see CLAIMS_AND_LIMITATIONS.md for what
'validated' means here") and link here for the definitions. Do not restate
the vocabulary; restatements drift.
