# OpenLiDARViewer — Implementation Plan

> **For agentic workers:** Use a subagent-driven or inline plan-execution workflow to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Build in a dedicated git worktree.

**Goal:** A single-page, open-source, browser-based point-cloud viewer that opens drone LiDAR surveys (`.las`/`.laz`) **and** phone scans (`.ply`/`.obj`/`.glb`/`.gltf`) from one drag-and-drop — no install, no upload, no conversion — and exposes an analysis-module API so it can grow into a full LiDAR suite.

**The wedge — own the first 60 seconds.** Every existing free tool fails it. plas.io's LAZ decoding is broken on modern browsers (it relied on Chrome's NaCl plugin, removed in 2022). Potree needs a command-line converter *and* a hosting web server. Polycam's web viewer paywalls non-glTF exports and requires uploading your scan to its cloud. QGIS, CloudCompare, WhiteboxTools are heavyweight desktop installs. **OpenLiDARViewer is the only viewer that opens any common scan instantly, privately, in a browser tab.**

**Architecture:** Client-side only — no server, no upload, no pre-conversion CLI. A file is dropped → format-sniffed → parsed in a Web Worker → normalized into one in-memory cloud model → recentered to a shared local origin → rendered with three.js. Clouds over a point budget are voxel-downsampled on load, and the UI always shows the honest "shown / total" count. An analysis-module API hands modules the normalized cloud plus an optional selection.

**Tech Stack:** TypeScript, Vite, three.js (`three/webgpu`), loaders.gl (`@loaders.gl/core`, `@loaders.gl/las`, `@loaders.gl/ply`, `@loaders.gl/obj`, `@loaders.gl/gltf`), laz-perf (WASM LAZ decode, used via loaders.gl), Web Workers, Vitest (unit), Playwright (E2E). MIT licensed.

---

## Context & Decisions (read before starting)

This plan supersedes the earlier "PointBridge" draft. It was produced after a competitive-research pass, a user-research pass, and a critical review of the original plan's assumptions. The engineer must respect these decisions:

1. **Renderer: WebGL2 is a co-primary path, WebGPU is progressive enhancement.** The original draft called WebGPU "verified… ships by default in all major browsers" while its own risk register called the three.js WebGPU renderer "experimental." Both are half-true. WebGPU *does* now ship by default — but Safari needs iOS/macOS 26, and Firefox on macOS needs Apple Silicon + macOS Tahoe. A large share of the broad target audience (especially iPhone-scan users on older iOS) will run the WebGL2 path. Build on three.js `WebGPURenderer` (it carries an automatic WebGL2 fallback) — but **smoke-test, benchmark, and E2E both backends as equals.** The WebGL2 path is not an unverified safety net.

2. **Do NOT hand-write a compute-shader point rasterizer.** Schütz's research and Potree-Next already solved high-end point rasterization. v1 uses three.js's built-in point rendering. A compute-rasterization core is explicitly **v2** and, if pursued, should reuse existing implementations rather than re-derive them.

3. **The novelty is four things working together** — the universal loader, the coordinate bridge, the analysis API, and the zero-friction UX. The renderer is not novel. Spend effort on the four.

4. **The coordinate bridge is the precision-critical task (Task 4).** Georeferenced LAS data uses large UTM coordinates that overflow 32-bit floats and make a cloud jitter or disappear. Every cloud is recentered to a shared local origin on load, with the subtraction done at f64 precision *before* the f32 downcast. This is not optional.

5. **Scope discipline (YAGNI).** v1 is PLY + LAS/LAZ + OBJ + glTF/GLB, two scan-validation analysis modules (Health Check, Scan Report), and the stage UI. E57, USDZ, Gaussian-splat rendering, octree streaming, the compute rasterizer, click-to-measure, and the suite modules are v2 — do not start them.

6. **TDD for the algorithmic core.** Format sniffer, LAS header parser, coordinate bridge, voxel downsample, cloud model, color modes, and both analysis modules are fully unit-testable and must be test-first: failing test → confirm it fails → minimal implementation → confirm it passes → commit. Rendering/UI tasks are verified with Playwright E2E plus manual checks.

7. **The UI is a feature, not chrome.** The "UI/UX design direction" section below is part of the spec, not decoration. "Own the first 60 seconds" is the product.

---

## UI/UX Design Direction

This section is binding spec. The interface is one of the four novelty bets.

### Philosophy

