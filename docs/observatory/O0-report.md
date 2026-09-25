# Observatory O0 report

Baseline: `docs/observatory/SPEC.md` §1 names commit `affffa41` and archive
`openlidarviewer-v0.7.0-alpha.1-source-20260922-2110.zip` (SHA-256
`1b750dcb55499d68f938c409c3193bf8000d7ebc20bd98276b5ca8de9cb91a3`). The
working tree at the start of this phase is `affffa41`, matching that commit
exactly, so the archive was not needed to resolve any difference; every row
below is read from the tree.

## 1. SPEC §1.1, §1.2, §1.3 verification

Verdicts below are independently confirmed against the working tree at
`affffa41`. Line numbers are current as of this commit.

### 1.1 What Observatory builds on

| Row | Verdict | Evidence |
|---|---|---|
| Acquisition grid | TRUE | `src/model/OrganizedRange.ts:35-53` defines the five `CellState` values (`VALID_RETURN`, `NO_RETURN`, `SOURCE_INVALID`, `NOT_DECODED`, `SOURCE_RECORD_MISSING`) and `RangeLinkage` at `:148-157` as `{kind:'exact'}` \| `{kind:'partial', reason:'stride'}` \| `{kind:'unavailable', reason:...}`. `acquisitionPose?` and `geometricRange?` are fields on `OrganizedRangeFrame`. Per-return CSR (`returnCellStart`, `returnRecord`, `returnIndex`) is built by `buildCellReturns()`. `docs/acquisition-grid.md` documents the same five states. |
| Ray coverage | TRUE | `src/model/acquisitionCoverage.ts:1-30` states, in its own header, that it proves ray coverage and not surface absence, that occlusion is not handled and that "inside the grid extent" is an upper bound, and that a no-return says nothing about why. `CoverageVerdict = 'interrogated' \| 'uninterrogated' \| 'indeterminate'`; `buildAcquisitionCoverage` and `coverageAtWorldPoint` are exported. |
| Scanner origin | TRUE | `OrganizedRangeFrame.acquisitionPose` (`src/model/OrganizedRange.ts:255`) and `CloudMetadata.scannerOrigin` (`src/model/PointCloud.ts:77`, PTX) both exist as declared-origin fields, documented as the scanner's registered world position before any origin shift. |
| PTX multi-block | TRUE | `src/io/loadPtx.ts` builds one `AcquisitionPose` per block (`:206-212`) and pushes one frame per block (`:318-331`), each carrying its own pose. `metadata.scannerOrigin ??= blockOrigin` (`:212`) keeps only the first block's origin on `CloudMetadata`, by construction of `??=` inside the per-block loop. |
| Coverage vocabulary | PARTIAL | `TerrainCoverageMode = 'full' \| 'resident-only' \| 'sampled'` exists exactly as stated (`src/terrain/TerrainContracts.ts:108-111`) and `SimulationInputBasis` reuses it on purpose (`src/simulation/simulationInputBasis.ts:10-15,34,39`). The `measured \| preview \| withheld` authority union exists once, as `StockpileAuthority` (`src/render/measure/stockpilePresenter.ts:172`), scoped to the stockpile/area-grid feature, there is no shared, general-purpose authority type today. The vocabulary and pattern are real and precedented; OB-INT-03/OB-INT-04 phases will need to either reuse `StockpileAuthority` or define a parallel type with the same three values. |
| Freshness | TRUE | `src/science/analysisFreshness.ts:27-38` defines `AnalysisFreshnessStamp` with exactly `{targetId, classificationEpoch, crsRevision, coverageMode}`, `FreshnessBreach = 'scan' \| 'classification' \| 'frame' \| null` (`:41`), and `analysisFreshnessBreach()` (`:49-61`) names which fact moved. None of OB-INT-03's planned additions (`sourceDigest`, `basis`, `roiDigest`, `stationSetDigest`, `parameterDigest`, `methodTags[]`, `metresPerUnit`) exist yet, which SPEC correctly does not claim. |
| Run records | TRUE | `FieldSimulationKind = 'terrain-flow' \| 'terrain-access' \| 'scan-rescue'` (`src/simulation/simulationRunRecord.ts:36`). `'terrain-access'` and `'scan-rescue'` are enum values only: no runner, branch or UI reference exists anywhere else in `src/`. SHA-256 over canonical JSON goes through `render/measure/auditLog`'s `canonicalize`/`sha256` (`:32,108-109,140`). |
| Rigid alignment | TRUE | `src/registration/rigidSolve.ts` implements Kabsch/Horn with scale fixed at 1 and refuses fewer than 3 correspondences or a degenerate configuration (`:3,12`). `transformStore.ts`, `tiePointAlignment.ts` and `generalIcp.ts` all exist and are registered staged/unreachable in `docs/validation/unreachable-modules.json`. |
| Project frame | TRUE | `src/geo/frame/`, `docs/architecture/project-spatial-frame.md`, `docs/coordinate-precision.md` and `src/model/pointFrames.ts` all exist. `docs/architecture/project-spatial-frame.md:3` states "foundation landed, scene wiring deferred." Production layer placement still forces the identity case while mounting is disabled (`src/render/layerPlacement.ts:8-9`), consistent with foundation-not-wired. |
| Screen-space occlusion | TRUE | `src/render/measure/lassoOcclusion.ts:1-30` is a camera-view depth test bucketing candidates into cells sized from projected point spacing, with a documented tolerance derivation. It is explicitly not a scanner-visibility method. |

