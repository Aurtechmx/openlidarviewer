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

## Current state: reproduced on two platforms

The tracked result is `docs/validation/evidence/portability-v0.6.2/`, copied from
workflow run 30221805663. The comparator reports `status: reproduced` and
`claimEstablished: true` for darwin-arm64 and linux-x64 at commit 50e76d2.

The two legs produced identical science-scoped output from the same seeded
fixture. 15 artifact hashes and 18 scalar values were compared at a tolerance of
exactly zero; none differ. The source cloud hashed the same on both platforms, so
a downstream difference would have been a property of the analysis rather than of
its input.

| Field | Value |
|---|---|
| Platforms compared | darwin-arm64, linux-x64 |
| Commit | 50e76d2 |
| Fixture | synthetic-250000-seed20260726, 250,000 points |
| Scalar tolerance | 0 |
| Science-scoped hashes | 15 compared, 0 differing |
| Science-scoped scalars | 18 compared, 0 differing |
| Byte order | LE on both (precondition, not a result) |

Host fields, execution timing and build identity differ between the legs and are
published with the value each platform reported.

`benchmark-results/` is untracked, so running the suite locally on one machine
produces one leg and reports `single-platform` with `claimEstablished: false`.
That is the correct verdict for one leg, and it is not the verdict the tracked
evidence carries.

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
covered. The tracked result covers two little-endian platforms, one commit and
one synthetic seeded fixture. Real scan data is not part of it, and neither is
any claim of platform independence beyond the two legs that ran.
