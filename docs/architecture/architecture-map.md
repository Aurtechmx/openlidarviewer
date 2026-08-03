# Architecture map

The module graph as it stands, and the shape the decomposition is moving it
toward. `scripts/lint-layer-boundaries.mjs` enforces the dependency direction
below.

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
| Shell | `src/main.ts` | 6,125 | Wiring. **A monolith under decomposition.** |

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

The exit condition is NOT a line count. A hard line target rewards the wrong
move: you can hit it by relocating view-bound glue into a "host" module that
re-exposes the whole class, which lowers the number without decoupling anything
or gaining a single test. That is the trap this decomposition exists to avoid.

The real condition: **every cluster with a genuine boundary and a Node-test
payoff is extracted and tested, and the irreducibly view-bound remainder is
enumerated below.** A cluster earns extraction when its logic can be decided
without three.js or the DOM. When the only thing left is GPU material setup,
scene-graph wiring, camera manipulation and event plumbing, the file is as
small as it should be, whatever the line count says.

`< 2,500` for `main.ts` and `< 2,000` for `Viewer.ts` remain recorded as a
directional `goal` in `docs/validation/monolith-size-baseline.json`, but no
guard enforces them. What IS enforced (`lint:monolith-size`) is that neither
file may GROW: the counts ratchet down only, so a decomposition step cannot be
quietly undone, and no vanity extraction is forced to chase a number.

### Extracted this cycle, each with Node tests it could not have before

- `computeLassoVolume` → `src/render/measure/lassoVolumeCompute.ts` (8 tests)
- the two-finger tracker → `src/render/touchTracker.ts` (11 tests)
- the render-frame decision → `src/render/renderActivityGate.ts` (9 tests)

Moved for locality rather than testability: the panel column's layout chrome
(measure-bar and dock clearance, the rail collapse, panel wheel containment)
now lives in `src/ui/panelChrome.ts`. It is ResizeObserver and CSS custom
property work with no logic a Node test could decide, but it is panel geometry,
so it belongs beside the panels.

### Checked and deliberately NOT extracted

Recorded so the next pass does not re-derive them:

- **The filter cluster** (`_classFiltered`, `_elevFilter*`, `_intenFilter*`) —
  not CPU predicates. They are three.js shader uniforms folded in a TSL pass;
  there is no Node-testable logic to lift.
- **Classification history** (`_classEpochs`, `_classHistory`) — its substance
  (`ClassEditHistory`, `ClassificationEpochs`, `applyClassSwap`,
  `applyPolygonReclassify`) is ALREADY extracted and tested. What remains on the
  Viewer is a thin GPU-upload wrapper.

**`src/main.ts` (6,125)** — the largest blocks, which are the extraction
candidates:

`buildActionRegistry` (344 lines) is now extracted to `src/app/actionDefinitions.ts`,
called with a 19-member deps object. The candidates that remain:

| Block | ~Lines | Extraction target |
|---|---:|---|
| `seedStreamingFilterExtents` | 338 | streaming panel wiring module |
| `syncInspectorVisuals` | 266 | inspector wiring module |
| `applyScanRoute` | 233 | joins `ScanRouteService` |
| `generateReportPdf` / `exportGeoContext` | 402 | export/report wiring module |

Done: `importSession` (~208 lines) now lives in `src/app/sessionIo.ts`, called with a
`SessionIoDeps` object of ~16 accessors the shell binds to its own state. The pure
cloud→fingerprint adapter (`scanFactsFromStreaming` / `scanFactsFromStatic`) is
exported and Node-tested, and the parse/verify/rebase halves it leans on already
lived in `src/io/session.ts`; `main.ts` keeps a thin caller (`tests/sessionIo.test.ts`).

Done: `handleFile` (~336 lines) — the open/load pipeline — now lives in
`src/app/openScan.ts` as `openScan(file, deps)`, driven through an `OpenScanDeps`
object of accessor functions closing over the shell's services rather than the
Viewer class. The two genuinely pure decisions it made are extracted and
Node-tested — `layerChipCount` (the file-total vs strided-display count the Layers
chip shows) and `shouldResetSavedWork` (fresh-project vs additive open) — alongside
the three-way router's session / COPC / static dispatch (`tests/openScan.test.ts`).
`main.ts` keeps a thin `handleFile` delegate that binds its running state to the deps.