- **Own the first 60 seconds.** The empty state is the pitch; the loaded state must require zero reading.
- **Zero jargon.** "Detail," not "point budget." "Color by height," not "elevation ramp." Auto-detect; don't ask.
- **Progressive disclosure.** Casual users see a canvas and almost nothing else. Power controls live one click away in the Inspector.
- **Privacy is visible.** A persistent "Private · on your device" badge — never fine print.
- **Lightweight.** One page, small bundle, instant load. The interface should feel as fast as the renderer.

### Layout — "stage + floating chrome"

- A full-bleed 3D canvas — the **stage**.
- A slim, transparent **top bar**: wordmark (left); privacy badge + GitHub link (right). No menu bar.
- A single floating **Inspector** panel (top-right), translucent dark, holding: Layers, Color-by, the Detail slider, and the Scan Report (output of the Health Check + Scan Report validation modules). Collapsible.
- A compact **tool dock** (bottom-left): Orbit, Frame-all, Save-view-as-PNG, plus Measure and Slice (visually present but v2-gated).
- A **backend/perf indicator** (bottom-right): e.g. `WebGPU · 60 fps` or `WebGL2 · 58 fps`.

### Empty state (first run)

A large, friendly full-window drop target: the one-line pitch, the reassurance "Drop a scan to open it — nothing leaves your device," and 2–3 one-click sample files ("Try a drone survey," "Try a room scan"). Samples are tiny statically hosted fixtures — opening one is a local fetch, not an upload.

### Interaction model

- The **whole window** is a drop target.
- On drop: a slim progress toast (`Reading survey.laz — 4.2M points`); parsing happens in a worker.
- On load: **auto-frame** the camera to the cloud; **auto-pick** the best color mode (RGB if the file has it, else Height); show **only** the color modes the file actually supports — no dead menu items.
- The **Detail slider** always shows `shown / total` (e.g. `1.6M / 4.2M pts`) so downsampling is never silent.

### Visual tokens

- Canvas background: near-black `#0c0e12` (point clouds read best on dark).
- Accent: a single "lidar-return" teal, `#34d3bd`.
- Elevation ramp: blue → teal → green → amber → red.
- Type: a clean geometric sans for UI; a **monospace for every numeric readout** (point counts, coordinates, dimensions) — it gives a precise, instrument feel.
- Panels: translucent dark surfaces, ~10px corner radius, hairline borders. No heavyweight GIS panel-soup.

### Embed mode

`?embed=1` strips the top bar and dock down to a bare canvas plus minimal controls, so the viewer can be dropped into an `<iframe>`. A developer-audience feature that costs almost nothing — it is one page reading one query param.

---

## File Structure

```
openlidarviewer/
├── index.html                      # single-page shell
├── package.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── tsconfig.json
├── LICENSE                         # MIT
├── README.md
├── CONTRIBUTING.md
├── CITATION.cff
├── .github/workflows/ci.yml        # typecheck + unit tests + E2E + build
├── public/
│   └── samples/                    # tiny hosted sample scans for the empty state
├── scripts/
│   └── make-fixtures.py            # generates deterministic test fixtures
├── src/
│   ├── main.ts                     # app entry, wires UI + viewer
│   ├── model/
│   │   └── PointCloud.ts           # normalized in-memory cloud model
│   ├── io/
│   │   ├── sniffFormat.ts          # detect format from a dropped file
│   │   ├── lasHeader.ts            # parse LAS public header block
│   │   ├── coordinateBridge.ts     # origin offset + recenter (precision-critical)
│   │   ├── loadPly.ts              # PLY  → PointCloud
│   │   ├── loadLas.ts              # LAS/LAZ → PointCloud (applies the bridge)
│   │   ├── loadObj.ts              # OBJ mesh → PointCloud
│   │   ├── loadGltf.ts             # glTF/GLB mesh → PointCloud
│   │   ├── loadFile.ts             # sniff → dispatch loader → PointCloud
│   │   └── parseWorker.ts          # Web Worker: runs a loader off the main thread
│   ├── process/
│   │   └── voxelDownsample.ts      # voxel-grid downsample for over-budget clouds
│   ├── render/
│   │   ├── Viewer.ts               # three.js scene, camera, controls, backend
│   │   └── colorModes.ts           # RGB / intensity / elevation / classification
│   ├── analysis/
│   │   ├── ModuleApi.ts            # the analysis-module interface + registry
│   │   └── modules/
│   │       ├── healthCheck.ts      # integrity checks (invalid coords, dupes, count match)
│   │       └── scanReport.ts       # completeness & resolution (extent, density, coverage)
│   └── ui/
│       ├── Stage.ts                # app shell: layout, top bar, empty state
│       ├── DropZone.ts             # full-window drag-drop + load progress
│       ├── Inspector.ts            # layers, color-by, detail slider, analysis readout
│       └── toolDock.ts             # tool dock + backend indicator
└── tests/
    ├── fixtures/                   # tiny sample .ply / .las / .laz / .obj / .glb
    ├── sniffFormat.test.ts
    ├── lasHeader.test.ts
    ├── coordinateBridge.test.ts
    ├── pointCloud.test.ts
    ├── loadPly.test.ts
    ├── loadLas.test.ts
    ├── loadObj.test.ts
    ├── loadGltf.test.ts
    ├── loadFile.test.ts
    ├── voxelDownsample.test.ts
    ├── colorModes.test.ts
    ├── moduleApi.test.ts
    ├── healthCheck.test.ts
    ├── scanReport.test.ts
    └── e2e/viewer.spec.ts
```

