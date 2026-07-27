# Cross-platform scientific reproducibility

Status: **reproduced**

At commit 50e76d2, OpenLiDARViewer produced identical science-scoped artifacts from the same seeded fixture on darwin-arm64 and linux-x64. Build-scoped provenance and execution timing differed, as expected. Nothing is claimed for platforms not in that list.

## What was evaluated

| Field | Value |
| --- | --- |
| Platforms | darwin-arm64, linux-x64 |
| Commit | 50e76d22d405f716386dea50138e684fbe5a6911 |
| Release version | 0.6.1 |
| Lockfile sha256 | 60a48b52d87325ac5e6ab823b64fafa86d7aeccc7474733d066cd1358f50e559 |
| Fixture seed | 20260726 |
| Fixture points | 250000 requested, 250000 generated |
| Dataset | synthetic-250000-seed20260726 |
| Scalar tolerance | 0 |
| Byte order | darwin-arm64 LE, linux-x64 LE |

## The seeded fixture, compared first

The seeded source cloud is byte-identical on every platform, so any downstream difference would be a property of the analysis rather than of its input.

| Platform | Source cloud sha256 | Fixture descriptor sha256 |
| --- | --- | --- |
| darwin-arm64 | 4026c8c9c008fa0ed97ee61d43d9cc63451ea4b09a5c6951221da49d57237ee3 | 98e511999d36f75773d20d807700c785cb1e159e4fe1982b3f936639d44174f9 |
| linux-x64 | 4026c8c9c008fa0ed97ee61d43d9cc63451ea4b09a5c6951221da49d57237ee3 | 98e511999d36f75773d20d807700c785cb1e159e4fe1982b3f936639d44174f9 |

## Science-scoped outputs

15 artifact hashes and 18 scalar values were compared at a tolerance of exactly zero. 0 hashes and 0 scalars differ.

## Differences that are expected

Each one is published with the value every platform reported. None of them gates the result.

| Category | Field | Values | Why it may differ |
| --- | --- | --- | --- |
| host | os | darwin-arm64=darwin 25.4.0<br>linux-x64=linux 6.17.0-1020-azure | The operating system and its release are properties of the host, not of the analysis. |
| host | arch | darwin-arm64=arm64<br>linux-x64=x64 | The instruction set is a property of the host. Byte order is the part that must match, and it is checked as a precondition. |
| host | cpuModel | darwin-arm64=Apple M1 (Virtual)<br>linux-x64=AMD EPYC 9V74 80-Core Processor | The CPU model changes timing and nothing else; every science-scoped value is deterministic arithmetic. |
| host | logicalCpuCount | darwin-arm64=3<br>linux-x64=4 | Core count is a property of the runner. The pipeline is single-threaded here. |
| host | totalMemoryBytes | darwin-arm64=7516192768<br>linux-x64=16766423040 | Installed memory is a property of the runner. |
| host | loadAverage | darwin-arm64=10.88 11.31 11.32<br>linux-x64=0.97 0.27 0.09 | Host load at the moment of writing. It moves the timing column and nothing else. |
| timing | medianAnalysisMs | darwin-arm64=1305.1736865<br>linux-x64=1060.506257 | Execution time is a property of the machine. Reported per platform and never pooled. |
| timing | peakRssBytes | darwin-arm64=440418304<br>linux-x64=413757440 | Memory high-water observations track the allocator and the host, not the outputs. |

Excluded from the comparison by construction:

- timestamps: Run start and completion times are wall-clock readings. The framework strips them from every hashed artifact, and they are recorded in each platform manifest rather than compared.
- archive paths: Each platform writes into its own results directory and each CI runner has its own workspace root. Paths are relative in every manifest and are not part of any hash.
- build identity: The build identity string embeds the commit and the runtime that produced it. The scientific record and the processing manifest are seeded from it, which is why both are build-scoped and compared separately.

## Runtime, per platform

Runtimes are not pooled. A median over two machines describes neither of them, and the result this suite reports is output identity rather than which host is faster.

| Platform | Recorded runs | Median analysis | Analysis CV | Peak RSS |
| --- | --- | --- | --- | --- |
| darwin-arm64 | 10 | 1305.2 ms | 0.0532 | 420.0 MiB |
| linux-x64 | 10 | 1060.5 ms | 0.0527 | 394.6 MiB |

## Scope

This result covers darwin-arm64 and linux-x64 on the Node major version the workflow pins, at the commit above. It is not a claim of platform independence: untested platforms, other runtime versions and big-endian hosts are outside it. Windows is not covered.
