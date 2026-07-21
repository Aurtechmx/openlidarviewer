# Architecture map

The module graph as it stands, and the shape the decomposition is moving it
toward. Companion to [stabilization-release-plan.md](./stabilization-release-plan.md);
`scripts/lint-layer-boundaries.mjs` enforces the dependency direction below.

## Dependency direction

```
core math  →  science domain  →  application services  →  UI adapters  →  views
```

The rule the linter enforces: **science and core must never import UI or
three.js.** `src/terrain`, `src/validation`, `src/analysis` and `src/science`
stay DOM-free and worker-safe, so a numeric module can run in a worker or a Node
test without dragging a renderer behind it. Everything in this document exists to
keep that arrow pointing one way.

## Layers

| Layer | Path | Size | Role |
|---|---|---:|---|
| Core numerics | `src/process`, `src/numeric.ts`, `src/units` | ~540 | Compensated sums, Welford, unit types. No dependencies. |
| Model | `src/model` | ~490 | `PointCloud`, layer model. Plain data. |
| Geo | `src/geo` | ~2.5k | CRS math, `ProjectSpatialFrame`, transforms. |
| Science domain | `src/terrain`, `src/validation`, `src/analysis`, `src/science` | ~30.8k | Ground filtering, DTM, contours, derivatives, hold-out RMSE, evidence model. **UI-free by lint.** |
| I/O | `src/io` | ~13.6k | Format loaders (LAS/LAZ/PLY/PCD/PTX/E57/…), COPC + EPT streaming sources, range transports, session. |
| Render | `src/render` | ~38k | three.js/WebGPU scene, streaming scheduler, measurement tools, colour modes. |
| Export / report | `src/export`, `src/report`, `src/convert` | ~9.3k | Studio exporters, PDF/report builders, batch conversion. |
| Application services | `src/app` | ~1.6k | Composition root and the services that own shared state. |
| UI | `src/ui` | ~19.9k | Panels, Inspector, Studio surfaces, onboarding. |
| Shell | `src/main.ts` | 7,574 | Wiring. **A monolith under decomposition.** |

## Composition root

`AppRuntime` (`src/app/AppRuntime.ts`) is created once at boot and owns one
`AppContext` (`src/app/appContext.ts`), which holds the shared mutable state
grouped into clusters. Each cluster has exactly one service that owns its
mutation:

| Cluster | Service | Owns |
|---|---|---|
| `layers` | `LayerService` | Visibility intent, solo isolation, CRS mismatch flags |
| `viewBookmarks` | `viewBookmarks` | Saved views: add / get / remove / rename / restore / clear |
| `scan` | `ScanService` | Active-scan selection, and the `activeCloud()` lookup |
| `scanRoute` | `ScanRouteService` | Route pinning, manual scan type, re-route debounce |
| `projectFrame` | `projectFrame` | The shared project origin and each layer's transform into it |

Supporting services in the same layer: `crsCoordinator`, `terrainAnalysisRunner`,
`inspectorCardRefreshers`, `staleChunkReload`.

No module-level mutable application state remains in `main.ts`. That is what makes
the next step possible: a block of orchestration can now move into its own module
and close over services, instead of closing over file-scope `let`s that pin it in
place.

## The two monoliths, and the target shape

These are the decomposition targets. `main.ts` must reach < 2,500 lines and
`Viewer.ts` < 2,000, each with a lint guard once achieved.

**`src/main.ts` (7,630)** — the largest blocks, which are the extraction
candidates:

| Block | ~Lines | Extraction target |
|---|---:|---|
| `buildActionRegistry` | 424 | `src/app/actionDefinitions.ts` *(planned)* — command/action definitions |
| `seedStreamingFilterExtents` | 338 | streaming panel wiring module |
| `handleFile` | 336 | `src/app/openScan.ts` *(planned)* — the open/load pipeline |
| `containPanelWheel` | 293 | `src/ui/` behaviour helper |
| `toClassBuffer` | 268 | `src/model/` or `src/render/class/` |
| `syncInspectorVisuals` | 266 | inspector wiring module |
| `applyScanRoute` | 233 | joins `ScanRouteService` |
| `handleRemoteEpt` / `openStreamingCopc` | 406 | `src/app/openStreaming.ts` *(planned)* |
| `generateReportPdf` / `exportGeoContext` | 402 | export/report wiring module |
| `importSession` | 177 | `src/app/sessionIo.ts` *(planned)* |

**`src/render/Viewer.ts` (7,259)** — the constructor and a handful of large
methods dominate:

Spans below are the symbol's real extent, read from the TypeScript symbol graph
rather than estimated by pattern-matching — an earlier revision of this table
overstated `_onResize` by 10× and listed a colour-write block that had already
been extracted, and both errors pointed the decomposition at the wrong work.

| Block | Lines | Extraction target |
|---|---:|---|
| `constructor` | 564 | staged scene/pipeline builders |
| `computeLassoVolume` | 159 | `src/render/measure/` |
| `snapshot` | 143 | `src/render/snapshot.ts` *(planned)* |
| `_startLoop` | 107 | `src/render/renderLoop.ts` *(planned)* |

Done: `_buildExportAdapter` (265 lines) now lives in `src/render/exportAdapter.ts`,
which takes a structural host rather than the Viewer, so the Studio's scene
reads are unit-testable without a WebGL context (`tests/exportAdapter.test.ts`).
`Viewer` keeps a twelve-line factory that binds its own state to that host.

Each extraction is one gated step: move the block, have it take its collaborators
as parameters, keep the deterministic e2e project green, and re-run the coverage
ratchet. Behaviour does not change; only where the code lives.

**The four blocks left total ~973 lines**, so extracting all of them leaves
`Viewer.ts` near 6,060 — the file is long because of breadth (roughly 110 fields
and 200 methods), not because a few blocks are large. A sub-2,000 target needs
whole *clusters* to move, not the largest methods. The cohesive candidates, by
field prefix, are streaming (`_streaming*`), filters (`_classFiltered`,
`_elevFilter*`, `_intenFilter*`, `_materialsWith*`), EDL (`_edl*`),
classification (`_classEpochs`, `_classHistory`), input (`_pointer*`,
`_activeTouches`, `_onCanvas*`), and the render loop (`_rafId`, `_frame*`,
`_adaptiveDpr`). Note that the streaming cluster is cohesive in *state* but not
in *behaviour*: `attachStreamingCloud` passes the Viewer itself to
`StreamingRenderer` as host and reaches into nav, camera, measure-datum and
colour-context, so it cannot move without an explicit host interface.

## Test and gate topology

- **Unit / integration** — `tests/*.test.ts`, run in sharded buckets
  (`scripts/test-bucket.mjs`) because one large vitest process can fail to
  terminate on a constrained runner.
- **End-to-end** — `tests/e2e/*.spec.ts`, split into two Playwright projects:
  `deterministic` (blocking, 165 tests) and `gpu` (advisory, `@gpu`-tagged).
  Untagged specs block by default.
- **Coverage ratchet** — `npm run coverage`, scoped to the pure modules only.
- **Mutation** — `npm run mutation`, scoped to the numeric core.
- **Release gate** — `npm run test:release` runs static checks, lints, build,
  bundle budget, every bucket, and the smoke specs; it prints a literal
  `GATE EXIT:` line, which is the only trustworthy signal.

## Keeping this document honest

Every module path named above is checked by `tests/architectureMap.test.ts`: if a
path disappears or moves, the test fails and this page must be updated in the same
change. A map that drifts from the tree is worse than no map.

One convention makes that work: a destination marked *(planned)* is an extraction
target that does not exist yet, and the check skips it. When the extraction lands,
drop the marker — from then on the path is held to account like any other.
