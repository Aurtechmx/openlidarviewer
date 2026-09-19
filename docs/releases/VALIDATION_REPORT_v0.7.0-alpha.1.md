# Validation report: OpenLiDARViewer v0.7.0-alpha.1

**In development. Not release-authoritative.** Test figures, browser matrix and
packaging digests are recorded here at freeze, from the gate that runs against
the tagged tree. They are deliberately absent rather than provisional, so that
nothing in this file can be read as a result that has not been produced.

## Baseline

v0.7.0-alpha.1 develops from v0.6.9, tag `v0.6.9`, commit
`c164e907f50ff49da7233385d92285c53dfb3b8d`. The v0.6.9 evidence record is
unchanged and remains the authority for that release.

## What has been validated so far

ASPRS class semantics and the classification flag layouts were verified against
the ASPRS LAS Specification 1.4 R15, Tables 8, 9, 16 and 17, rather than against
restated wording. That check corrected four legacy class labels and one defect
in the semantics module itself.

Classification flags round-trip through both writers: a record is written,
decoded and compared, covering every extended flag combination.

## Evidence levels

Unchanged from v0.6.9. Standards corrections do not promote a claim, and no
numerical method has changed in this cycle.
