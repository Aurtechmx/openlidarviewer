# Float64 project-frame: current architecture and the remaining fold

This tracked the on-ramp for coordinate-integrity roadmap P1 #2 ("Stop writing
project offsets into Float32 vertices"). Its original premise — that mounting a
layer rewrites the Float32 position buffer, and that 162 `.positions` reads must
be migrated together in one atomic change — is SUPERSEDED. The placement
architecture in `docs/architecture/float64-transform.md` (steps 1–5) has landed:
mounting is a Float64 placement now, not a buffer rewrite. What follows records
the architecture as it stands and the one fold that is still browser-gated. The
inventory further down is kept as the historical surface the migration was
planned against; `scripts/lint-positions-reads.mjs` (`npm run
lint:positions-reads`) still prints the live `.positions` list and is a report,
never a gate.

## Current architecture (the premise this document opened with is retired)

Mounting a layer no longer touches its vertices. `Viewer.setLayerPlacement`
stores the layer's Float64 `sourceToProject` translation on the layer entry and
sets `mesh.position`; the `.positions` buffer is written once, by the loader, and
is byte-identical through mount, unmount, hide, session restore and export
(`float64-transform.md` invariant 1, pinned by
`tests/sourceGeometryImmutable.test.ts`). The destination shape every review
named is therefore already in place for the DATA MODEL: vertices stay
source-local, and the placement is data ABOUT the layer, held beside the buffer
rather than baked into it.

The world coordinate is recovered per boundary, in the frame each one names:

- Source-frame consumers read `positions[i] + sourceOrigin` — `worldXYZ`,
  `cloudToGlobal`, the exporters through `exportGeoContext`'s `sourceOrigin`, and
  the two-epoch change comparison through each epoch's own `sourceOrigin`
  (`main.ts` ~5936). These are world-correct under any mount: `sourceOrigin` is
  fixed at construction and the placement never enters the sum.
- Project-frame consumers fold the layer translation into their shared
  accumulator instead of moving the points. The picking ray drops into the
  layer's source frame and the hit lifts back (`layerPlacement.ts`), terrain
  gather adds `accumulatorOffset(placement)` per buffer as it copies into the
  shared grid (`terrainStreamSample.ts:99,108`), and the scene-bounds merge
  translates each layer's cached AABB (`mergePlacedBounds`). With one layer — or
  while a mount is refused — every translation is the identity, so these folds
  are byte-identical to the pre-fold walk.

`src/model/LayerSpatialState.ts` remains an unreferenced scaffold: the runtime
adopted the `PointCloud.worldXYZ` / `projectXYZ` accessors and the
`layerPlacement.ts` fold toolbox rather than a per-layer container, so nothing
imports it outside its own unit test.

## The remaining fold is not the whole GPU path

