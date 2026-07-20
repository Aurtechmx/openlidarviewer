# Stabilization and decomposition release — plan

The release after v0.6.0-alpha.1 is a stabilization and decomposition release,
not a feature release. It shrinks the two monoliths, finishes the composition
root, wires the authoritative project frame, and raises the test and evidence
floor. Feature work waits behind it.

## Baseline (measured at the start of the branch)

| Goal | Metric now | Target |
|---|---|---|
| 1. `AppRuntime` extraction | **Done.** `LayerService`, `viewBookmarks`, `ScanService`, `ScanRouteService` (plus `crsCoordinator`, `terrainAnalysisRunner`, `inspectorCardRefreshers`, `staleChunkReload`) all own their cluster against `AppContext`; no module-level mutable app-state remains in `main.ts` | no module-level mutable app-state; each cluster owned by a service against `AppContext` |
| 2. `main.ts` | 7,587 lines | < 2,500, with a lint guard |
| 3. `Viewer.ts` | 7,297 lines | < 2,000, with a lint guard |
| 4. Project frame wired | foundation + wiring plan only (`project-spatial-frame.md`) | every layer mounts through `LayerSpatialTransform`; schema v8; two-scan browser proof |
| 5. E2E split | one Playwright project (`chromium`); no deterministic/GPU tag split | a blocking `deterministic` project and an advisory `gpu` project; CI blocks only on deterministic |
| 6. Green exact-commit CI record | alpha.1 merge ran green, not recorded as an artifact | a committed record: workflow run URL + tagged SHA, green on that exact commit |
| 7. Coverage + mutation gates | none (no coverage script, no Stryker) | coverage threshold on the pure modules; a mutation gate on the highest-value ones with a surviving-mutant budget |
| 8. Architecture docs synced | `project-spatial-frame.md`, `v0.5.8-cleanup-plan.md` | an architecture map + every arch doc updated to the post-decomposition structure; a drift check |
| 9. External comparison | `crossCheck` harness + `cross-implementation.md` exist; every `REFERENCE_SLOT` is `pending` | at least one slot moved to a real committed reference → E4 for one terrain or measurement product |

## Sequencing (dependency-ordered)

Enablers land first so the decomposition is measurable and safe, then the
decomposition core, with the browser- and workstation-gated items interleaved
where they belong.

1. **E2E split (5)** — tag specs, add the two Playwright projects, make CI block
   only on the deterministic set. Prerequisite for a trustworthy CI record (6)
   and for mutation gates that run against a stable suite (7).
2. **Coverage + mutation floor (7)** — add a coverage script and threshold on the
   pure modules now; add the mutation gate on the highest-value pure modules
   (numerics, quantile, terrain derivatives, measure, crs, streaming budget).
3. **Architecture map (8)** — write the current-state map so the decomposition
   has a target shape, then keep every arch doc in step as modules move.
4. **Finish `AppRuntime` (1)** — *done.* `savedViews`, `activeId`, and
   `scan-route` now live behind services against `AppContext`.

   What it bought, stated honestly: the line count barely moved (7,587 → 7,574),
   because the first two clusters were already on `AppContext`. The value is
   coupling — every mutation goes through a service, eleven repeated
   `activeId ? getCloud(activeId) : null` lookups collapsed into `activeCloud()`,
   the duplicated `overridden || typeOverride !== 'auto'` predicate became
   `routing.pinned`, and each cluster is unit-tested in isolation. That is the
   prerequisite for steps 5 and 6: the orchestration blocks can now close over
   services instead of file-scope mutables, which is what finally makes them
   movable.

   One pattern worth carrying forward: expose read state as **getters**, not
   methods. Converting `activeId` to a method silently defeated TypeScript's
   narrowing at every `if (activeId) use(activeId)` call site.
