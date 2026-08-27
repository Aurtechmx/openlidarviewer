# Heavy clouds: the native out-of-core pipeline

Plain LAS/LAZ files today are read whole — one `File.arrayBuffer()`, one
sequential decode, one full-size attribute allocation — and only then reduced
to the render budget. That shape has three ceilings, in the order a growing
file hits them: the browser's single-`ArrayBuffer` cap (~2 GB), the duplicate
compressed copy inside the laz-perf WASM heap, and decoded attribute arrays
sized to the source count (~30 B/point) before any budget applies. COPC and
EPT avoid all three because they stream through the octree scheduler; a plain
LAS/LAZ has no index, so it never could — until it is given one.

This document is the program of record for the native pipeline that removes
those ceilings. Every component in it is first-party OLV code: the readers,
the chunk-table decoder, the indexer, the tile store, and the source that
feeds the existing streaming engine. The only third-party piece anywhere in
the path is the already-bundled laz-perf WASM, used exactly as COPC already
uses it — one independent chunk at a time.

## Components

```
File (LAS/LAZ, any size)
  │  RangeSource reads only — never a whole-file buffer
  ▼
Chunked readers                       src/io/heavy/
  ├─ slicedLasReader   uncompressed LAS: fixed-size records, sliced batches
  └─ lazChunkTable     LAZ: native chunk-table decode → independent chunks
  │        each chunk decodes in parallel across a worker pool
  ▼
OlvOocIndexer                         (phase 1)
  │  two-pass octree bucketing, spilling node buffers to OPFS
  ▼
OLV Tile Store                        (phase 2)
  │  manifest + plaintext hierarchy + per-node tiles, in OPFS
  ▼
OlvTileSource                         (phase 3)
  │  a RangeSource-backed peer of CopcSource / EPT
  ▼
Existing streaming engine             (unchanged)
     view-dependent scheduler · hierarchy-aware eviction ·
     bounded residency (1.5 × pointBudget) · worker decode · WebGPU/WebGL2
```

The engine below the dashed line is the same one that already streams COPC and
EPT, including at the 1-billion-point synthetic stress tier. The program adds
the half that plain files were missing: an index, and readers that never need
the whole file at once.

## The chunk table is the speed structure, not just the size structure

A LAZ file's points are compressed in independent chunks (fixed point count,
or variable for layered PDRF 6+ files), and the file carries a table of chunk
byte ranges. Whole-file decoders ignore it and run one arithmetic-coder state
across the entire stream — strictly sequential, one core, no matter how many
the machine has. Reading the table restores random access, and with it:

- **Parallel decode.** Each chunk is an independent decode unit. A pool of
  `navigator.hardwareConcurrency` workers decodes chunks concurrently through
  the same per-chunk laz-perf path COPC nodes already use
  (`copcChunkDecompress.decompressChunk`), with decoded buffers transferred,
  never copied. Decode throughput scales with cores until memory bandwidth
  binds, where a sequential decoder is pinned to one core by construction.
- **Bounded memory.** One chunk's compressed bytes in the WASM heap at a time
  per worker, instead of the whole file.
- **Progressive first paint.** Chunks decode in priority order, so early
  batches reach the GPU while the tail is still decompressing.

The table itself is arithmetic-coded (the laszip integer-compressor scheme),
so random access requires decoding it. `src/io/heavy/` carries a native
TypeScript implementation of that decoder — models, symbol decode, and the
integer-corrector path — scoped to the chunk table. It ships with a mirror
encoder used by the round-trip test suite, and its output is checked against
hard invariants on every real file: monotonic chunk offsets, ranges inside the
file, the last chunk ending exactly at the table, and counts consistent with
the header. A file that fails any of these falls back to the legacy whole-file
path rather than trusting a suspect table — the native fast path fails closed
into the proven slow path, and the failure is recorded in load telemetry.

Pointwise-compressed LAZ (compressor 1, written by pre-2011 tools) has no
chunk table; those files take the legacy path. Files whose chunk-table offset
is the `-1` sentinel (an interrupted writer) do the same.

## Performance target

The load-speed goal for chunked LAZ on a multi-core device is to decode faster
than any available loader for the same file, measured, never asserted. The
apparatus is the `loaderComparison` suite (`npm run benchmark:loaders`,
`benchmarks/runner/loaderComparison.ts`), which lands a hashed, host-stamped,
`benchmark:verify`-checked result tree next to the reproducibility and scaling
suites; it times OLV's `loadLas` against loaders.gl's LASLoader on identical,
in-repo-generated LAS files, and `lazDecodeBaseline.test.ts` times OLV's own
single-thread decode. What they report on an M-series machine:

- On the common ground both loaders accept (LAS <= 1.3, point formats 0-5) OLV
  is a touch faster: 1.41x loaders.gl on the suite's attribute-rich 1M
  point-format-3 file. OLV decodes full-precision local coordinates plus
  intensity, classification, returns, GPS time and RGB in that time, where
  loaders.gl returns a float32 global position, so the ratio understates the
  difference in work done; a near-tie would still be OLV moving more per point.
