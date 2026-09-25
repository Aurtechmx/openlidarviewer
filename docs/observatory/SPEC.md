# OLV Observatory: Observation Evidence, Occlusion and Coverage Planning

Specification v2, for OpenLiDARViewer 0.7.0-alpha.1. Commit this file as `docs/observatory/SPEC.md`. The session driver refers to it by requirement ID (`OB-…`). **Shall** is mandatory and testable; **should** is expected unless a recorded reason says otherwise.

This spec pairs with the SensorPrint spec (`docs/sensorprint/SPEC.md`). Observatory consumes scanner origins; SensorPrint may later produce reconstructed ones. §4 OB-INT-06 defines the seam between them.

---

## 0. Purpose

A point cloud records where surfaces were found. It does not say which space was looked at and found empty, which space sat behind something, and which space no instrument ever pointed at. A reader who cannot tell those apart will read a hole as "nothing there" when it may be "never looked".

Observatory answers five questions from measured geometry and declared scanner origins:

1. Where did a source find a surface, and do the sources agree?
2. Which space did a source's rays pass through, empty at the time of the scan?
3. Which space sat behind a found surface, as seen from each source?
4. Which space did no source address, or did this session not read?
5. Where could one more station expose the most of 3 and 4, under an instrument model the user declares?

Governing rule:

```text
found surface ≠ passed through ≠ behind a surface ≠ fired with no return ≠ never addressed ≠ not read by this session ≠ what a new station might see
```

Second rule: canonical fields are computed once, digested and exported. Everything drawn on screen is a presentation derived from them, and no presentation setting can change a canonical byte.

Observatory is deterministic geometry. It adds no learned inference, no model weights and no production Python.

---

## 1. Verified baseline (re-verify in Phase O0)

Read from `openlidarviewer-v0.7.0-alpha.1-source-20260922-2110.zip` (SHA-256 `1b750dcb55499d68f938c409c3193bf8000d7ebc20bd98276b5ca8de9cb91a3`). Where the working tree differs, the tree wins and the difference goes in the O0 report.

### 1.1 What Observatory builds on

| Concern | Existing code | What it gives Observatory |
|---|---|---|
| Acquisition grid | `src/model/OrganizedRange.ts`, `docs/acquisition-grid.md` | Per-setup grid for PTX, organized PCD and structured E57. Five cell states: `VALID_RETURN`, `NO_RETURN`, `SOURCE_INVALID`, `NOT_DECODED`, `SOURCE_RECORD_MISSING`. Per-return CSR, `geometricRange`, `acquisitionPose`, linkage `exact` / `partial:stride` / `unavailable`. |
| Ray coverage | `src/model/acquisitionCoverage.ts` (`buildAcquisitionCoverage`, `coverageAtWorldPoint`, `CoverageVerdict = interrogated \| uninterrogated \| indeterminate`) | A fitted angular parameterisation per setup. The module states that it does not handle occlusion, that "interrogated" is an upper bound, and that a no-return says nothing about why. Observatory is the occlusion-aware successor. It shall reuse this parameterisation and keep those statements true. |
| Scanner origin | `OrganizedRangeFrame.acquisitionPose`; `CloudMetadata.scannerOrigin` (PTX) | Declared origins for gridded sources. |
| Posed E57 | `src/io/loadE57.ts` applies each scan's pose and appends scans in order | For unstructured multi-scan E57 the pose is applied and then discarded. Neither the per-scan pose nor per-point scan membership survives the load (OB-INT-02). |
| PTX multi-block | `src/io/loadPtx.ts` | Grid frames carry per-block poses. `metadata.scannerOrigin` keeps only the first block's origin (`??=`). |
| Coverage vocabulary | `TerrainCoverageMode = full \| resident-only \| sampled`; authority `measured \| preview \| withheld`; `SimulationInputBasis` | "How much of the source stood behind this" is already a declared field. `SimulationInputBasis` reuses the terrain vocabulary on purpose rather than adding a second enum. |
| Freshness | `src/science/analysisFreshness.ts` | Stamp-and-refuse on scan, classification or frame change, naming the fact that moved. |
| Run records | `src/simulation/simulationRunRecord.ts` (`FieldSimulationKind` includes `'terrain-access'` and `'scan-rescue'`; SHA-256 via `render/measure/auditLog`) | Shape to follow for a reproducible run record. `terrain-access` and `scan-rescue` are enum values only, with no implementation. |
| Rigid alignment | `src/registration/rigidSolve.ts` (Kabsch/Horn, scale fixed at 1, refuses degenerate input), `transformStore.ts` (non-destructive Float64 placement), `tiePointAlignment.ts`, `generalIcp.ts` | Staged, not reachable. Any pose alignment builds on these. |
| Project frame | `src/geo/frame/`, `docs/architecture/project-spatial-frame.md`, `docs/coordinate-precision.md`, `src/model/pointFrames.ts` | Per-cloud Float64 origin with Float32 local positions. A shared project frame exists as foundation; scene wiring is deferred. |
| Screen-space occlusion | `src/render/measure/lassoOcclusion.ts` | Camera-view depth test with scale-derived cell size. It shows the house style for tolerance reasoning. It is not a scanner-visibility method. |
| Colour and range | `src/render/colorModes.ts` (categorical ids stay categorical), `paletteCatalog.ts`, `colorbar.ts`, `activeColorbar.ts`, `colorLegend.ts`, `elevationRange.ts` (`computeScalarRange`, percentile clip) | Presentation of per-point scalars and categories. |
| GPU uploads | `src/render/gpuUploadQueue.ts` (time-budgeted, generation-stamped, stale items discarded before upload) | The existing latest-generation-wins mechanism. |
| Device loss | `src/render/deviceGeneration.ts`, `gpuErrorLedger.ts` | Tells a resource which device era it belongs to. |
| Frame demand | `src/render/frameDemand.ts`, `renderInvalidation.ts` (`gpu-commit-pending`, `streaming-ready` reasons), `renderActivityGate.ts` | The earlier "final committed node never painted until the heartbeat" risk is handled by `commitPending` plus `commitWork`. Covered by `tests/frameDemand.test.ts` and `tests/invalidationDrawsFrame.test.ts`. |
| Frame budget | `src/render/perf/frameBudgetGovernor.ts` | Pure, presentation-only, with hysteresis. Registered as staged in `docs/validation/unreachable-modules.json` and wired by a separate render-loop phase. |
| Presentation reconstruction | `src/render/continuity/`, `docs/continuity-field.md` | The project's direct / accumulated / reconstructed vocabulary. Reconstructed pixels are structurally unpickable. |
| Gates and registries | method registry, claim register, oracle registry, V070 ledger, unreachable-module register, layer-boundary lint, position-access ratchet, monolith ratchet, `lazyChunks.ts`, `WORKER_REGISTRY`, test-bucket map | Same constraints as SensorPrint SPEC §1.2. |

