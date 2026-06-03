# Disposal Contracts

OpenLiDARViewer holds heavy resources across long sessions: GPU buffers,
GPU textures, Web Workers, range-source HTTP clients, event listeners,
animation frame requests, ResizeObservers, MutationObservers, scheduled
timers. Without a clear owner-and-trigger table, those resources leak
silently — a user who opens / closes ten scans in a workday ends up
running on a GPU that thinks they have 80 active point clouds.

This doc names every resource, its owner, its lifetime, and the
explicit disposal trigger. The pure-module half is covered by
`tests/disposalContracts.test.ts`; the surfaces that need a real
browser (Viewer, three.js, streaming workers) are covered by the e2e
long-session spec — see the checklist at the bottom.

## Resource → owner → lifetime → disposal trigger

### Pure modules (tested in `tests/disposalContracts.test.ts`)

| Resource | Owner | Lifetime | Disposal trigger |
| --- | --- | --- | --- |
| Pending `setTimeout` handles in workflow replay | `scheduleReplay` returned `ReplayHandle` | One per workflow event during replay | `handle.cancel()` — idempotent, clears every pending fire |
| Accumulated event list in a recording | `WorkflowSession` | Until the host abandons the session | Drop the reference; the events array has no DOM ties |
| CRS subscriber callbacks | `CrsService._listeners` Set | Per subscription | `unsubscribe()` returned by `subscribe` — idempotent |
| Cached resolved CRS | `CrsService._current` + `_currentDatasetKey` | Per scan | `crsService.clear()` on scan close |
| Per-dataset override entries | `CrsOverrideStore` (localStorage) | LRU-bounded to 100 entries; persists across sessions | `clearOverride(key)` for one, `clearAllOverrides()` for all |
| Action registry rows in palette | `CommandPalette._actions` | Per-host lifetime | `setActions([])` |
| Selection by cloud id (highlight) | `Viewer._selectionSnapshots` | Per highlight | `clearSelectionHighlight()` |

### Viewer / three.js / streaming (covered by the e2e long-session spec)

| Resource | Owner | Lifetime | Disposal trigger |
| --- | --- | --- | --- |
| `THREE.BufferGeometry` per static cloud | `Viewer._clouds` map | Until the cloud is removed | `viewer.removeCloud(id)` → `geometry.dispose()` |
| `THREE.PointsMaterial` per static cloud | `Viewer._clouds` map | Until the cloud is removed | `viewer.removeCloud(id)` → `material.dispose()` |
| `WebGLRenderer` / `WebGPURenderer` GL context | `Viewer._renderer` | Per Viewer instance | `viewer.dispose()` → `renderer.dispose()` + `renderer.forceContextLoss()` |
| `requestAnimationFrame` loop | `Viewer` | Per Viewer instance | `viewer.dispose()` cancels the next frame |
| ResizeObserver on the canvas parent | `Viewer` | Per Viewer instance | `viewer.dispose()` → `observer.disconnect()` |
| COPC decode worker | `CopcWorkerClient` (created lazy in main.ts) | Per session, lazy on first COPC open | `copcDecoder?.terminate()` on close |
| Streaming scheduler / renderer pair | `Viewer._streaming` | Per streaming scan | `viewer.detachStreamingCloud()` → scheduler.dispose() + renderer.dispose() |
| HTTP range-source pending fetches | `HttpRangeSource` | Per streaming scan | `streamingSource.abort()` on detach |
| Color attribute snapshots | `Viewer._selectionSnapshots` | Per highlight | `viewer.clearSelectionHighlight()` |
| MeasureOverlay SVG element | `MeasureController` | Per Viewer instance | `viewer.dispose()` → overlay.remove() |
| LassoVolumeTool SVG overlay | `LassoVolumeTool` | While armed | `lassoVolumeTool.disable()` → SVG removed, listeners detached |
| InspectTool pointer listeners | `InspectTool` | Per Viewer instance | `viewer.dispose()` |
| AnnotationController DOM panels | `AnnotationController` | Per Viewer instance | `viewer.dispose()` |
| `window` event listeners (keydown, resize) | main.ts | Per session | Page reload — no per-scan cleanup needed |
| Scheduled task timers (recorder badge, settle clamp) | individual controllers | Per scope | `controller.dispose()` clears |

## Disposal triggers — when each fires

- **Scan open** (`handleFile`, streaming open):
  Before attaching the new cloud, the previous one is unloaded via
  `closeScan()`. That clears CRS state, clears measurements, drops
  the highlight, and detaches streaming.
- **Scan close** (`closeScan` in main.ts):
  Clears measurements / annotations / inspect mode / probe mode,
  detaches streaming, clears the CRS service, clears the dataset key
  cache, resets the dock to the empty state.
- **Page reload**:
  Browser tears down everything. The session-scoped
  `CopcWorkerClient`, `streamingBenchmark`, and any localStorage-
  backed stores survive (by design); GPU / DOM / timers all die.

## E2E long-session checklist

The pure-module tests catch logic leaks. They cannot observe a
forgotten `geometry.dispose()` because there's no three.js in
vitest. Use the e2e long-session spec for these:

1. **Open / close × 10**: Open the same demo scan ten times in a row.
   Expected: stable point count, no console error, stable memory
   (allow GC noise) per `performance.memory.usedJSHeapSize`.
2. **Cancel mid-load**: Start loading a large COPC, navigate away to
   the empty state before the coarse view fires. Expected: no
   subsequent toast, no stale streaming status poll, scheduler
   detached.
3. **Failed load**: Drop a `.txt` masquerading as `.laz`. Expected:
   error toast, dock returns to empty state, no leaked decode worker.
4. **Streaming detach**: Open a streaming COPC, then open a static
   LAZ. Expected: streaming scheduler disposed before the static
   cloud attaches; `viewer._streaming` is `undefined`.
5. **Worker termination**: After ten COPC opens, only ONE
   `CopcWorkerClient` should exist (it's lazy + session-cached).
   Closing the session via reload terminates the worker.
6. **Texture/buffer disposal**: Spec uses three.js's `WebGLRenderer`
   info hooks (`memory.geometries`, `memory.textures`) — assert
   counts return to baseline after close.
7. **Event-listener cleanup**: Spec uses a wrapped `addEventListener`
   counter to assert per-tool listener add/remove parity.
8. **Lasso re-enable cycle**: Arm / disarm / arm / disarm the lasso
   tool 20 times. Expected: zero net listeners added, single SVG
   overlay in the DOM at any time.

## Adding a new resource

When you introduce a new GPU buffer / worker / timer / listener:

1. Add a row to the table above identifying the owner.
2. Wire the disposal call into the closest existing teardown trigger
   (most often `Viewer.dispose()` or `closeScan()` in main.ts).
3. If the resource is pure-data, add a contract test to
   `tests/disposalContracts.test.ts`.
4. If the resource needs a real browser, add an assertion to the
   long-session e2e spec.

The default assumption is: **a resource without a documented disposal
trigger is a leak**. Reviewers should refuse to merge a PR that adds
one without filling in this table.