- loaders.gl cannot read LAS 1.4 / point formats 6-8 at all ("Only file versions
  <= 1.3 are supported"). That is the format modern airborne LiDAR and COPC ship
  in, and the format chunk-parallel decode targets, so there is no web-loader
  head-to-head to run on it.

The multiplier therefore lives against OLV's own single-thread baseline, the only
decoder that reads those files. Chunk-parallel decode of an 8M-point LAS 1.4 file
ran 3.2x that baseline on four workers (2780 ms to 864 ms), near the Amdahl
ceiling for a 92%-parallel decode. That figure is a browser measurement: the
decode pool builds real module workers, which the Node benchmark harness cannot
host, so it is reproducible from the drop path rather than archived with the
loader suite's per-run statistics. Chunk-parallel decode scales with cores; a
single laz-perf reader does not, and sliced reads let decode start before I/O
finishes.

For uncompressed LAS the picture is different again: decode is a near-memcpy and
every loader is I/O-bound, so the differentiator is bounded memory and
progressive paint, not a large multiplier. The benchmark reports both formats
separately so neither borrows the other's number.

## Phases

| Phase | Scope | Gate |
|-------|-------|------|
| 0 | `src/io/heavy/`: native arithmetic decoder (chunk-table subset), LAZ chunk-table parser, sliced LAS batch reader — all over `RangeSource`, all Node-testable | Round-trip + parity + fail-closed tests green; conformance run against real laszip-written files before the fast path defaults on |
| 1 | `OlvOocIndexer`: two-pass out-of-core octree build (bounds+histogram pass, bucketing pass), node buffers spilled to OPFS | Node counts sum to source count; every point inside its node cube; bounded peak RAM on a synthetic > 2 GB fixture |
| 2 | OLV Tile Store: OPFS layout — manifest, plaintext hierarchy, per-node tiles in the store's own binary framing | Store round-trips through its own reader; hierarchy parses without touching tiles |
| 3 | `OlvTileSource` + OPFS-directory `RangeSource`; `loadPlan` routes over-ceiling plain files to build-then-stream | E2E: multi-GB plain LAS streams with residency ≤ 1.5 × pointBudget and no whole-file read on the heavy path |
| 4 (optional) | Compaction: a LAZ encoder enabling single-file `.copc.laz` output from the Tile Store | Gated on a security review of any new WASM; the Tile Store remains the default |

## Status

Phases 0 through 3 are built as libraries and covered by tests that run in
Node against a memory spill store: the chunk readers, the indexer, the tile
store and its parsers, the tile decoder, `buildTileStoreFromLas`, and
`OlvTileSource`. `loadPlan` sets `buildThenStream` for an uncompressed LAS
whose whole-file buffer would exceed the memory ceiling.

The browser half of phase 3 is now wired for uncompressed LAS.
`src/app/openScan.ts` calls `openLocalHeavyLas`, which reads only the header
first, acts on the plan's `buildThenStream` verdict, runs `storagePreflight`,
and dispatches the index to `localOocIndexerWorker`. The worker wraps the
`File` in a `LocalFileRangeSource`, opens an OPFS spill build, runs
`buildTileStoreFromLas`, and posts back the manifest and hierarchy. The main
thread reopens the promoted store from OPFS, constructs an `OlvTileSource`, and
hands it to `Viewer.attachStreamingCloud` with the shared streaming-scan reveal
(`streamingScanReveal.ts`). Heaviness is decided first, from the header peek and
the plan, independently of capability. A file the plan does NOT route out of core
returns `not-heavy` and the whole-file loader takes it unchanged. But once a file
is confirmed heavy, the whole-file loader is not a safe fallback: its single
`new Uint8Array(total)` is the allocation that made the file heavy. So a heavy
file whose out-of-core path cannot complete — OPFS or workers absent, the
preflight refuses, or the build fails before commit — returns a `heavy: true`
status and the open REFUSES with a named reason that points at COPC/EPT, rather
than falling through into an out-of-memory crash. Only `attached` and `cancelled`
are terminal otherwise. A Node test drives the whole decision
and dispatch against a fake OPFS and an in-process build. It asserts the largest
single read is a bounded batch far smaller than the file and that the streamed
cloud reports the source point count.

What remains is compressed LAZ, which stays on the strided whole-file path until
the chunked-LAZ builder is wired, plus preview-first rendering before the index
finishes, cross-session cache reuse, and the multi-GB browser evidence for the
phase-3 gate. The worker message boundary and the real OPFS and real streaming
attach run only in the browser. The Node coverage stops at the fake seams.

Phase 0 is independently shippable: chunk-parallel decode alone improves
today's in-memory loads (every chunk still decodes, but on all cores), and the
sliced LAS reader removes the 2 GB wall for stride viewing before the indexer
exists.

## Constraints carried from the rest of the codebase

- **Monolith ratchet.** No phase grows `main.ts` or `Viewer.ts`; wiring goes
  through the existing delegation seams (`openScan.ts`, `loadPlan.ts`).
- **Position-frame discipline.** New decoded buffers are origin-relative
  (source-local frame), produced through the existing `decodeRecord` path;
  any new direct position read is classified in
  `docs/validation/position-frames.json`.
- **Worker registry.** The chunk-decode pool registers its workers like every
  other worker in `workerRegistry.ts`.
- **Fail-closed loading.** Malformed tables, impossible counts, and truncated
  chunks surface as `LoadError('malformed-file')` or fall back to the legacy
  path; the heavy path never guesses.

## Risks and their handling

- **OPFS footprint** (phase 1–2): uncompressed tiles cost ~30 B/point on
  disk — a 500 M-point cloud needs ~15 GB free. The indexer checks available
  quota before starting and reports the requirement; phase 4 compaction is the
  long-term answer.
- **Two-pass build time** (phase 1): the indexer reads the file twice; for
  LAZ that is two decompression passes, though both are chunk-parallel. The
  build shows progress and cancels cleanly. Its OPFS store is temporary: it is
  removed when the streaming source closes, so a session does not accumulate
  multi-GB caches. Cross-session reuse that skips the build is future work.
- **Native decoder conformance** (phase 0): a round-trip test proves the
  decoder against its own mirror encoder, which cannot catch a shared
  misreading of the laszip stream format. The invariant checks catch gross
  divergence on any real file at open time, and the phase-0 gate includes a
  conformance run against files written by mainstream laszip tooling before
  the fast path is enabled by default.