### 1.2 What does not exist

- An observation kernel, voxel evidence ledger or ray traversal.
- Camera or trajectory import of any kind: no intrinsics, no image poses, no trajectory files. E57 `images2D` is not read.
- A Terrain Access implementation.
- A general work queue with scientific-vs-presentation semantics.
- numpy or scipy in `requirements-repro.txt`.

### 1.3 Observation inputs per format

| Format | Origin | Ray directions | No-return rays | Station membership | Observatory support in v0.7 |
|---|---|---|---|---|---|
| PTX | per block, declared | grid | explicit `0 0 0` | per block frame | **Full** |
| Organized PCD | only if the file declares a viewpoint (O0 verifies) | grid | not distinguishable from invalid (per `acquisition-grid.md`) | single frame | Full when an origin exists; otherwise user-placed only |
| E57 structured | per-scan pose | grid | `SOURCE_INVALID`, not `NO_RETURN`, unless the file distinguishes them (O0 verifies) | per frame | **Full** |
| E57 unstructured, posed | per-scan pose, currently discarded | hit − origin | none | currently lost | Full after OB-INT-02 |
| LAS/LAZ/COPC/EPT, terrestrial | none declared | none | none | point source ID, if the producer set it | User-placed origin only, labelled `ASSUMED` |
| LAS/LAZ/COPC/EPT, airborne or mobile | none; no trajectory | none | none | point source ID | **Unavailable in v0.7**. Stated plainly in the panel. |

A significant share of files OLV opens will have no observation geometry. The panel says so, names what the file lacks, and does not fabricate an origin.

---

## 2. Observation model

### 2.1 The evidence ledger