### 1.2 What does not exist

| Row | Verdict | Evidence |
|---|---|---|
| No observation kernel / voxel evidence ledger / ray traversal | TRUE | `src/observation/` did not exist before this phase (this phase adds only a placeholder README, §3 below, no code). No occurrence of an observation kernel, voxel evidence ledger or ray-traversal module anywhere in `src/`. |
| No camera or trajectory import; E57 `images2D` not read | TRUE | No reference to `images2D`, camera intrinsics, image poses or trajectory files anywhere in `src/io/e57/` or `src/`. `NavController.CameraPose` and `orthoCamera.syncCameraPose` are the viewer's own navigation camera and are unrelated to external photogrammetry import. |
| No Terrain Access implementation | TRUE | No `TerrainAccess`/`terrainAccess` symbol anywhere in `src/`. Only the enum literal `'terrain-access'` in `FieldSimulationKind` exists, with zero runtime references. |
| No general work queue with scientific-vs-presentation semantics | TRUE | No occurrence of `scientific-cancellable`, `presentation-latest-wins` or `scientific-must-complete` anywhere in `src/`. |
| No numpy or scipy in `requirements-repro.txt` | TRUE | The file pins only `matplotlib==3.9.2`; its own comments state the scientific figures come from `npm run repro:metrics` (JS), not Python. |

### 1.3 Observation inputs per format

| Row | Verdict | Evidence |
|---|---|---|
| PTX | TRUE | Declared per-block origin (`loadPtx.ts:203-212`), grid ray directions (`sourceKind: 'ptx-grid'`, per-block width/height), explicit `0 0 0` mapped to `NO_RETURN` (`:262-266`), one `OrganizedRangeFrame` per block (`:318`, `id: setup-${blockIndex}`). |
| Organized PCD | TRUE, both O0-verification clauses below | Origin only when `VIEWPOINT` is present and well-formed (`loadPcd.ts:178-188`); grid built and validated against the decoded record count (`:352-402`); a non-finite record maps to `SOURCE_INVALID`, never `NO_RETURN` (`:366-376`, with an explicit comment that PCD "has no no-return semantics"), matching `docs/acquisition-grid.md:42-45`; one frame per file (`id: 'pcd-grid'`). |
| E57 structured | PARTIAL | Grid ray directions: TRUE (`E57GridBuilder` sizes from `indexBounds`, fills `cellState`/`cellToRecord` per cell). No-return rays: TRUE, see the O0 verification below, every invalid record reads `SOURCE_INVALID`, never `NO_RETURN`. Station membership "per frame": TRUE, one `OrganizedRangeFrame` per scan (`structuredFrames.ts:20-22`, `loadE57.ts:441-452`). Origin "per-scan pose": the pose IS decoded and used to rotate/translate points (`loadE57.ts:363-391`), but `E57GridBuilder.frame()` never sets `acquisitionPose` (zero occurrences of `acquisitionPose` in `loadE57.ts` or `structuredFrames.ts`, confirmed by direct grep), unlike PTX and PCD, which both set it. A structured-E57 `OrganizedRangeFrame` today has no `acquisitionPose`, only the raw parsed pose one step upstream of the frame. This does not block Observatory, since OB-INT-02's station sidecar is exactly what supplies this, but the §1.3 "Full" classification is a target the frame does not yet carry on its own. |
| E57 unstructured, posed | TRUE | `loadE57.ts:354-426` applies each scan's pose in an outer per-scan loop and appends into one running array (`w++`); neither the pose nor a per-point scan id is stored on the returned cloud (`CloudAttributes` has no scan/station field; `e57Metadata()` records only aggregate provenance). |
| LAS/LAZ/COPC/EPT, terrestrial and airborne/mobile | Not independently re-verified this phase (not named in the O0 task list), no SPEC-vs-tree conflict found while reading the surrounding loaders. | n/a |

