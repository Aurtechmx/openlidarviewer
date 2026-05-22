# OpenLiDARViewer — Developer Manual

A single-page, open-source, browser-based point-cloud viewer. This manual is
the reference for building, testing, extending, and shipping the project.

- **Project README:** [`../README.md`](../README.md)
- **Architecture map:** [`architecture.md`](architecture.md)
- **Contributing guide:** [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- **Roadmap:** [`roadmap.md`](roadmap.md)

---

## 1. Purpose

OpenLiDARViewer opens drone LiDAR surveys and phone scans from one
drag-and-drop, with no install, no upload, and no conversion step. It runs
entirely in the browser; no scan data ever leaves the device. Once a scan is
open you can navigate it in 3D, recolor it, measure distances, read a Scan
Intelligence report, and export the result.

---

## 2. Requirements

### 2.1 Functional requirements

| ID | Requirement |
|------|-------------|
| FR-1 | Open a scan by dropping a single file anywhere on the window. |
| FR-2 | Import eight formats: `.las`, `.laz`, `.ply`, `.obj`, `.glb`, `.gltf`, `.xyz`, `.csv`. |
| FR-3 | Detect format from magic bytes first, file extension second. |
| FR-4 | Parse and downsample off the main thread, in a Web Worker. |
| FR-5 | Recenter georeferenced clouds to a shared local origin, doing the subtraction in float64 before the float32 downcast, within a small bounded error. |
| FR-6 | Voxel-downsample clouds above the point budget; always display the honest `shown / total` count. |
| FR-7 | Render with three.js using WebGPU, with an automatic WebGL 2 fallback. |
| FR-8 | Color by RGB, height, intensity, or classification; auto-select the best mode on load; offer only the modes the file actually contains. |
| FR-9 | Hold multiple clouds in one scene, rebased onto a shared origin. |
| FR-10 | Navigate the cloud in Orbit, Walk, and Fly modes, with WASD movement and pointer-lock mouse-look. |
| FR-11 | Measure straight-line distance between two picked points inside the cloud. |
| FR-12 | Run validation modules (Health Check, Scan Report) through an open analysis-module API and show the results in the Scan Intelligence panel. |
| FR-13 | Export the cloud to PLY, OBJ, XYZ, or CSV, and save the current view as a PNG, all client-side. |
| FR-14 | Save and restore named camera views. |
| FR-15 | Support an embed mode (`?embed=1`) that strips the chrome for `<iframe>` use. |
| FR-16 | Inspect a picked point — show its real-world coordinates and attributes, with one-click copy to the clipboard. |

### 2.2 Non-functional requirements

| ID | Requirement |
|------|-------------|
| NFR-1 | **Privacy** — 100% client-side. No server, no upload, no telemetry, no accounts. |
| NFR-2 | **Performance** — parsing runs in a worker; clouds are capped by voxel downsampling at a point budget. |
| NFR-3 | **Compatibility** — works on modern evergreen browsers; WebGPU where available, WebGL 2 everywhere else. |
| NFR-4 | **Zero friction** — usable with no install and no file conversion. |
| NFR-5 | **Quality** — strict TypeScript; the algorithmic core is test-first; CI gates every change. |
| NFR-6 | **Licensing** — MIT; citable via `CITATION.cff`. |
| NFR-7 | **Deployability** — builds to static files hostable on any CDN or GitHub Pages. |
| NFR-8 | **Maintainability** — one responsibility per file; analysis modules never import the renderer. |

---

## 3. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (strict) | Type safety across the IO, model, render, and UI layers. |
| Build / dev | Vite 8 | Fast dev server, first-class Web Worker and WASM handling. |
| Rendering | three.js 0.184 (`three/webgpu`, `three/tsl`) | WebGPU renderer with a built-in WebGL 2 fallback. |
| Parsing | loaders.gl (`las`, `ply`, `obj`, `gltf`) + `laz-perf` | Battle-tested format loaders; `laz-perf` WASM decodes LAZ. |
| Unit tests | Vitest | Fast, ESM-native, Node environment for the algorithmic core. |
| E2E tests | Playwright | Drives the built app in a real browser. |

---

## 4. Prerequisites

- **Node.js 22+** and npm 10+.
- A modern browser for development (Chrome or Edge recommended for WebGPU).

---

## 5. Getting started

```bash
git clone https://github.com/aurtechmx/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

Open the printed local URL and drop a scan, or click a built-in sample.

---

## 6. Project structure

```
src/
  io/                    One file per format or per IO concern.
    sniffFormat.ts         Format detection (magic bytes -> extension).
    lasHeader.ts           LAS public-header parser.
    coordinateBridge.ts    f64 -> f32 recentre — precision-critical.
    loadLas/Ply/Obj/Gltf/Xyz.ts   Format -> PointCloud loaders.
    parseBuffer.ts         Loader dispatch + downsample (DOM-free).
    loadFile.ts            File -> PointCloud via the worker.
    parseWorker.ts         The Web Worker entry.
    lazPerfWasm.ts         laz-perf WASM glue for LAZ decoding.
    exporters.ts           PointCloud -> PLY / OBJ / XYZ / CSV text.
  model/
    PointCloud.ts          Normalized in-memory cloud model.
  process/
    voxelDownsample.ts     Voxel-grid downsampling.
  render/
    Viewer.ts              three.js WebGPU / WebGL 2 scene.
    colorModes.ts          RGB / height / intensity / classification.
    navMath.ts             Pure navigation math (unit-tested).
    NavController.ts       Orbit / Walk / Fly, keyboard, pointer-lock, tweens.
    MeasureTool.ts         Two-point distance measurement.
    InspectTool.ts         Click a point to read its attributes.
    pointInfo.ts           Pure picked-point data + serialisation (unit-tested).
  analysis/
    ModuleApi.ts           Analysis-module interface + registry.
    modules/               healthCheck.ts, scanReport.ts.
  ui/
    Stage / DropZone / Inspector / NavBar / ProjectCard / toolDock / dom.ts
  main.ts                  Wires the viewer, navigation, UI, and modules.
tests/                     Vitest unit tests; tests/e2e/ holds Playwright specs.
```

Rule of thumb: each `src/io/*` file owns exactly one format or one concern;
`Viewer.ts` owns all three.js state; analysis modules consume `PointCloud`
only and never import three.js. The "Scan Intelligence" panel is built in
`src/ui/Inspector.ts`.

---

## 7. Architecture

Data flow for a dropped file:

```
drop -> sniffFormat -> Web Worker { pickLoader -> parse -> coordinate bridge
        -> voxel downsample } -> PointCloud -> Viewer (WebGPU / WebGL 2)
                                            -> analysis modules -> Scan Intelligence
```

Three load-bearing decisions:

1. **The coordinate bridge.** Georeferenced LAS data uses large UTM
   coordinates that overflow 32-bit floats. Every cloud is recentered to an
   integer local origin; the subtraction is done in float64 *before* the
   float32 downcast. `.las` is decoded from raw int32 records and `.laz` via
   the `laz-perf` WASM decoder, so both keep full precision.
2. **Parse in a worker.** Parsing and downsampling never touch the main
   thread, so the UI stays responsive on large surveys.
3. **The analysis API.** A module is `{ id, label, run(cloud, selection?) }`
   returning pass/warn/fail rows. Modules are pure functions over
   `PointCloud` — decoupled from rendering and easy to unit-test.

See [`architecture.md`](architecture.md) for the full map.

---

## 8. Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server with hot reload. |
| `npm run build` | Typecheck then produce the static production build in `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | `tsc --noEmit` — strict type checking. |
| `npm test` | Run the Vitest unit suite once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Playwright end-to-end tests (run `npx playwright install --with-deps chromium` first). |

---

## 9. Testing strategy

- **Unit (Vitest, Node).** The algorithmic core is test-first: format
  sniffer, LAS header parser, coordinate bridge, `PointCloud`, every loader,
  voxel downsampling, parse dispatch, color modes, navigation math, the
  exporters, and both analysis modules. Tests assert against deterministic
  fixtures generated by `scripts/make-fixtures.py`, with ground truth recorded
  in `tests/fixtures/FIXTURES.md`.
- **End-to-end (Playwright).** `tests/e2e/viewer.spec.ts` drives the built
  app: load a sample, confirm the cloud renders and the Scan Report appears,
  load a second cloud, and check embed mode.
- **Not unit-tested:** `Viewer.ts`, `NavController.ts`, `MeasureTool.ts`,
  `InspectTool.ts`, and the worker entry require a browser/GPU and are covered
  by E2E plus manual checks. Their pure logic lives in `navMath.ts` and
  `pointInfo.ts`, which *are* unit-tested.

---

## 10. Quality gates (CI)

`.github/workflows/ci.yml` runs on every push and pull request:

- **build-and-test** — `npm ci` -> `npm run typecheck` -> `npm test` -> `npm run build`.
- **e2e** — installs Chromium and runs `npm run test:e2e`.

Pre-merge checklist for any PR into `main`: all review threads resolved, both
CI jobs green, branch rebased on the latest `main`.

---

## 11. Coding standards

- **Strict TypeScript** — `verbatimModuleSyntax` (use `import type` for
  type-only imports), `erasableSyntaxOnly` (no `enum`, no `namespace`), and
  full `strict` mode.
- **Conventional Commits** — `type(scope): description`; `feat`, `fix`,
  `docs`, `test`, `ci`, `chore`, `refactor`, `perf`.
- **Branching** — trunk-based; short-lived `feature/*` and `fix/*` branches,
  merged into `main` via pull request.

---

## 12. Extending: writing an analysis module

Analysis is an open API. A module receives a `PointCloud` and returns rows;
it never touches the renderer.

```ts
import type { AnalysisModule } from '../ModuleApi';

export const myModule: AnalysisModule = {
  id: 'my-module',
  label: 'My Module',
  run(cloud) {
    return {
      rows: [
        { label: 'Points', value: String(cloud.pointCount), status: 'info' },
      ],
    };
  },
};
```

Register it in `main.ts` with `registry.register(myModule)` and add a
matching `tests/myModule.test.ts`.

---

## 13. Security & privacy

- **No data leaves the browser.** Files are read, parsed, and rendered
  locally; there is no backend to send them to. Safe for confidential survey
  data and proprietary sites.
- **No telemetry, no accounts, no third-party calls** at runtime — the only
  network requests are loading the app's own static assets and, if a user
  clicks one, a built-in sample file.
- **Dependency surface** is limited to three.js, loaders.gl, and `laz-perf`.
  CI runs against pinned versions; `npm audit` is recommended before a release.

---

## 14. Browser & platform support

| Browser | WebGPU | WebGL 2 fallback |
|---------|--------|------------------|
| Chrome / Edge | Default | Yes |
| Firefox | Windows; macOS on Apple Silicon | Yes |
| Safari | iOS / macOS 26+ | Yes |

Where WebGPU is unavailable the viewer automatically uses WebGL 2 — a fully
tested path, not a degraded one. The active backend is shown in the UI.

---

## 15. Deployment

`npm run build` emits static files in `dist/`. Host them on any static host
(GitHub Pages, Netlify, S3/CloudFront, any CDN) — there is no server
component. For embedding, serve the same build and link with `?embed=1`.

---

## 16. Roadmap

Deferred by design: octree LOD streaming for very large clouds, expanded
format support (E57, COPC LAZ, 3D Tiles / PNTS), polyline/area/height-difference
measurement, slicing and clipping tools, A/B cloud compare, and a deeper
analysis suite. See [`roadmap.md`](roadmap.md) for the full list.

---

## 17. Known limitations

OpenLiDARViewer is an R&D-stage viewer, not a survey-grade processing suite.
Measurement is for visual inspection, large files are bound by browser memory
and GPU limits, and OBJ/glTF meshes are shown as their vertices. See
[`limitations.md`](limitations.md) for the full list.