5. **Shrink `main.ts` < 2,500 (2)** — move orchestration into the services from
   step 4 and into focused modules (export wiring, compare wiring, streaming
   panel builder), one gated extraction at a time; add the line-count guard when
   the target is reached.

   **First extraction, already scoped: `buildActionRegistry`** (`main.ts`
   1997–2345, 424 lines, called once at 2346). Its dependency surface was
   measured rather than guessed — 23 top-level bindings — and only three of them
   need indirection:

   - `viewer` — a `let` assigned after boot, so pass `getViewer()`.
   - `compassEnabled` — a mutable `let` read by a toggle action, so pass
     `isCompassEnabled()`.
   - `dock` — a `const` declared at 2486, i.e. **after** the call site. Passing
     it by value throws on the temporal dead zone; pass `getDock()`.

   The remaining twenty are hoisted `function` declarations or `const`s already
   initialised above the call site, so they pass directly. Name the module
   `src/app/actionDefinitions.ts`, not `actionRegistry.ts`: `src/ui/actionRegistry.ts`
   already owns the pure `Action` model (`rankActions`, `groupBySection`,
   `findDuplicateIds`), and two files with one name is how a boundary rots.

   Verify with the deterministic e2e project — `commandPalette.spec.ts` and the
   keyboard-shortcut specs cover this block, which is why it is a safe first
   move despite touching every shortcut.

   A 23-member dependency object is not a tidy result; it is an honest one. It
   measures how much of the shell one block reaches into. The follow-up is
   splitting the registry by section (Camera / View / Tools / Workflow) so each
   group carries only the handful of collaborators it actually needs.
6. **Shrink `Viewer.ts` < 2,000 (3)** — extract the streaming attach/tick, the
   pick/measure adapters, the colorbar/range logic, and the export adapter into
   collaborators the viewer composes; add the line-count guard when reached.
7. **Wire the project frame (4)** — the six steps in `project-spatial-frame.md`,
   several browser-verified.
8. **CI record (6)** and **external comparison (9)** — the release-gate
   artifacts, recorded on the exact tagged commit and a real reference file.

## Acceptance criteria

- **1** No module-level mutable application state remains in `main.ts`; each of
  `activeId` / `savedViews` / `scan-route` is owned by a service with a unit test.
- **2/3** `wc -l src/main.ts` < 2,500 and `wc -l src/render/Viewer.ts` < 2,000,
  enforced by a `lint:file-size` check in the release gate. No behaviour change:
  the full e2e suite stays green across every extraction.
- **4** Every layer mounts through its `LayerSpatialTransform`; a two-scan
  fixture renders at true relative offset (browser); session schema v8 round-trips;
  the `KNOWN_LIMITATIONS` "foundation, not active" entry flips to active.
- **5** `playwright.config` has `deterministic` and `gpu` projects; CI runs the
  deterministic project as a required check and the gpu project as advisory.
  Every spec is tagged; an untagged spec fails a lint.
- **6** `release/CI_RECORD_vX.Y.Z.md` records the green workflow run URL and the
  tagged SHA; the SHA matches the tag.
- **7** `npm run coverage` enforces a per-module threshold on the pure set; a
  Stryker run on the highest-value modules meets a surviving-mutant budget,
  wired as a (initially advisory) gate.
- **8** `docs/architecture/architecture-map.md` describes the post-decomposition
  module graph; a doc-drift check fails if a named module path no longer exists.
- **9** At least one `REFERENCE_SLOT` ships a real committed reference file and
  the matching product reads E4 in the claim register; the generation command is
  recorded next to the fixture.

## In-sandbox vs. workstation / browser

Honest split, so nothing gets claimed before it is verified:

- **In-sandbox, fully gated here:** 1, 2, 3, 5, 7 (setup), 8, and the Node-gated
  steps of 4.
- **Browser-verified (needs a real GPU/preview):** the visual steps of 4, and
  any decomposition that touches the render loop is confirmed against the e2e
  suite plus a manual look.
- **Workstation step (native tools):** 9 (PDAL/GDAL/CloudCompare reference
  generation) and 6 (the CI run happens on GitHub Actions, recorded here).