## 2. The three O0 verifications

### 2.1 E57 record-range contiguity through sanitation (OB-INT-02)

Contiguity holds. Two point-dropping steps sit between decode and
`PointCloud`, and both preserve order:

- The E57 merge loop's own `cartesianInvalidState` filter
  (`src/io/loadE57.ts:372-380`): scans are visited in an outer `for (const scan
  of scans)` loop, and the running merged index `w` only ever increments
  (`loadE57.ts:355,424`), so each scan's survivors already land as one
  contiguous block before sanitation runs.
- `sanitizeAndRecenter`'s non-finite-coordinate filter
  (`src/io/sanitizeCloud.ts:270-284`, `compactValidRecords`): a single `for (let
  i = 0; i < count; i++)` loop over the whole merged array, writing to output
  index `w` only on survival and otherwise skipping, strictly order-preserving,
  never reordering.

An order-preserving compaction can only shrink a contiguous input range to a
(possibly smaller) contiguous output range; it cannot fragment or interleave
one scan's survivors with another's. Composing the two steps, a scan's record
range stays contiguous end to end. `src/io/organizedRangeRemap.ts:1-13` and
`loadE57.ts:492-493` both state this same property in their own header
comments.

Consequence for OB-INT-02: The station sidecar can use a `[start, end)`
range per station rather than a per-record station index, at zero per-point
memory cost, exactly as SPEC §4 OB-INT-02 proposes. The fallback, a `Uint16`
per-record station index, is not needed. Had it been needed, its cost on a
1M-point unstructured E57 cloud would be 2 bytes/point, 2 MB, alongside the
existing ~12-16 bytes/point (positions, colour) the loader already allocates:
roughly a 12-16% memory increase for that one array, which is why SPEC asks
this to be verified before it is chosen.

### 2.2 Structured-E57 no-return semantics (OB-INT-02, §1.3)

The loader collapses to `SOURCE_INVALID`, never `NO_RETURN`, and the file's own finer codes are not read. `E57GridBuilder.place()`
(`src/io/e57/structuredFrames.ts:159-167`) maps every dropped record to
`CellState.SOURCE_INVALID`, with a comment stating this is "evidence about the
record, not about this session." A repository-wide search
(`grep -rn NO_RETURN src/io/e57/`) returns zero matches: the E57 path cannot
produce `NO_RETURN` at all. Upstream, both the merge (`loadE57.ts:362,377-380`)
and preflight (`src/io/e57/preflight.ts:46`) read `cartesianInvalidState` only
as `!== 0`, never distinguishing the ASTM E2807 codes 1 and 2 the field can in
principle carry. So even though the format could in principle distinguish
"direction known, range invalid" from "fully invalid," this codebase does not
read that distinction today, and every invalid structured-E57 record reads
`SOURCE_INVALID`.

Consequence: This confirms the fallback clause in SPEC §1.3's E57
structured row exactly as written. No code change follows from this in O0.

### 2.3 PCD viewpoint (§1.3)

An origin is given only when the header carries a complete, numeric `VIEWPOINT` line. `src/io/loadPcd.ts:178-188` parses `VIEWPOINT tx ty
tz qw qx qy qz` and requires exactly 7 finite numeric tokens; a missing,
partial or non-numeric line leaves `facts.viewpoint` `undefined`
("a partial or non-numeric VIEWPOINT is not a viewpoint," `:182-183`).
`buildPcdFrame` (`:379-388`) builds an `AcquisitionPose` only when `viewpoint`
is defined. This confirms the §1.3 PCD row's origin clause exactly as written.

