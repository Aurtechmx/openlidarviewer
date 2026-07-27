# Cross-platform scientific reproducibility

Whether the same seeded input produces the same scientific output on a second
machine of a different architecture. The suite that answers it has two halves: a
recorder that runs on one platform and signs a leg, and a comparator that reads
every leg and checks the source-cloud hash first, then every science-scoped hash
and scalar at zero tolerance.

Run it with `npm run benchmark:repro:portable` on each platform, then
`npm run benchmark:compare-platforms` over the collected legs. Byte order is
checked as a precondition rather than reported as a result. The CI workflow
`benchmark-portability.yml` does both across a matrix of linux-x64 (ubuntu) and
darwin-arm64 (macOS), with `fail-fast` off: a leg that dies would otherwise
leave the comparator with one platform, which reports as single-platform and
establishes nothing while still looking green.

## Current state: single-platform

The only run recorded in this tree is one darwin-arm64 leg. The comparator
reports `status: single-platform` and `claimEstablished: false`.

**Cross-platform reproducibility is therefore not established.** What the run
does establish is seeded reproducibility on one platform: 15 science-scoped
artifact hashes and 18 scalar values identical across ten recorded runs at zero
tolerance, with the processing manifest verifying each time.

| Field | Value |
|---|---|
| Platforms recorded | darwin-arm64 |
| Fixture | synthetic-250000-seed20260726, 250,000 points |
| Scalar tolerance | 0 |
| Science-scoped hashes | 15 recorded, 0 compared |
| Science-scoped scalars | 18 recorded, 0 compared |
| Byte order | LE (precondition, not a result) |

The darwin-arm64 source-cloud hash is published as the reference a second
platform will be checked against, rather than as a comparison that succeeded.

## What the comparator excludes, and why

Three fields are outside the comparison by construction rather than by
tolerance. Timestamps are wall-clock readings, stripped from every hashed
artifact and recorded per platform. Archive paths are relative in every manifest
and belong to no hash, because each runner has its own workspace root. Build
identity embeds the commit and the runtime that produced it, which is why the
scientific record and the processing manifest are seeded from it and compared
separately from the science.

Runtimes are reported per platform and never pooled. A median over two machines
describes neither of them, and what this suite measures is output identity
rather than which host is faster.

## Scope

A result here covers the platforms in the matrix, on the Node major version the
workflow pins, at the commit recorded in the comparison. Untested platforms,
other runtime versions and big-endian hosts are outside it. Windows is not
covered.