Two things are still browser-gated (`float64-transform.md` step 6, and the
acceptance battery in `coordinate-integrity-roadmap.md` P1 #1):

1. **The renderer's camera-relative / render-origin fold.** Mesh position is
   `sourceToProject` today; for far-apart mounts it should become
   `sourceToProject − renderOrigin`, folded on the CPU per mesh, so the Float32
   GPU residual stays small. Bounded and refused past 1 mm by the `LayerService`
   mount-precision gate, so this is a precision refinement, not a correctness
   defect.
2. **The display-coordinate fold for picking and cross-layer measurement.** The
   inspector's world coordinate is built in `Viewer._infoForHit`
   (`src/render/Viewer.ts` ~6087) as the PLACED (project-local) pick point plus
   `sourceOrigin`. For a non-anchor mounted layer that double-counts the
   translation — the coordinate is off by the full `sourceToProject` (2 km in
   `tests/e2e/twoScanMount.spec.ts`'s fixture), because the placed point already
   carries the offset. It is correct only under the identity placement, which is
   why it is invisible single-layer and while mounting stays effectively off. The
   fix is to derive the world coordinate from the source-local hit index —
   `cloud.worldXYZ(index)` is already the right value — rather than the placed
   point; the same applies to a measured vertex on a non-anchor layer exported
   through the active scan's `sourceOrigin`. Tracked as roadmap P1 #1 acceptance
   items #4 (picking) and #5 (cross-layer measure), and pinned as a property by
   `tests/frameWorldCoords.test.ts`.

## Method

`scripts/lint-positions-reads.mjs` walks every non-test `.ts` under `src/`,
excludes `src/model/` (where `PointCloud` legitimately owns the buffer and the
`worldXYZ` / `projectXYZ` accessors), strips comments, and counts `.positions`
occurrences. It counts through `scripts/lib/positionReads.mjs`, the single
module the enforcing ratchet `lint:position-access` and the doc cross-check
`lint:architecture-truth` also count through, so a change to what counts as a
read cannot land in one scanner and miss the others.

The scanners report two totals, and the difference is scope, not disagreement:

| Scope | Covers | Who reports it |
|---|---|---|
| `outside-model` | `src/` minus `src/model/` and `*.test.ts` | this plan, `lint:positions-reads`, `lint:architecture-truth` |
| `all-src` | all of `src/` minus `*.test.ts` | `lint:position-access` (the gate) |

The gate's number is the larger one because it also counts the reads inside
`src/model/`, where the accessors this plan migrates consumers ONTO are built. A
frame mistake there is wrong everywhere at once, so the gate has to see it. This
plan's number is the migration surface, which is consumers only.

Measured, `outside-model`: 135 direct `.positions` reads across 37 files. Both
numbers are regenerated from the tree rather than quoted from memory, because
they drift as code moves — they rose to 162 across 43 files while the placement
architecture was landing, and have since fallen as consumers moved onto the
accessors. Run `npm run lint:positions-reads` for the live list with
`file:line`.

Two categories are counted but are not consumer reads to migrate:

- Loader write: `src/io/lasDecodeShared.ts:151‑153` writes the freshly
  allocated buffer. That is the one legitimate writer (float64-transform.md
  invariant 1: `positions` is written exactly once, by the loader), not a reader.
- Comment mentions (4, already excluded from the count above): `src/geo/placementIterator.ts:8`,
  `src/render/Viewer.ts:1724`, `src/render/streaming/StreamingScheduler.ts:294`,
  `src/render/measure/measureDerivations.ts:59`. These are prose about the field,
  not call sites.

## The surface, bucketed by concern

HISTORICAL SNAPSHOT, at 162 reads across 42 files. This is the surface the
migration was planned against, kept because the buckets are what the phases
below are ordered by; it is not the live count and the `file:line` references
have moved. The live list is `npm run lint:positions-reads`.

Counts are `.positions` occurrences (a line may hold more than one). `main.ts`
and `Viewer.ts` span several concerns and are split by line.

| Bucket | Reads | Where (`file:line`, representative) |
|---|---:|---|
| render / GPU | 49 | `render/Viewer.ts` mesh-buffer build (1362‑1534, 1745, 1985, 2435‑2517, 3153); `render/streaming/StreamingRenderer.ts:267,316,381`; `render/streaming/fullCloudGradeAdapter.ts:104,106,109` |
| loading / decode (IO) | 17 | `io/loadLas.ts:184,193,204`; `io/lasDecodeShared.ts:151‑153` (loader write); `io/load{E57,Gltf,Obj,Pcd,Ply,Pts,Ptx,Xyz}.ts` (1 each); `io/parseWorker.ts:60,74`; `io/copc/copcChunkDecode.ts:191` |
| colour modes / classification | 17 | `render/colorModes.ts:718,825,874,894,911`; `render/streaming/streamingColors.ts:134,201,209`; `render/elevationRange.ts:143,144`; `render/{densityColors,hillshadeColors,localDensitySize}.ts`; `render/measure/classificationEditor.ts:189`; `main.ts:1704,1791,3783` |
| picking / inspect / snap | 16 | `render/patchView.ts:317‑404`; `render/Viewer.ts:5850,5858,5964,5967`; `render/InspectTool.ts:575`; `render/streaming/streamingPickSelection.ts:131`; `main.ts:3534` |
| terrain gather / scan-shape | 15 | `app/terrainAnalysisRunner.ts:315,412,419`; `main.ts:2655,2659,3308,3325,3398,3415,3429`; `analysis/modules/scanReport.ts:119`; `terrain/worker/terrainCoreWorker.ts:50` |
| lasso | 15 | `render/measure/lassoVolume.ts:69‑352`; `render/measure/lassoVolumeCompute.ts:139,170`; `render/Viewer.ts:3197,3207,3212` |
| volumes | 9 | `render/measure/volume.ts:269,324‑326`; `render/measure/stockpileVolume.ts:227,230‑232,294` |
| other, health / QA | 7 | `analysis/modules/healthCheck.ts:54,55,171,199,206` |
| change detection | 6 | `terrain/change/alignEpochs.ts:278,279,338`; `terrain/change/compareEpochs.ts:119,120,148` |
| clipping | 3 | `render/clip/clipCloud.ts:45`; `render/Viewer.ts:2589,2590` |
| export bounds / compare | 3 | `main.ts:6602,6610,6625` |
| downsampling / snapshot | 2 | `process/voxelDownsample.ts:44`; `render/streaming/residentSnapshot.ts:74` |
| conversion | 2 | `convert/convertCloud.ts:93`; `convert/globalPoints.ts:44` |
| profiles | 1 | `render/measure/profileSampler.ts:409` |
| Total | 162 | across 42 files |

Not every read needs the transform. Many buckets (volumes, density, colour by
elevation, profile sampling) do purely source-local maths and are CORRECT
reading Float32 source-local coordinates. They migrate only to move off the raw
field and onto the accessor, not because their result changes. The transform is
load-bearing at the boundaries that produce a WORLD or PROJECT coordinate:
picking, terrain gather into a shared grid, cross-layer measurement, export
bounds, change detection, and the renderer's mesh placement. The
`lint:position-access` header records the same finding.

## Migration order

Three phases, each independently landable, the last one alone flipping behaviour.

### (a) `LayerSpatialState`, the container (landed as scaffold)

`src/model/LayerSpatialState.ts` holds the layer's source-local vertices beside
a Float64 `sourceToProject` / `projectToSource` translation. Vertices are never
rewritten; placement is data ABOUT the layer. Pinned by
`tests/layerSpatialState.test.ts`: exact Float64 round trip source to world at
survey scale, and bit-identity under the zero (single-layer) translation.

It sits beside the frame value types already shipped in
`src/geo/ProjectSpatialFrame.ts` (`ProjectSpatialFrame`, `LayerSpatialTransform`,
`layerTransform`, and the pure source/project/world maths). `LayerSpatialState`
is the piece that binds those translations to a concrete buffer. It is
deliberately unreferenced, so this step changes no runtime and no e2e byte.

### (b) The world-space accessor, one file at a time

`layerWorldPosition(state, index, out)` is the read every CPU consumer moves to,
and `layerSourcePosition` is its exact inverse for the picking direction. Because
the shipped single-layer build carries the identity translation, each consumer's
move is a provable no-op at the time it lands, exactly the property every prior
accessor batch relied on (`worldXYZ`, `projectXYZ`).

Order within (b), boundaries before bulk:

1. Coordinate-producing boundaries first: picking, terrain gather into the
   shared grid, cross-layer measurement, export bounds, change detection. These
   are where a wrong frame misplaces a deliverable.
2. Then the source-local-correct buckets (volumes, colour modes, density,
   profiles, downsampling), which move for uniformity, not correctness.
3. `lint:position-access` (the shrink-only ratchet, separate from the
   report-only `lint:positions-reads`) banks each file as its count drops to
   zero, so a migrated reader can never silently reacquire a raw `.positions`
   read.

### (c) The GPU path last

The renderer's mesh-buffer build (`render/GPU`, the largest bucket at 49) is the
only consumer that genuinely wants Float32, and the only one where
camera-relative or high-low-split rendering is a real design choice rather than a
precision compromise. It moves last: mesh position becomes
`sourceToProject − renderOrigin`, the Float64 fold done on the CPU per mesh
(three values per layer per frame, not per point), GPU staying Float32.

## The invariant that makes this one change, not several

Between the first migrated consumer and the last, the renderer and the CPU
consumers must never disagree about which frame a point is in. That is why (b)
lands atomically across the whole surface and (c) flips only once (b) is
complete. A partially migrated tree is strictly worse than today's: today every
consumer agrees and the residual error is bounded and refused past 1 mm by the
`LayerService` mount gates; mid-migration they disagree and the error is
unbounded and silent. The regression net is the property suite in
`tests/frameGateProperties.test.ts` (world-position invariance, source-origin
immutability, restore round-trips) together with `tests/layerSpatialState.test.ts`
for the container and accessor.