## 3. OB-INT-01: `src/observation` in the layer lint

`src/observation` was added to `LAYERS` in `scripts/lint-layer-boundaries.mjs`
(the array grew by one entry; no other line in that file changed). The
directory did not exist before this phase; `scripts/lint-layer-boundaries.mjs`
tolerates a missing layer directory by design (`walk()` catches the read
failure and reports zero files, and `src/observation` was deliberately left out
of `POPULATED_LAYERS`, which is the list that requires a layer to already carry
files), so no placeholder was strictly required for that lint to pass.

A placeholder was still added, `src/observation/README.md`, prose only,
documenting the layer's purpose and pointing at this SPEC, because a directory
a reader can find is better than one only a config array declares. A
Markdown file, not a `.ts` module, was chosen deliberately: an `index.ts` with
only a doc comment would be a new node in the module graph that nothing
imports, and `lint:unreachable-modules` would then require registering it in
`docs/validation/unreachable-modules.json` with a status and a graduation path
for a file with no content, machinery this phase's "no behaviour change"
mandate does not need yet. `README.md` is invisible to `lint:layer-boundaries`
(which only walks `.ts` files), `lint:unreachable-modules` and
`lint:module-graph` (neither walks Markdown).

Verified after the change: `lint:layer-boundaries` (169 science/core files,
up from 168, all clean), `lint:unreachable-modules` (896 modules, 837
reachable, 59 registered unreachable, unchanged), `lint:module-graph` (896
files scanned, unchanged) all pass.

## 4. OB-INT-08: frame-demand tests and the final-paint finding

`npx vitest run tests/frameDemand.test.ts tests/invalidationDrawsFrame.test.ts`
passes: 2 files, 39 tests, 0 failures.

Burst-end coverage is confirmed directly. `tests/frameDemand.test.ts`,
`describe('pending GPU commits keep the loop awake')` (lines 146-284), covers
exactly the "final committed node never painted until the heartbeat" risk:

- `'keeps needing frames until the queue drains, not until a heartbeat'`
  (:152-168) drains 3 pending commits at 16 ms/frame, well inside the 250 ms
  idle heartbeat, then asserts one paint is still owed and is discharged on
  its own merit before the loop is allowed to sleep.
- `'draws the frames a burst is still uploading on, not just the last'`
  (:170-183) and `'owes exactly one paint, and a second drain does not double
  it'` (:184-202) both exercise the falling edge of a commit burst directly,
  including a second burst re-arming the latch.
- `'never sleeps on geometry that landed after the frame decided to draw'`
  (:233-262) walks one real loop iteration in order (decide, render, pump,
  tick) and asserts a node that lands mid-body is still owed on the next
  frame, not silently absorbed.