Each `src/io/*` file has one responsibility (one format or one concern). `Viewer.ts` owns all three.js state. Analysis modules never touch the renderer — they consume `PointCloud` only. UI files own DOM only and talk to the viewer/loaders through narrow interfaces.

---

## Task 1: Project scaffold & repo files

**Files:** Create `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `index.html`, `LICENSE`, `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `.gitignore`

- [ ] **Step 1: Init the project**

```bash
npm create vite@latest openlidarviewer -- --template vanilla-ts
cd openlidarviewer
npm install three @loaders.gl/core @loaders.gl/las @loaders.gl/ply @loaders.gl/obj @loaders.gl/gltf
npm install -D vitest @playwright/test typescript
```

- [ ] **Step 2:** Add an MIT `LICENSE`, a stub `README.md` (the full README is Task 20), and `CONTRIBUTING.md`.

- [ ] **Step 3:** Add `vitest.config.ts` with `environment: 'node'` for the IO/process tests; add a jsdom project later only if a UI unit test needs it.

- [ ] **Step 4:** Add `.github/workflows/ci.yml` running `tsc --noEmit`, `vitest run`, `playwright test`, and `vite build` on push/PR.

- [ ] **Step 5: Generate test fixtures.** Every TDD task asserts against tiny scan files with *known* values. A LAZ file cannot be hand-authored, so generate them. Write `scripts/make-fixtures.py` (uses `laspy` + `numpy` + `trimesh` — `pip install laspy numpy trimesh`) that emits `tests/fixtures/{tiny.las, tiny.laz, tiny.ply, tiny.obj, tiny.glb}`, each ~8–20 points/vertices with deliberately chosen coordinates — LAS/LAZ georeferenced with a known UTM offset; PLY/OBJ/GLB in local coordinates. Record every ground-truth value (point counts, first-point coords, bounds, scale/offset) in `tests/fixtures/FIXTURES.md`; the tests assert against that file.

- [ ] **Step 6: Verify laz-perf WASM loads under Vite.** `@loaders.gl/las` decodes LAZ through the bundled laz-perf WASM. Add a throwaway script that calls `@loaders.gl/core` `parse()` on `tests/fixtures/tiny.laz` and logs the point count. If the `.wasm` 404s, fix Vite bundling (`assetsInclude` / `optimizeDeps`) or set the loaders.gl module path explicitly. Must pass before Task 7.

- [ ] **Step 7: Verify the toolchain.** Run `npm run build && npx vitest run` — expect build succeeds, "No test files found."

- [ ] **Step 8: Commit** — `chore: scaffold OpenLiDARViewer + test fixtures`

---

## Task 2: Format sniffer

Detect `ply` / `las` / `laz` / `obj` / `glb` / `gltf` from a dropped file using magic bytes first, extension as fallback.

**Files:** Create `src/io/sniffFormat.ts`; Test `tests/sniffFormat.test.ts`

- [ ] **Step 1: Write the failing test.** Cover: PLY from magic bytes (`ply\n`); LAS from signature `LASF`; LAZ from `.laz` extension when LAS-signed; GLB from magic bytes (`glTF`, `0x46546C67`); glTF from `.gltf` extension; OBJ from extension; `unknown` for unrecognised input.

- [ ] **Step 2: Run — expect FAIL** (`sniffFormat` not defined).

- [ ] **Step 3: Implement** `sniffFormat(buffer, filename)`: read the first 4 bytes. `ply` → `'ply'`; `LASF` → `'laz'` if filename ends `.laz` else `'las'`; `glTF` magic → `'glb'`; otherwise switch on extension for `.obj`/`.ply`/`.las`/`.laz`/`.glb`/`.gltf`; else `'unknown'`. Return type `'ply' | 'las' | 'laz' | 'obj' | 'glb' | 'gltf' | 'unknown'`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `feat(io): format sniffer for ply/las/laz/obj/glb/gltf`