Done: `handleRemoteEpt` / `openStreamingCopc` (~406 lines) — the remote / streaming
open pipeline — now live in `src/app/openStreaming.ts`, driven through an
`OpenStreamingDeps` object of accessor functions closing over the shell's services
and its mutable streaming-session state (the load flag, the COPC / EPT decode
workers, the benchmark collector, the quality preset) rather than the Viewer class.
The pure decisions the extraction exposes are Node-tested — `isEptUrl` (the
COPC-vs-EPT routing predicate the shell's URL router dispatches on), `isAbortError`
(the user-cancel classifier both remote handlers surface through) and
`linkAbortSignals` — alongside the guarded remote-open paths: the one-load guard, the
URL-validation gate, and the honest error surfacing (`tests/openStreaming.test.ts`).
The SSRF URL validation (`validateRemoteEptUrl` / `validateRemoteCopcUrl`) is
preserved exactly. `main.ts` keeps thin `openStreamingCopc` / `handleRemoteEpt`
delegates that bind its running state to the deps.

**`src/render/Viewer.ts` (6,419)** — the constructor and a handful of large
methods dominate:

Spans below are the symbol's real extent, read from the TypeScript symbol graph
rather than estimated by pattern-matching — an earlier revision of this table
overstated `_onResize` by 10× and listed a colour-write block that had already
been extracted, and both errors pointed the decomposition at the wrong work.

| Block | Lines | Extraction target |
|---|---:|---|
| `constructor` | 564 | staged scene/pipeline builders |

Done: the per-frame render loop body (`_startLoop`, 107 lines) now lives in
`src/render/renderLoop.ts` as `runRenderFrame(host)` behind a structural
`RenderLoopHost`, so the paint-path choice, the EDL snap-back on settle, the
streaming tick cadence and the tool-overlay gating test against a fake host
without a WebGL or rAF context (`tests/renderLoop.test.ts`). `Viewer` keeps a
thin `_startLoop` that binds its state to the host and owns the
requestAnimationFrame scheduling (browser-only, e2e-covered).

Done: `_buildExportAdapter` (265 lines) now lives in `src/render/exportAdapter.ts`,
which takes a structural host rather than the Viewer, so the Studio's scene
reads are unit-testable without a WebGL context (`tests/exportAdapter.test.ts`).
`Viewer` keeps a twelve-line factory that binds its own state to that host.

Done: the colour-legend / scalar-range reads (`activeColorbar`, `elevationExtent`,
`intensityExtent`) now live in `src/render/colorLegend.ts` behind the same host
shape, so the origin math, seeded gating and extent scans test without a WebGL
context (`tests/viewerActiveColorbar.test.ts`). `Viewer` keeps three thin
delegates and one host binding.

Done: the `snapshot` capture pipeline (and its four overlay-compositing draw
helpers) now lives in `src/render/snapshot.ts` behind a structural
`SnapshotHost`, so the option resolution, fast-path decision and `toBlob`-null
error path test without a canvas context (`tests/snapshot.test.ts`). The
overlay-compositing branch still needs a real 2-D canvas and stays on the e2e
export suite. `Viewer` keeps a one-line delegate and a host binding.

Each extraction is one gated step: move the block, have it take its collaborators
as parameters, keep the deterministic e2e project green, and re-run the coverage
ratchet. Behaviour does not change; only where the code lives.

The file is long because of breadth (roughly 110 fields and 200 methods), not
because a few blocks are large, so the line count falls slowly even as the
testable logic leaves. That is expected and fine: the goal is the extractions
above, not the number.

**One substantial cluster with a real boundary remains: streaming**
(`_streaming*`). It is cohesive in *state* but not yet in *behaviour* —
`attachStreamingCloud` passes the Viewer itself to `StreamingRenderer` as host
and reaches into nav, camera, measure-datum and colour-context, so it moves
only behind an explicit host interface, the same shape used for the export
adapter and the lasso walk. That is the next decomposition step worth taking.
The EDL cluster (`_edl*`) is a smaller follow-on. Everything else on the class
— the constructor's scene/pipeline build, the render loop's requestAnimationFrame
scheduling, event wiring — is the irreducibly view-bound remainder, and belongs
here.

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