Ledger action: No ledger entry anywhere in
`docs/releases/V070_IMPLEMENTATION_LEDGER.md` names this finding: a grep for
`final paint`, `commitPending`, `commitWork`, `streamedGeometryChanged` and
`gpu-commit-pending` across the whole file returns zero matches. Tracing the
code instead: `commitPending`/`commitWork` were introduced by commit
`888724f0` ("The loop paints what woke it, and terrain flow gets an engine",
#1007), which also carries the measurement this phase's evidence extends, "34
node arrivals across four sessions," recorded verbatim in
`src/render/frameDemand.ts`'s own doc comment as the sample size behind the
original "never observed" note. That commit predates `affffa41` by one PR
(#1008, #1009) and did not touch the ledger file. So the "old final-paint
finding" SPEC §1.1 and OB-INT-08 refer to was closed in code, not in the
ledger, this phase is the first ledger record of it. Ledger entry L160
(§5 below) records the closure: tests pass, burst-end is covered by name, and
no render-loop change was made to reach this state (none was needed).

## 5. Discrepancies

- `docs/validation/claim-register.yaml:1133`, (claim `ORG-TOPOLOGY-IDENTITY`,
  `scope.unsupported`) states: *"E57. The reader records what a structured
  scan declares and decodes no row or column column, so no E57 file produces a
  frame and no identity is claimed for one."* This is false against the
  working tree: `src/io/e57/structuredFrames.ts`'s `E57GridBuilder` decodes
  `rowIndex`/`columnIndex` (confirmed: `structuredFrames.ts:96-97`) and
  produces an `OrganizedRangeFrame` with real `cellToRecord` identity,
  exercised by `tests/e57StructuredRange.test.ts`. The claim-register line
  predates structured-E57 grid support and was not updated when it shipped.
  Surfaced here because it directly concerns an §1.3 row; not fixed in O0,
  since editing `docs/validation/claim-register.yaml` is outside this phase's
  six named steps and outside "no behaviour change." Left for a dedicated
  follow-up (flagged separately, see below).
- No other discrepancy between SPEC §1 and the working tree was found.

## 6. Open ASK items

### ASK 1: OB-INT-02 station sidecar range representation

Per §2.1 above, contiguity holds, so:

1. `[start, end)` range per station, (SPEC's stated default). Zero
   per-point memory cost. Depends only on the merge order and sanitation's
   order-preservation, both confirmed and both already load-bearing
   elsewhere in the loader.
2. `Uint16` per-record station index, (the documented fallback). ~2
   bytes/point, ~2 MB on a 1M-point cloud, ~12-16% over the loader's existing
   per-point allocation. Buys robustness against a future reordering step
   between decode and the sidecar that §2.1 did not have to consider because
   none exists today.
3. Range with a debug-mode consistency assertion: ship option 1, and add
   a development-only assertion (stripped from production, or gated behind an
   existing debug flag) that re-derives ranges from a witness and compares,
   to catch a future reordering step regressing this silently.

Recommendation: option 1, per SPEC's own default and the evidence in
§2.1. This is not a decision O0 makes, OB-INT-02 changes `CloudMetadata`,
which is explicitly ASK, and no station-sidecar code is written in O0.

### ASK 2: `lint:doc-narration` fails on the verbatim SPEC

`npm run lint:doc-narration` fails on one line: `docs/observatory/SPEC.md:409`,
flagged `[session-artifact] working-note artifact`.

Line 409 is OB-UI-05's own permitted-wording list, which names several exact
phrases the UI is allowed to show the user, one of them built from "not read"
plus a four-word clause naming the current session. The lint's
`session-artifact` pattern, imported unmodified from `pr-hygiene.mjs`, matches
that four-word clause anywhere in a document, including inside a quoted UI
string, so this is a genuine false positive rather than the SPEC narrating its
own authoring. `scripts/lint-doc-narration.mjs`'s own header
states its design intentionally carries no allowlist ("a lint with exceptions
gets exceptions added to it"), so there is no existing suppression mechanism,
and the binding rule for this phase forbids editing the SPEC to route around
it.

1. Leave it as a documented, open red. No file changes. The failure is
   fully explained here and in this ledger entry; a future reader hitting it
   sees why. Costs nothing except an unclean `lint:doc-narration` run until
   resolved.
2. Teach the lint to skip fenced/quoted text (e.g. skip matches inside
   Markdown inline code spans or backtick-quoted phrases). Fixes this case
   and any future SPEC that quotes permitted wording containing a flagged
   phrase, but changes a gate's behaviour, which is explicitly out of scope
   for O0 and risks weakening a check designed to have no exceptions.
3. Add a narrow, file-scoped exemption (e.g. an allowlist entry keyed to
   `docs/observatory/SPEC.md:409`). Smaller blast radius than option 2, but is
   still "a lint with exceptions," which the lint's own header names as the
   failure mode it was written to avoid.

Recommendation: option 1 for O0 (change nothing, keep the finding
documented here and in L160); a maintainer decides between options 2 and 3
in a later phase if the red is judged worth clearing. This phase does not
implement any option other than 1.

Resolved: the maintainer chose to reword. OB-UI-05's permitted phrase for
`NOT_READ` is "not read in this load", which carries the same meaning (the
data exists but was not decoded in the current load) and passes
`lint:doc-narration` unchanged. The SPEC was amended on that one line.

### ASK 3: `docs/validation/claim-register.yaml` stale E57 scope note

See §5. Options: (1) leave as documented technical debt, flagged separately
outside this phase; (2) correct the `scope.unsupported` line to describe
structured E57's real limits (it is confined to synthetic fixtures and
carries no cross-implementation check, which is a true and available
substitute claim); (3) leave it and let a future claim-register audit find
it. Recommendation: option 2, in a session scoped to claim-register
maintenance, not in O0.
