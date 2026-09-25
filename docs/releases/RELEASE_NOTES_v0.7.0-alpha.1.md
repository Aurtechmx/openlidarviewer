# Release notes: OpenLiDARViewer v0.7.0-alpha.1

This is a development cut on the way to v0.7.0. It carries no DOI, and its
test figures are not release-authoritative. The figures and claims for v0.7.0
are written at that freeze, from the gate that runs against the tagged tree.

v0.7.0 continues from v0.6.9 (`c164e907f50ff49da7233385d92285c53dfb3b8d`). The
published v0.6.9 documents and evidence are unchanged and stay that way.

## What has landed so far

ASPRS class semantics now come from one module rather than from a table in each
of eight places. Names are keyed by the point data record format, so class 12 is
Overlap Points under formats 0 to 5 and reserved from format 6, where overlap is
a flag instead. Codes 19 to 22 are named, 23 to 63 are reserved and only 64 and
above are user definable. The tables that disagreed with each other are gone.

Classification flags survive a load. The decoder reads Synthetic, Key-Point,
Withheld and Overlap from both record layouts, the point model carries them, and
both writers keep them. The legacy write no longer masks the classification byte
with `0x1f`, which had been erasing all three legacy flags on export. A clip
carries the flags with the points it keeps.

The disposal contract document is now enforced: a resource documented without an
owner or a disposal trigger fails a lint.

## Open work

The implementation ledger in `V070_IMPLEMENTATION_LEDGER.md` carries the open
items and their status. An item is complete when that ledger says so and names
the test that proves it.

## License

Unchanged from v0.6.9: OpenLiDARViewer is distributed under AGPL-3.0-only.
Releases through v0.6.6 were published under MIT and stay available under those
terms. The license of a bundled dependency or of any test or validation dataset
is unaffected.