---

## Task 3: LAS public header parser

Parse just the LAS public header block — point count, scale factors, offsets, min/max bounds. (loaders.gl decodes points; we parse the header ourselves because the bridge needs raw scale/offset and bounds before deciding the origin.)

**Files:** Create `src/io/lasHeader.ts`; Test `tests/lasHeader.test.ts`

- [ ] **Step 1: Write the failing test** — assert the parser returns `{ pointCount, scale:[x,y,z], offset:[x,y,z], min:[x,y,z], max:[x,y,z], versionMinor }`. Pin each byte offset as a named constant and assert every field against `tests/fixtures/FIXTURES.md`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `parseLasHeader(buffer)` reading the LAS public header via a `DataView`, using named constants for the ASPRS-spec byte offsets: signature `'LASF'` at 0; version-minor at 25; legacy point count (uint32) at 107; scale X/Y/Z (3× f64) at 131; offset X/Y/Z (3× f64) at 155; bounds stored **max-then-min per axis** — Max X 179, Min X 187, Max Y 195, Min Y 203, Max Z 211, Min Z 219 (each f64). For LAS 1.4, also read the 64-bit point count at 247 and prefer it when version-minor ≥ 4.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `feat(io): LAS public header parser`

---

## Task 4: Coordinate bridge — PRECISION-CRITICAL

Compute a shared local origin and recenter coordinates so a 32-bit-float renderer never sees million-metre UTM values.

**Files:** Create `src/io/coordinateBridge.ts`; Test `tests/coordinateBridge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { computeOrigin, recenter } from '../src/io/coordinateBridge';

test('origin is the floor of the cloud min bounds', () => {
  expect(computeOrigin([500123.4, 4100876.7, 210.2])).toEqual([500123, 4100876, 210]);
});
test('recenter brings UTM coords into a small local range', () => {
  const origin = [500123, 4100876, 210];
  const out = recenter(new Float64Array([500128.5, 4100880.25, 212.5]), origin);
  expect(Array.from(out)).toEqual([5.5, 4.25, 2.5]);
});
test('recenter preserves relative geometry within 1e-3 m', () => {
  const origin = [500000, 4100000, 200];
  const a = recenter(new Float64Array([500010.123, 4100020.456, 205.789]), origin);
  expect(a[0]).toBeCloseTo(10.123, 3);
  expect(a[2]).toBeCloseTo(5.789, 3);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** `computeOrigin(min)` returns `min.map(Math.floor)`. `recenter(coordsF64, origin)` does the subtraction in **Float64Array** then returns a **Float32Array** (the GPU-bound buffer). Document why: the subtraction must happen at f64 precision *before* the f32 downcast, or precision is lost. Export the chosen `origin` on the cloud so multiple clouds can share one.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `feat(io): coordinate bridge — f64 recenter to a shared local origin`

---

## Task 5: Normalized PointCloud model

One in-memory shape every loader produces and every renderer/module consumes.

**Files:** Create `src/model/PointCloud.ts`; Test `tests/pointCloud.test.ts`

- [ ] **Step 1: Write the failing test** — construct a `PointCloud` from `positions` (Float32Array), optional `colors`, `intensity`, `classification`; assert `pointCount`, that `bounds()` returns correct local min/max, and that `origin` round-trips.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the `PointCloud` class/interface: `positions: Float32Array` (xyz interleaved, local coords), `colors?: Uint8Array`, `intensity?: Uint16Array`, `classification?: Uint8Array`, `origin: [number,number,number]`, `sourceFormat`, `name`, `declaredPointCount?` (the count the source file's header claimed — used by the Health Check integrity test), `pointCount` getter, `bounds()` method. Pure data — no rendering, no parsing.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `feat(model): normalized PointCloud`

---

## Task 6: PLY loader

**Files:** Create `src/io/loadPly.ts`; Test `tests/loadPly.test.ts`

- [ ] **Step 1: Write the failing test** — `loadPly(buffer)` returns a `PointCloud` with the fixture's known point count and first-point xyz.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** using `@loaders.gl/ply` `parse()`; map loaders.gl attributes (`POSITION`, `COLOR_0`, `intensity`) into a `PointCloud`; phone PLYs are local-coordinate so `origin = [0,0,0]`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(io): PLY loader`

