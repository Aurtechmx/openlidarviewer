# Float64 project-frame migration: inventory and order

The on-ramp for coordinate-integrity roadmap P1 #2 ("Stop writing project
offsets into Float32 vertices"). This document is additive. It names the surface
and fixes the order. It migrates nothing. The scaffold it points to
(`src/model/LayerSpatialState.ts`) is unreferenced at runtime, and the running
companion (`scripts/lint-positions-reads.mjs`, `npm run lint:positions-reads`)
is a report, never a gate.

## Why an inventory before a line of migration

Today mounting a layer applies the project offset by rewriting the Float32
position buffer, so a consumer that reads `cloud.positions` and one that reads
the mesh see the same frame. The destination keeps vertices source-local and
holds the placement as a Float64 translation applied at read time, which only
stays coherent if every reader moves together. Migrate half and rendering sees
project space while the rest sees source-local: the render/CPU split the data
rebase exists to close, reintroduced, now unbounded and silent instead of
bounded and refused-past-1 mm. So the whole surface has to be visible first, and
the move is one atomic change, not a trickle. This file is that surface.

## Method

`scripts/lint-positions-reads.mjs` walks every non-test `.ts` under `src/`,
excludes `src/model/` (where `PointCloud` legitimately owns the buffer and the
`worldXYZ` / `projectXYZ` accessors), strips comments, and counts `.positions`
occurrences the same way the enforcing ratchet `lint:position-access` does.

Measured: 162 direct `.positions` reads across 42 files. The 42 files match the
figure the roadmap recorded. The occurrence count has drifted up from 154 as the
code moved, which is why the count is regenerated from the tree rather than
quoted from memory. Run `npm run lint:positions-reads` for the live list with
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