The canonical product is a sparse voxel evidence ledger over a declared domain (ROI box, or the cloud's data bounds), at a declared voxel edge `h`. For every ray of every source, traversal adds counts:

| Counter | Incremented when |
|---|---|
| `hit` | The voxel contains the ray's return, within the hit window. |
| `pass` | The ray traverses the voxel before the hit window begins. |
| `behind` | The voxel lies on the ray's extension beyond its hit, up to the domain bound or declared maximum range. |
| `noReturn` | The ray was fired with no return and traverses the voxel up to the declared maximum range. |

Hit window: along the ray, a return at range `r` occupies `[r − τ(r), r + τ(r)]` with `τ(r) = τ_abs + τ_rel·r`. `pass` stops at `r − τ(r)`; `behind` starts at `r + τ(r)`.

- `τ_abs` and `τ_rel` are declared parameters with units. Their defaults are derived from `h` and the source's angular step. The derivation is written in `docs/observatory/methods.md` and preregistered in `validation/protocols/observatory/`.
- Counters are kept per source and in aggregate.
- Per-source presence is a bitmask: `Uint32` words, 32 sources per word.
- Counters are saturating `Uint16`, and saturation is recorded per voxel.

### 2.2 State vocabulary

Per source, then aggregated. Each state is a derived label; the counters remain the record.

```ts
type ObservationState =
  | 'SURFACE'            // hit fraction ≥ p_solid with ≥ n_min rays
  | 'PARTIAL'            // p_empty < hit fraction < p_solid: porous, edge or mixed-pixel
  | 'OBSERVED_EMPTY'     // pass ≥ n_min, hit = 0: space the rays crossed
  | 'CONFLICT'           // sources disagree (§2.3)
  | 'SHADOWED'           // only behind-evidence; see §2.4
  | 'NO_RETURN_PATH'     // only noReturn-evidence: fired, nothing came back
  | 'UNADDRESSED'        // inside the domain, and no source's ray domain covers it
  | 'NOT_READ'           // covered by a ray this session did not decode
  | 'OUTSIDE_DOMAIN';    // outside the ROI, the minimum/maximum range, or the angular extent
```

The hit fraction is `f = hit / (hit + pass)`. It is a statistic of ray outcomes, not an occupancy probability. It is named "hit fraction" everywhere it appears.

Deliberate differences from a four-state model:

- **`OBSERVED_EMPTY` is evidence.** It is distinct from `UNADDRESSED`. Collapsing the two is the specific error this subsystem exists to prevent, in either direction.
- **`NO_RETURN_PATH` is its own state.** A no-return ray can mean dark, specular or wet surfaces, water, glass, or distance beyond the instrument. It is never read as empty. This follows the rule already stated in `acquisitionCoverage.ts`.
- **`NOT_READ` is its own state.** A `NOT_DECODED` cell, or an unread streaming node, is a fact about this session, not about the scene.
- **`PARTIAL` absorbs vegetation, fences, edges and mixed pixels.** Without it, every tree is a "conflict".

### 2.3 Conflict

`CONFLICT` requires disagreement between sources, never within one source:

- source A has `f_A ≥ p_solid` with `n ≥ n_min`, and
- source B has `f_B ≤ p_empty` with `n ≥ n_min`.

The record keeps both source ids and both counts.

Conflict is not averaged into anything. Its listed causes are motion or change between setups, misregistration, and a surface seen edge-on from one side only. The panel names all three and asserts none.

### 2.4 Shadow and frontier

For source `s`, a voxel is `SHADOWED_s` when all of these hold:

- it has `behind_s > 0`;
- it has `hit_s = pass_s = 0`;
- it lies within `s`'s addressed angular domain.

Aggregate precedence, first match wins:

1. `NOT_READ`, if any contributing ray was not decoded and no read ray gives hit or pass evidence.
2. `CONFLICT`.
3. `SURFACE`.
4. `PARTIAL`.
5. `OBSERVED_EMPTY`.
6. `SHADOWED`, if shadowed for at least one source and no source has hit or pass evidence.
7. `NO_RETURN_PATH`.
8. `UNADDRESSED`.
9. `OUTSIDE_DOMAIN`, which is applied first spatially.

This table is the whole rule. It is implemented as one pure function with an exhaustive test over counter combinations.

A voxel shadowed from A and seen by B is not shadowed in aggregate. The per-source view keeps A's shadow visible when the user isolates A.

**Shadow frontier:** the set of `SURFACE` or `OBSERVED_EMPTY` voxels 6-adjacent to a `SHADOWED`, `UNADDRESSED` or `NO_RETURN_PATH` voxel. "Scan Shadow" is the user-facing view of `SHADOWED` voxels together with this frontier.

### 2.5 Observation strength

These are components, never a single hidden figure. Each is computed per `SURFACE` voxel:

| Component | Definition | Range |
|---|---|---|
| `sources` | Distinct sources with `hit > 0` | integer |
| `angularSpread` | `1 − ‖mean of unit ray directions of hitting rays‖` | [0, 1] |
| `incidence` | Median `cos i` between hitting rays and the local surface normal. The normal comes from `symEig3` over the voxel's resident points, or the source normals when present. | [0, 1] |
| `rangeFit` | Fraction of hits inside the declared useful range band | [0, 1] |
| `consistency` | `f`, the hit fraction | [0, 1] |

A composite `strength index` may be shown only as the declared weighted mean of the bounded components:

- Weights are shown beside the index.
- The components are shown beside it.
- `sources` enters through a declared saturating map, for example `min(sources, 3) / 3`.

It is never called accuracy, precision, confidence or probability.

---

## 3. Invariants

- **OB-INV-01** No state other than `OBSERVED_EMPTY` shall represent empty space. `UNADDRESSED`, `NO_RETURN_PATH` and `NOT_READ` shall never render, export or be counted as empty.
- **OB-INV-02** `CONFLICT` shall require two distinct sources. Within-source disagreement yields `PARTIAL`.
- **OB-INV-03** Every canonical field shall carry its basis (`TerrainCoverageMode`) and authority. A field with any `NOT_READ` voxel inside the domain shall not carry authority `measured`.
- **OB-INV-04** No origin shall be invented.
  - Declared origins are `DECLARED`.
  - User-placed origins are `ASSUMED`, with authority `preview`, a label on every view, and export only under an "assumed origin" heading.
  - Reconstructed origins are accepted only per OB-INT-06.
- **OB-INV-05** A suggested station shall always be labelled `SUGGESTED STATION (not observed)`, in the panel, in 3D, in exports and in session files. It shall never enter the evidence ledger.
- **OB-INV-06** No presentation parameter shall change a canonical byte or `fieldDigest`. This covers pixel ratio, Eye Dome Lighting, overlay sampling, colour range, frame budget and panel state. Covered by a test that varies each and compares digests.
- **OB-INV-07** For the same inputs, parameters and method versions, reruns shall produce an identical `fieldDigest`. This holds across chunk order, worker count and machine. Counters are integers and accumulation is commutative. Any float reduction merges in a fixed order.
- **OB-INV-08** Scientific work shall never be dropped silently. Only work marked `presentation-latest-wins` may be coalesced (§6.3).
- **OB-INV-09** A run whose freshness stamp no longer matches shall not commit, display as current, or export. The refusal names the fact that moved.
- **OB-INV-10** Metric figures shall be withheld when the linear unit is unknown. This covers areas, volumes, distances and tolerances in metres. The field may still be computed in source units, labelled as such.
- **OB-INV-11** Observatory shall never modify points, classification, flags, poses or `TransformStore` placements.
- **OB-INV-12** No serial number, position or field shall leave the device.

---

## 4. Integration decisions

Items marked **ASK** require the user's approval in chat before code is written.

- **OB-INT-01 Package and layering.**
  - `src/observation/` is pure: no DOM, `three` or `ui/` imports. Add it to `LAYERS` in `scripts/lint-layer-boundaries.mjs` in O0.
  - Rendering adapters live in `src/render/observation/`; the panel lives in `src/ui/observatory/`.
  - Raw `.positions` reads go only through `pointFrames.ts` accessors.
  - `main.ts` and `Viewer.ts` do not grow; mounting is through a coordinator.
  - Imports are only through `lazyChunks.ts`; workers are only through `WORKER_REGISTRY`, after profiling.
  - Staged modules are registered in `unreachable-modules.json` with the phase that wires them.
- **OB-INT-02 Station sidecar (ASK: it changes loader output).**
  - Add an `AcquisitionStations` sidecar on `CloudMetadata`. Follow the `OrganizedRange` pattern: a sidecar, never a second cloud. Each station holds its id, declared pose (Float64), source (`e57-scan` / `ptx-block` / `pcd-viewpoint`) and a contiguous record range `[start, end)`.
  - E57 appends scans in order, so ranges cost nothing per point.
  - O0 verifies that sanitation keeps record ranges contiguous. If it does not, the sidecar stores a `Uint16` station index per record, and that memory cost is reported before the change.
  - The PTX first-block-only `scannerOrigin` stays as it is for compatibility; the sidecar carries all blocks.
- **OB-INT-03 Freshness.**
  - The Observatory stamp extends the `analysisFreshness` fields with `sourceDigest`, `basis`, `roiDigest`, `stationSetDigest`, `parameterDigest`, `methodTags[]` and `metresPerUnit`.
  - If SensorPrint has already introduced the extended stamp type, reuse it; one stamp type serves both.
- **OB-INT-04 Method registry.**
  - Add `'observation'` to `MethodCategory`. This is an additive union member, recorded in the ledger.
  - Register `olv.observation.rays`, `.ledger`, `.states`, `.strength`, `.shadow-frontier`, `.coverage-gain` and `.station-suggestion` at version 1.
  - Tags are written only through `methodTag()`.
  - Assumptions, parameters, failure modes and determinism go in `docs/observatory/methods.md`, one section per id, with a test that each registered id has a section.
- **OB-INT-05 Run record.**
  - The canonical run record follows `simulationRunRecord.ts`: source, basis, model id and version, input digest, SHA-256 over canonical JSON.
  - `ScientificAnalysisRecord`, `processingManifest` and `scientificArtifactPassport` are extended, not paralleled.
- **OB-INT-06 Origins from SensorPrint.**
  - Observatory defines `ObservationOrigin { position (Float64), status, method tag, uncertainty }`, unless SensorPrint's handoff type (SP-ORIG-04) already exists, in which case it consumes that.
  - Default policy: accept `DECLARED`. Accept `RECONSTRUCTED_STRONG` under a visible "reconstructed origin" label with authority `preview`. Refuse weaker statuses with a reason.
  - Changing that policy is **ASK**.
- **OB-INT-07 Frame budget governor.** Wiring the governor is owned by the separate render-loop phase recorded in the unreachable register. Observatory does not wire it. When that phase lands, Observatory adds one optional-work switch (`observationOverlay`) with drop/restore thresholds like the existing switches, and a test that the switch cannot reach a canonical path.
- **OB-INT-08 Final paint.** O0 runs `tests/frameDemand.test.ts` and `tests/invalidationDrawsFrame.test.ts`. It retires the old final-paint finding in the ledger if they pass and cover the burst-end case, and opens a defect with a failing test if they do not. No render-loop change is made inside Observatory.
- **OB-INT-09 Tests and oracles.**
  - Test files go flat in `tests/` as `observatory*.test.ts`, or a new directory registered in `NESTED_TEST_DIRS`.
  - Oracles are standard-library Python in `validation/observatory/oracle/`, registered in `oracle-registry.json` under their own `lineageGroup`, with roles `analytic-truth` and `generator-truth` only.
  - Adding numpy or scipy is **ASK**.
- **OB-INT-10 Claims and ledger.** Each phase opens and closes a ledger entry. Claims enter `claim-register.yaml` at the evidence that exists; synthetic fixtures alone reach E3 at most. `prohibitedClaim` entries cover complete coverage from resident-only data, occupancy probability, sensor simulation, optimal station placement, and survey-grade accuracy.

---

## 5. Kernel

### 5.1 Rays (`olv.observation.rays`)

- **OB-RAY-01 Gridded sources** (PTX, structured E57, organized PCD with an origin):
  - One ray per cell, direction from the setup's angular parameterisation as fitted by `acquisitionCoverage`, rotated by `acquisitionPose`.
  - `VALID_RETURN` gives a returned ray at `geometricRange`.
  - `NO_RETURN` gives a no-return ray.
  - `NOT_DECODED` gives a not-read ray.
  - `SOURCE_INVALID` and `SOURCE_RECORD_MISSING` give no ray, and are counted.
- **OB-RAY-02 Posed unstructured sources:** the direction is `normalize(hit − origin)` and the range is `‖hit − origin‖`, computed in Float64 in the station's frame before any recentring (`docs/coordinate-precision.md`). Unstructured sources produce no no-return rays, and the field records that `NO_RETURN_PATH` is unavailable for them.
- **OB-RAY-03 Multi-return pulses** contribute one ray, not one per return:
  - Every return's voxel increments `hit`.
  - `pass` runs up to the first return.
  - `behind` runs beyond the last return.
- **OB-RAY-04 Storage** is structure-of-arrays, in bounded chunks:
  - origin index;
  - Float32 direction relative to a Float64 station origin;
  - Float32 range, NaN for no return;
  - return-count offset.
  
  No per-ray JS objects.
- **OB-RAY-05 Deterministic subsampling:** every k-th row and column for gridded sources, and a hash-threshold on record index for the rest, with `k` or the threshold recorded. A subsampled field has basis `sampled`.

### 5.2 Traversal and ledger (`olv.observation.ledger`)

- **OB-LED-01** Traversal is 3D DDA in Float64 (Amanatides & Woo, §12). The tie rule for rays that run exactly along voxel faces is written down and tested with axis-aligned and grazing rays.
- **OB-LED-02** Cheap rejection comes before traversal:
  - clip each ray to the domain AABB;
  - skip a station whose range sphere misses the domain;
  - skip a ray whose clipped segment is empty.
  
  Rejection ratio is reported as telemetry.
- **OB-LED-03** Sparse storage.
  - Voxel keys are packed integers. An open-addressing table with typed-array columns follows the voxel accumulator style that 0.6.9 held to byte identity.
  - Memory is bounded by a declared voxel budget.
  - When the budget would be exceeded, the run stops before allocation and offers a coarser `h`, a smaller ROI or subsampling. It never truncates silently.
- **OB-LED-04 Work budget.** Total traversal steps are estimated before the run (Σ clipped length / `h`). Estimates over budget require an explicit user choice.
- **OB-LED-05 Chunking.** Chunks accumulate into per-chunk tables merged in chunk-index order. With integer counters the merge is order-independent. The order rule exists for any float column.

### 5.3 States (`olv.observation.states`)

- **OB-ST-01** One pure function maps counters to a state (§2.2–2.4), per source and in aggregate.
- **OB-ST-02** `p_solid`, `p_empty` and `n_min` are preregistered in `validation/protocols/observatory/` before any fixture is scored.
- **OB-ST-03** State counts per state are part of the canonical record.

### 5.4 Shadow frontier (`olv.observation.shadow-frontier`)

- **OB-SH-01** Computed on the aggregate field and on any isolated source.
- **OB-SH-02** Output: the frontier voxel set, with area estimated at `h²` per exposed face in metric units when the unit is known, and its adjacency to `SHADOWED`, `UNADDRESSED` and `NO_RETURN_PATH` kept separate.

### 5.5 Strength (`olv.observation.strength`)

- **OB-STR-01** Components are computed as in §2.5.
- **OB-STR-02** The composite, when requested, stores its weights in the record and shows them in the panel.

### 5.6 Coverage Gain and Next Station Suggestion

The name is Coverage Gain, because it counts voxels a hypothetical station would newly address. It is not an information-theoretic quantity and is not named as one.

- **OB-GAIN-01 Instrument model.** The user declares:
  - instrument height above a standing surface;
  - minimum and maximum range;
  - vertical field of view;
  - the angular step used for planning rays;
  - optionally, "same as source N", which copies source N's declared or fitted parameters.
  
  The model is recorded in full. No manufacturer table is consulted.
- **OB-GAIN-02 Candidates.**
  - Generated deterministically on a grid of declared spacing over `SURFACE` voxels whose normal is within a declared angle of vertical and whose column above is clear to instrument height.
  - The count is capped, with the cap recorded.
  - Tie-breaks go by candidate index.
- **OB-GAIN-03 Gain.**
  - For candidate `c`, planning rays are traversed against the ledger.
  - `SURFACE` blocks. `PARTIAL` blocks when `f ≥ p_solid`, and otherwise passes and is counted.
  - `G(c) = Σ_v w(state(v))·vis_c(v)·inc_c(v) − λ_red·redundant_c`, where:
    - `w` is declared per state: defaults `SHADOWED` 1.0, `UNADDRESSED` 1.0, `NO_RETURN_PATH` 0.25, `CONFLICT` 0.5, weak `SURFACE` (strength components below declared floors) 0.5, others 0;
    - `inc_c` is the incidence term;
    - `redundant_c` counts already-strong voxels revisited.
  - Every term is reported separately for every candidate.
- **OB-GAIN-04 Several stations.**
  - Greedy sequential selection: after picking a station, its planned visibility is applied to a hypothetical copy of the ledger, and gains are recomputed.
  - The canonical ledger never changes.
  - The number of stations is declared.
- **OB-GAIN-05 Basis.** Planning on a field with authority below `measured` is labelled preview. `NOT_READ` voxels get weight 0, and the panel reports how many there were.
- **OB-GAIN-06 Reachability.**
  - Only the interface `ReachabilityProvider` is defined. Its verdicts are `reachable`, `unreachable` and `unknown`, each with an evidence reference.
  - There is no implementation in v0.7; Terrain Access does not exist.
  - The panel offers no "reachable" mode until a provider with recorded evidence is registered.

---

## 6. Presentation

### 6.1 Views

- **OB-PR-01 Per-point colour modes:** `observationState` (categorical palette, legend lists every state including empty ones), `observationStrength` (components selectable), `observationHitFraction`.
  - Each point takes its voxel's value through a presentation-only `Uint8`/`Float32` attribute built once per resident cloud per field version.
  - A field update rewrites only the attribute buffer, never the geometry. A test asserts no geometry rebuild on a field-only update.
- **OB-PR-02 Empty-space views.**
  - A voxel overlay for `OBSERVED_EMPTY`, `SHADOWED`, `UNADDRESSED` and the frontier: instanced boxes, or a slice plane through the field.
  - It ships only after a benchmark on the O11 scenarios, choosing between instancing and slicing by measured frame time and upload bytes.
  - Until then, the slice plane is the default, because it is bounded by slice size.
- **OB-PR-03 Suggested stations:** distinct marker geometry plus the text label (OB-INV-05).
- **OB-PR-04 Colour is never the only carrier.** States also differ in legend glyph and in the probe text.

### 6.2 Ranges

- **OB-PR-05** Bounded quantities use fixed ranges: hit fraction and every strength component use [0, 1], and categorical states have no range. Adaptive range control is permitted only for unbounded quantities (counts, Coverage Gain) and uses `computeScalarRange`.
- **OB-PR-06** Where adaptive range is used, it expands immediately, contracts only after the range has been exceeded in the other direction for a declared number of consecutive updates, resets on dataset, method or ROI change, and supports a fixed manual range. It is a pure function of the previous range and the new data, tested for no oscillation on an alternating input.

### 6.3 Work semantics

- **OB-PR-07** Every asynchronous task declares one of:
  - `presentation-latest-wins`: probe hover, attribute rebuild, overlay slice, legend refresh. Coalesced by key and generation, following `gpuUploadQueue`.
  - `scientific-cancellable`: ledger build, planning. Cancelled only by explicit user action or a freshness breach, with the reason recorded.
  - `scientific-must-complete`: export and record writing.
- **OB-PR-08** Diagnostics expose queued, running, coalesced, cancelled and completed counts per semantics class. A test proves a scientific task is never coalesced.

---

## 7. Runtime

- **OB-RT-01 Stages:** 0 inputs and eligibility (immediate, no traversal), 1 ray build, 2 traversal, 3 states, 4 frontier and strength, 5 presentation attribute.
  - Stage 0 renders the eligibility verdict (§1.3) before anything runs.
  - When nothing is eligible, the panel says why and offers only an assumed origin.
- **OB-RT-02 Cancellation.** Takes effect within one chunk and leaves nothing half-committed.
- **OB-RT-03 Workers.** Added only when profiling shows stage 2 over 50 ms on the main thread at the medium benchmark. Registered, cancellable, transferring typed arrays, with disposal tested. Worker failure follows the existing budgeted fallback-or-refuse rule.
- **OB-RT-04 Resources.**
  - Every listener, buffer, attribute, overlay, timer, abort controller and cache has an owner and a disposal trigger listed in `docs/disposal-contracts.md` (`lint:disposal-registry`).
  - GPU resources record their `deviceGeneration` and rebuild after device loss.
- **OB-RT-05 Idle cost.** No animation frame is requested because the panel is open. Frames come from `frameDemand` invalidations only.
- **OB-RT-06 Isolation.** With Observatory closed, the existing renderer benchmark shows no regression beyond its tolerance, and the bundle delta on the initial chunk is zero.
- **OB-RT-07 Telemetry stages:** `observation.eligibility`, `.rays`, `.reject`, `.traverse`, `.states`, `.frontier`, `.gain`, `presentation.attribute`, `presentation.upload`, each with p50, p95 and max. Counts cover rays, rejected rays, steps, voxels, bytes uploaded, and coalesced tasks.

---

## 8. Panel, explanation, export

- **OB-UI-01 Panel sections:**
  - Sources: stations, origin status, basis.
  - Evidence: state view, per-source isolate, compare.
  - Shadow: frontier, shadowed and unaddressed totals.
  - Planning: instrument model, candidates, suggestions.
  - Record: methods, parameters, digests, export.
- **OB-UI-02 Badges** use `stateChip` (glyph and word): `DECLARED ORIGIN`, `ASSUMED ORIGIN`, `RECONSTRUCTED ORIGIN`, `SOURCE COMPLETE`, `RESIDENT ONLY`, `SAMPLED`, `SUGGESTED STATION`.
- **OB-UI-03 Voxel probe.** Clicking a point or slice cell shows the voxel's state, every counter per source, the rule row that decided the state, the method tag and the basis. Example:

  ```text
  State: SHADOWED
  Rule: no hit or pass from any source; behind-evidence from 3 of 4
  Station 1  hit 0  pass 0  behind 212   nearest blocker 12.42 m
  Station 2  hit 0  pass 0  behind  88
  Station 3  hit 0  pass 0  behind  17
  Station 4  outside angular domain
  Method: olv.observation.states@1   Basis: full   Authority: measured
  ```

- **OB-UI-04 Candidate probe.** Every Coverage Gain term, plus the instrument model.
- **OB-UI-05 Wording.**
  - Permitted: "observed empty", "shadowed from", "not addressed", "fired, no return", "not read in this load", "suggested station (not observed)", "hit fraction", "strength index".
  - Absent from UI, export and docs: "probability", "confidence", "accuracy" (applied to a field), "optimal", "guaranteed", "complete coverage" (unless basis `full` and zero `NOT_READ`), "free space" (except in a definition that equates it with `OBSERVED_EMPTY`). A test enforces this.
- **OB-EXP-01 Export bundle.** `observatory/` contains:

  ```text
  observation-record.json   (run record, parameters, methods, basis, digests)
  stations.json             (origins with status)
  field.bin + field.json    (header: voxel edge, domain, key layout, counter columns, little-endian; SHA-256 per column)
  state-summary.csv
  frontier.csv
  candidates.csv            (every term)
  processing-manifest.json
  scientific-passport.json
  README.md                 (states defined in the §2.2 words)
  ```

  It is written through the existing zip and manifest modules. Screenshots are not part of the record.
- **OB-EXP-02 Round trip.** The exported `field.bin` re-hashes to `fieldDigest`, and re-deriving states from the exported counters matches the exported state summary.
- **OB-SES-01 Session.** A session stores the parameters and the `fieldDigest`, not the field. On reload it offers a rerun, and marks the result current only when the rerun digest matches.

---

## 9. Validation

### 9.1 Analytic fixtures (generator truth, in repository)

| ID | Fixture | Pass condition |
|---|---|---|
| F1 | One station, wall in front of an open room | Wall `SURFACE`; room behind the wall `SHADOWED`; space in front `OBSERVED_EMPTY`; outside the angular extent `UNADDRESSED` |
| F2 | F1 plus a second station behind the wall | Former shadow becomes `SURFACE` or `OBSERVED_EMPTY`; per-source view of station 1 still shows its shadow |
| F3 | Box present in station A's scan, absent in B's | `CONFLICT`, listing both sources |
| F4 | Porous volume (random partial occupancy) seen from two stations | `PARTIAL`, not `CONFLICT` |
| F5 | PTX with `0 0 0` sky cells | `NO_RETURN_PATH` above, never `OBSERVED_EMPTY` |
| F6 | F1 grid loaded with a stride | Skipped cells give `NOT_READ`; authority not `measured` |
| F7 | Unaddressed pocket | `UNADDRESSED`, not `SHADOWED` |
| F8 | DDA cases: axis-aligned, along faces, grazing corners, zero-length inside one voxel | Traversed voxel lists equal the oracle |
| F9 | F1 with chunk order permuted and worker count varied | Identical `fieldDigest` |
| F10 | F1 with pixel ratio, colour range, overlay mode and panel state varied | Identical `fieldDigest` and export bytes |
| F11 | Coverage Gain: a candidate behind the wall versus a candidate beside station 1 | Behind-wall candidate ranks first; every term matches the oracle |
| F12 | Greedy second suggestion after the first | Second station covers the first's residual shadow; the canonical ledger is unchanged |
| F13 | Unknown linear unit | Field computed in source units; every metric figure withheld |
| F14 | ROI changed mid-run | Commit refused with reason `roi` |
| F15 | Assumed origin | Authority `preview`, labelled in every surface |
| F16 | Multi-return pulse through a canopy | One ray; hits in each return voxel; `pass` only to the first |
| F17 | Degenerate inputs: NaN origin, zero-length ray, empty ROI, one source, 33+ sources (second mask word) | Refused or handled per the documented rule |

### 9.2 Oracles

Standard-library Python oracles:

- Ray–AABB clipping.
- Voxel traversal by exact rational stepping on fixture coordinates chosen to be exactly representable.
- The state table.
- Frontier adjacency.
- Coverage Gain terms.

Registered per OB-INT-09. Production code is never validated only against itself.

### 9.3 Falsification checklist

Each item needs a test showing the implementation cannot do it:

- Label an unaddressed or no-return voxel as empty.
- Produce `CONFLICT` from one source.
- Average `CONFLICT` into `SURFACE`.
- Promote a strided or resident field to `measured`.
- Commit a stale run.
- Let a suggested station enter the ledger.
- Let a presentation setting alter a digest.
- Coalesce a scientific task.
- Fabricate an origin for LAS.
- Rebuild point geometry on a field-only update.
- Show a composite without its weights.

---

## 10. Phases

Each phase opens a ledger entry and closes it with evidence. v0.7 MUST covers O0–O11. Later work is listed after the table.

| Phase | Scope | Exit evidence |
|---|---|---|
| O0 | Audit: fingerprint and gates. Verify every row of §1. Verify E57 record-range contiguity through sanitation, structured-E57 no-return semantics, and PCD viewpoint. Run the frame-demand tests (OB-INT-08). Add `src/observation` to the layer lint. Commit this SPEC. | O0 report; ledger entries; no behaviour change |
| O1 | Types, state table function, freshness stamp, fixture generator, oracles for F8 and the state table | State-table exhaustive test; F8 |
| O2 | Station sidecar (OB-INT-02), after approval | Stations for PTX and E57 fixtures; memory report |
| O3 | Ray builder (OB-RAY) | F5, F6, F16 ray-level |
| O4 | Ledger and traversal (OB-LED) | F8, F9; budget refusal test |
| O5 | States, conflict, shadow, frontier | F1–F7, F17 |
| O6 | Strength components | Component oracle tests |
| O7 | Run record, registry, claims, export, session | OB-EXP, OB-SES; F10, F14 |
| O8 | Presentation colour modes, legend, ranges, slice overlay, probe | OB-PR tests; no-geometry-rebuild test |
| O9 | Panel via coordinator, lazy chunk, badges, wording test | OB-UI tests; bundle delta |
| O10 | Coverage Gain and station suggestion | F11, F12, F15 |
| O11 | Hardening: benchmarks, disposal, device loss, browsers, mobile, full gate | Benchmarks; `npm run test:release` |

Benchmark scenarios:
- **Small:** one PTX, about 100k cells.
- **Medium:** multi-station E57, 1–5M returns.
- **Large:** a streaming or strided source, to exercise `NOT_READ`.
- **Overlay stress:** the slice plane at maximum resolution.

LATER, each gated on something that does not exist yet:
- A reachability provider (Terrain Access).
- Pose consistency for imported cameras or trajectories. Needs an import format decision; Similarity alignment would extend `rigidSolve`, with scale allowed only when the frame is declared scale-free (Umeyama, §12).
- Intake of reconstructed origins, once SensorPrint P6 lands.
- The instanced voxel overlay, if the O8 benchmark favours it.
- The governor switch (OB-INT-07).

A phase with a known correctness defect does not close.

---

## 11. Definition of done

**Agent-completable:**

- Every OB-INV has a test.
- F1–F17 pass against the oracles.
- The state table is exhaustive.
- Digests are stable under F9 and F10.
- Eligibility is stated honestly for every format in §1.3.
- The panel follows the wording rules.
- The export round-trips.
- Disposal and device loss are tested.
- The Observatory-closed benchmark shows no regression.
- The ledger and claims are current.
- `npm run test:release` passes.

**Requires user data:**

- Real multi-station scenes, used to check the preregistered `p_solid`, `p_empty` and `n_min` against field behaviour. For example, a site scanned twice with known changes, which gives a ground truth for `CONFLICT`.

Without them, the verdict cannot exceed `READY WITH DOCUMENTED LIMITATIONS`, and the limitations name exactly this.

---

## 12. Final report format

1. **Baseline:** version, commit, archive SHA, gate state.
2. **Files changed:** each with its purpose.
3. **Eligibility table:** §1.3 as implemented.
4. **Equations and parameters:** as implemented, with protocol file paths.
5. **State counts and digests:** for every fixture.
6. **Oracle agreement.**
7. **Performance:** p50/p95 per stage, memory, upload bytes, bundle delta, Observatory-closed regression check.
8. **Disposal and device-loss results.**
9. **Limitations:** plain statements of fact.
10. **Open ASK items:** with options.
11. **Verdict:** `READY FOR v0.7`, `READY WITH DOCUMENTED LIMITATIONS` or `NOT READY`, with the evidence for it.

---

## 13. References

Verify each against Crossref or the publisher before it enters a registry `citation`. None has been checked yet.

| Reference | Use |
|---|---|
| Amanatides & Woo (1987), *A fast voxel traversal algorithm for ray tracing*, Eurographics '87 | 3D DDA (OB-LED-01). Conference paper; there may be no DOI. |
| Curless & Levoy (1996), *A volumetric method for building complex models from range images*, SIGGRAPH '96 | Line-of-sight carving: empty space from ray passage, unseen space kept apart |
| Scott, Roth & Rivest (2003), *View planning for automated three-dimensional object reconstruction and inspection*, ACM Computing Surveys 35(1) | Framing for station suggestion as view planning |
| Umeyama (1991), *Least-squares estimation of transformation parameters between two point patterns*, IEEE TPAMI 13(4) | Similarity alignment, LATER only |
| Kabsch (1976) / Horn (1987) | Already the basis of `rigidSolve.ts`; cite as that module does |
| ASTM E2807 (E57), PTX format notes, `docs/acquisition-grid.md` | Grid, pose and no-return semantics |