---

## Task 7: LAS/LAZ loader

**Files:** Create `src/io/loadLas.ts`; Test `tests/loadLas.test.ts`

- [ ] **Step 1: Write the failing test** — `loadLas(buffer)` on both fixtures returns a `PointCloud` whose `origin` equals `computeOrigin(header.min)` and whose first point, added back to `origin`, matches the known global coordinate within 1e-3 m. Assert LAZ and LAS of the same scene produce equal clouds.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** with `@loaders.gl/las` (it decodes LAZ via laz-perf internally — relies on the WASM verified in Task 1 Step 6). Parse the header (Task 3), `computeOrigin` (Task 4), decode points, `recenter` positions against the origin. Carry intensity + classification. Set `declaredPointCount` from the parsed header so the Health Check module can compare it against the decoded count.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(io): LAS/LAZ loader with coordinate bridge`

---

## Task 8: OBJ loader

**Files:** Create `src/io/loadObj.ts`; Test `tests/loadObj.test.ts`

- [ ] **Step 1: Write the failing test** — `loadObj(buffer)` returns a `PointCloud` of the mesh vertices with the fixture's known vertex count.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** with `@loaders.gl/obj`; v1 uses mesh **vertices** as the point set (mesh-surface sampling is deferred). `origin = [0,0,0]`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(io): OBJ loader (vertices as points)`

---

## Task 9: glTF/GLB loader

Polycam's free tier exports glTF/GLB; `.obj` and `.ply` are behind Polycam Pro. Supporting glTF is what makes "anyone with a phone scan" literally true.

**Files:** Create `src/io/loadGltf.ts`; Test `tests/loadGltf.test.ts`

- [ ] **Step 1: Write the failing test** — `loadGltf(buffer)` returns a `PointCloud` of the mesh vertices (across all primitives/meshes) with the fixture's known vertex count and first-vertex xyz; assert vertex colors are carried when present.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** with `@loaders.gl/gltf`; handle both `.glb` (binary) and `.gltf` (JSON) — loaders.gl auto-detects. Walk every mesh primitive, concatenate `POSITION` attributes into one buffer, apply each node's world transform so multi-node scans land correctly, carry `COLOR_0` if present. v1 uses vertices as the point set. `origin = [0,0,0]`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(io): glTF/GLB loader (vertices as points)`

---

## Task 10: Voxel-grid downsample

Cap clouds at a point budget by averaging points into a voxel grid. Deterministic, fully unit-testable.

**Files:** Create `src/process/voxelDownsample.ts`; Test `tests/voxelDownsample.test.ts`

- [ ] **Step 1: Write the failing test** — given 8 points inside one 1 m voxel, `voxelDownsample(cloud, 1.0)` returns 1 point at their centroid; given points spread across 8 voxels, returns 8; assert colors are averaged.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `voxelDownsample(cloud, voxelSize)`: hash each point to an integer voxel key `(floor(x/s),floor(y/s),floor(z/s))`, accumulate sum + count per key, emit centroids (and averaged color/intensity). Also export `voxelSizeForBudget(cloud, maxPoints)` that estimates a voxel size from the bounds and target count. The result must carry both the **downsampled count** and the **original count** so the UI can show `shown / total`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(process): voxel-grid downsample with shown/total tracking`

---

## Task 11: Parse-in-worker + loadFile dispatcher

Move parsing + downsampling off the main thread.

**Files:** Create `src/io/parseWorker.ts`, `src/io/loadFile.ts`; Test `tests/loadFile.test.ts`

- [ ] **Step 1: Write the failing test** — `pickLoader(format)` returns the right loader function for each of the six formats and throws on `'unknown'`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `parseWorker.ts` (a module Web Worker that receives an ArrayBuffer + format, runs the loader + optional downsample, and `postMessage`s the typed arrays as transferables) and `loadFile.ts` (sniff → round-trip the worker → return `PointCloud`, emitting progress events for the toast). Keep `pickLoader` pure and exported for the test. Import the worker the Vite way — `new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })`. **WASM caveat:** inside the worker, loaders.gl must locate the laz-perf `.wasm` itself — a path that resolves on the main thread will not resolve the same way in the worker; set the loaders.gl module path explicitly and verify LAZ decode works *inside the worker*.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(io): parse + downsample in a Web Worker`

---

## Task 12: Viewer — WebGL2 + WebGPU, both tested

three.js scene that renders a `PointCloud`. Per Decision 1, both backends are first-class.

**Files:** Create `src/render/Viewer.ts`; Verified by Task 19 E2E + manual check

- [ ] **Step 1: Implement `Viewer`** — `import * as THREE from 'three/webgpu'`; create a `WebGPURenderer` (auto-falls-back to WebGL2); `OrbitControls`; `addCloud(cloud: PointCloud): string` builds a `THREE.Points` with a `BufferGeometry` from `cloud.positions`/`cloud.colors` and a points material, returns a cloud id; `removeCloud(id)`; `frameAll()` fits the camera to combined bounds; expose `activeBackend()` returning `'webgpu' | 'webgl2'`.
- [ ] **Step 2: Smoke check** — a temporary `main.ts` loads a fixture and calls `addCloud`; `npm run dev`; confirm points render and orbit.
- [ ] **Step 3: Verify BOTH backends as equals** — run once with WebGPU, once with WebGPU force-disabled (WebGL2). Confirm identical render and that `activeBackend()` reports correctly. Both must be green; neither is "the fallback we didn't check."
- [ ] **Step 4: Commit** — `feat(render): point-cloud viewer on WebGPU + WebGL2`

---

## Task 13: Color modes, point size & auto-detect

**Files:** Create `src/render/colorModes.ts`; Modify `src/render/Viewer.ts`; Test `tests/colorModes.test.ts`

- [ ] **Step 1: Write the failing test** — `colorForMode('elevation', cloud)` returns a `Uint8Array` varying monotonically with point Z; `colorForMode('intensity', cloud)` maps intensity to greyscale; `colorForMode('rgb', cloud)` returns the cloud's own colors; `colorForMode('classification', cloud)` maps class codes to a categorical palette. Also test `availableModes(cloud)` — returns only the modes the cloud has data for, and `defaultMode(cloud)` — returns `'rgb'` if colors exist, else `'elevation'`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `colorModes.ts` (pure functions: cloud → color buffer; plus `availableModes` and `defaultMode`) and `Viewer.setColorMode()` + `setPointSize()` swapping the geometry color attribute / material size. The elevation ramp is blue → teal → green → amber → red.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(render): color modes + point size + auto-detect`

---

## Task 14: Multi-cloud scene

Let a drone survey and a phone scan coexist in one scene.

**Files:** Modify `src/render/Viewer.ts`; verified by E2E (Task 19)

- [ ] **Step 1: Confirm `addCloud` already supports N clouds** (it returns ids). Add a per-cloud visibility toggle and a `clouds()` accessor.
- [ ] **Step 2: Shared-origin handling** — when a second cloud loads, if both are georeferenced, rebase the new cloud onto the **first** cloud's origin so they align; if one is local (phone) it sits at its own origin (manual nudge is v2).
- [ ] **Step 3: Commit** — `feat(render): multi-cloud scene with per-cloud visibility`

---

## Task 15: Analysis-module API + Health Check module

The analysis API, plus the first scan-validation module: an integrity check that answers "is this point cloud actually intact?"

**Files:** Create `src/analysis/ModuleApi.ts`, `src/analysis/modules/healthCheck.ts`; Test `tests/moduleApi.test.ts`, `tests/healthCheck.test.ts`

- [ ] **Step 1: Write the failing test** — define an `AnalysisModule` interface `{ id, label, run(cloud: PointCloud, selection?: Selection): AnalysisResult }`, where `AnalysisResult` carries a list of `{ label, value, status }` rows (`status: 'pass' | 'warn' | 'fail' | 'info'`); assert the registry registers/lists modules. For `healthCheck`, assert against crafted in-code `PointCloud`s: a clean cloud is all-`pass`; a cloud with a NaN/Infinite coordinate reports `fail`; a cloud whose `declaredPointCount` differs from `pointCount` reports `warn`; a cloud with coincident duplicate points reports a `warn` carrying the duplicate count; an empty cloud reports `fail`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `ModuleApi.ts` (the interface + a registry) and `healthCheck.ts` — a pure function over `PointCloud`: scan positions for NaN/Infinite values; compare `declaredPointCount` (when present) to the decoded `pointCount`; count exact-coincident duplicate points; flag empty clouds; flag stray outliers (points outside a robust bounds estimate — median ± k·MAD per axis). Returns pass/warn/fail rows. No three.js import.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(analysis): module API + health-check module`

---

## Task 16: Scan Report module

The second scan-validation module: completeness and resolution — "is this scan good enough to use?"

**Files:** Create `src/analysis/modules/scanReport.ts`; Test `tests/scanReport.test.ts`

- [ ] **Step 1: Write the failing test** — `scanReport.run(cloud)` returns rows for: point count; extent (width × depth × height from `bounds()`); point density (points per m² of the XY footprint); estimated average point spacing — the resolution — derived as `sqrt(footprintArea / pointCount)`; and attribute coverage (has RGB? has intensity? has classification? percent of points with a non-zero classification code). Assert every value against a crafted in-code `PointCloud` within 1e-3.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `scanReport.ts` as an `AnalysisModule` — a pure function over `PointCloud`. Compute extent from `bounds()`, footprint area from the XY span, density and the point-spacing estimate, and attribute presence/percentages from the optional typed arrays. No three.js import. (This absorbs the bounding-box readout an earlier draft had split into a separate "dimensions" module.)
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(analysis): scan-report module (extent, density, resolution, coverage)`

---

## Task 17: App shell — Stage, DropZone, Inspector, empty state

The "own the first 60 seconds" task. Implements the UI/UX Design Direction section.

**Files:** Create `src/ui/Stage.ts`, `src/ui/DropZone.ts`, `src/ui/Inspector.ts`; finalize `src/main.ts`, `index.html`; verified by Task 19 E2E + manual

- [ ] **Step 1: Implement `Stage`** — the app shell: full-bleed canvas, transparent top bar (wordmark + privacy badge + GitHub link), and the **empty state** (drop prompt, "nothing leaves your device" line, 2–3 one-click sample-file buttons that fetch from `public/samples/`).
- [ ] **Step 2: Implement `DropZone`** — full-window drag-drop target with a slim progress toast wired to `loadFile()` progress events; on completion calls `viewer.addCloud()`, then `viewer.frameAll()` and applies `defaultMode(cloud)`.
- [ ] **Step 3: Implement `Inspector`** — the floating top-right panel: a **Layers** list (name + point count + visibility toggle + remove); a **Color-by** chip row showing only `availableModes(cloud)`; the **Detail slider** with a live `shown / total` readout driven by the downsample result; and a **Scan Report** area that runs the registered validation modules (Health Check + Scan Report) on load and renders their pass/warn/fail rows. Panel is collapsible.
- [ ] **Step 4: Wire `main.ts`** — construct `Viewer`, `Stage`, `DropZone`, `Inspector`; register the Health Check and Scan Report modules; client-side only, zero network calls except fetching `public/samples/`.
- [ ] **Step 5: Manual check** — `npm run dev`; drop each of the six formats; confirm render, auto-frame, auto color mode, Detail slider honesty, and the Scan Report (Health Check + Scan Report rows).
- [ ] **Step 6: Commit** — `feat(ui): stage shell, drop-zone, inspector, empty state`

---

## Task 18: Tool dock, save-view-as-PNG & embed mode

**Files:** Create `src/ui/toolDock.ts`; Modify `src/render/Viewer.ts`, `src/ui/Stage.ts`; verified by Task 19 E2E + manual

- [ ] **Step 1: Implement `toolDock`** — the bottom-left dock: Orbit (default), Frame-all (`viewer.frameAll()`), Save-view-as-PNG, and two visually-present but disabled buttons gated to v2 — Measure and Slice. Plus the bottom-right backend/perf indicator reading `viewer.activeBackend()` and a frame-rate sample.
- [ ] **Step 2: Save-view-as-PNG** — `Viewer.snapshot()` returns the canvas as a PNG blob; the dock triggers a client-side download. No upload, no backend.
- [ ] **Step 3: Embed mode** — when `location.search` contains `embed=1`, `Stage` renders a bare canvas + minimal controls (no top bar, no dock except Frame-all). Document the `<iframe>` usage in the README.
- [ ] **Step 4: Manual check** — save a PNG of a loaded fixture; load `?embed=1` and confirm stripped chrome; confirm the Measure and Slice buttons are visibly present but disabled.
- [ ] **Step 5: Commit** — `feat(ui): tool dock, PNG snapshot, embed mode`

---

## Task 19: E2E test

**Files:** Create `tests/e2e/viewer.spec.ts`, `playwright.config.ts`

- [ ] **Step 1: Write the E2E test** — launch the built app; drop the `.ply` fixture; wait for the canvas; assert the Layers list shows one entry and the Scan Report shows a non-zero point count plus at least one Health Check row. Repeat for `.las` and `.glb`. Drop a second file and assert two clouds. Load `?embed=1` and assert the top bar is absent.
- [ ] **Step 2: Run — expect PASS** (the app is wired after Task 18). `npx playwright test`
- [ ] **Step 3: Run the E2E suite once per backend** — once normally (WebGPU where available) and once with WebGPU disabled (WebGL2). Both green.
- [ ] **Step 4: Confirm the E2E run is in `ci.yml`.**
- [ ] **Step 5: Commit** — `test(e2e): drop-and-render coverage for ply/las/glb, scan report, multi-cloud, embed`

---

## Task 20: Release polish

**Files:** Finalize `README.md`; Create `CITATION.cff`

- [ ] **Step 1:** Finalize `README.md` (see the separate `README.md` deliverable): what it is, the comparison table, supported formats, "drop a scan" usage, privacy posture, browser-support note (WebGPU + WebGL2), embed snippet, screenshot/GIF placeholders, roadmap, contributing.
- [ ] **Step 2:** Add `CITATION.cff` so the repo is citable as open research.
- [ ] **Step 3:** Confirm full green — `tsc --noEmit && vitest run && playwright test && vite build`.
- [ ] **Step 4: Commit** — `docs: README, citation, v1 release polish`

---

## Definition of Done (v1)

- One drag-drop opens `.ply`, `.las`, `.laz`, `.obj`, `.glb`, `.gltf`.
- Drone and phone clouds render together, correctly positioned (coordinate bridge works — no jitter).
- Auto-frame and auto color mode on load; Color-by shows only supported modes; the Detail slider always shows `shown / total`.
- RGB / intensity / elevation / classification color modes; point-size control.
- Two scan-validation modules run through the module API: **Health Check** (integrity — invalid coordinates, duplicate points, stray outliers, declared-vs-decoded count) and **Scan Report** (completeness & resolution — extent, density, point spacing, attribute coverage).
- The stage UI: empty state with sample files, floating Inspector, tool dock, persistent privacy badge, backend/perf indicator.
- Save-view-as-PNG and `?embed=1` embed mode work.
- Renders on **both** WebGPU and WebGL2; both verified by smoke test and E2E.
- All unit tests + the E2E test green in CI. MIT-licensed, README + CITATION present.
- 100% client-side — no upload, no server, no conversion step.

---

## Appendix — v2 (explicitly out of scope now)

Deferred, in priority order: **compute-rasterization rendering core** (for billion-point drone clouds — reuse Potree-Next or existing implementations, do not re-derive); **octree LOD streaming** so huge clouds keep all points instead of being downsampled; **OPFS caching** of parsed clouds; **mesh-surface point sampling** (OBJ/GLB use vertices in v1); **E57 and USDZ** loaders; **click-to-measure** distance and area; the **Slice/section plane** tool; **box-selection** feeding the analysis modules; cross-source manual alignment (nudge a phone scan onto a drone survey); **Eye-Dome Lighting** depth shading; **3D Gaussian-splat** rendering for phone scans; an **A/B compare** wipe for two clouds; and the suite modules (**FlatScan**, **PlumbLine**, **ClearPath**) built against the Task 15 API.

## Risk register

| Risk | Mitigation |
|---|---|
| three.js WebGPU renderer still self-described "experimental" | WebGL2 is a co-primary tested path, not an unverified fallback; pin the three.js version; smoke-test + E2E both backends (Tasks 12.3, 19.3) |
| Mobile / old-OS browsers lack WebGPU (Safari pre-iOS 26, Firefox/macOS on Intel) | WebGL2 path is mandatory and equally verified |
| Coordinate precision lost on f32 downcast | Recenter at f64 *before* downcast; Task 4 tests assert ≤1e-3 m error |
| loaders.gl LAZ decode performance on huge files | Parse in a Worker (Task 11); voxel-downsample on load (Task 10); octree streaming is v2 |
| Voxel downsample silently hides detail from the user | The Detail slider always shows `shown / total` (Tasks 10, 17.3) — downsampling is never silent |
| glTF scans with multiple nodes/primitives land misaligned | Apply each node's world transform and concatenate all primitives (Task 9) |
| Scope creep into v2 features | Definition of Done is fixed; the v2 list is explicit |

## Review status

- [x] Competitive research pass (browser viewers, desktop tools, WebGPU support) — 2026-05-20
- [x] User-research pass (segments, jobs-to-be-done, the "first 60 seconds") — 2026-05-20
- [x] Critical review of the original PointBridge plan — WebGPU framing reconciled, glTF/GLB added for phone-scan coverage, v1 analysis refocused on scan validation (Health Check + Scan Report), downsampling made honest in the UI — 2026-05-20
- [ ] Plan reviewed by a plan-document-reviewer pass before implementation begins
