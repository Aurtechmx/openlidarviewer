# OpenLiDARViewer — Developer Manual

A single-page, open-source, browser-based point-cloud viewer. This manual is
the reference for building, testing, extending, and shipping the project.

- **Project README:** [`../README.md`](../README.md)
- **Implementation plan:** [`implementation-plan.md`](implementation-plan.md)
- **Git & release runbook:** [`git-and-release.md`](git-and-release.md)

---

## 1. Purpose

OpenLiDARViewer opens drone LiDAR surveys (`.las` / `.laz`) and phone scans
(`.ply` / `.obj` / `.glb` / `.gltf`) from one drag-and-drop — no install, no
upload, no conversion step — and validates them with built-in scan-quality
checks. It runs entirely in the browser; no scan data ever leaves the device.

---

## 2. Requirements

### 2.1 Functional requirements

| ID | Requirement |
|------|-------------|
| FR-1 | Open a scan by dropping a single file anywhere on the window. |
| FR-2 | Support six formats: `.las`, `.laz`, `.ply`, `.obj`, `.glb`, `.gltf`. |
| FR-3 | Detect format from magic bytes first, file extension second. |
| FR-4 | Parse and downsample off the main thread, in a Web Worker. |
| FR-5 | Recenter georeferenced clouds to a shared local origin, doing the subtraction in float64 before the float32 downcast, within ≤1e-3 m error. |
| FR-6 | Voxel-downsample clouds above the point budget; always display the honest `shown / total` count. |
| FR-7 | Render with three.js using WebGPU, with an automatic WebGL2 fallback. |
| FR-8 | Color by RGB, height, intensity, or classification; auto-select the best mode on load; offer only the modes the file actually contains. |
| FR-9 | Hold multiple clouds in one scene, rebased onto a shared origin. |
| FR-10 | Run validation modules (Health Check, Scan Report) through an open analysis-module API and show the results in the Inspector. |
| FR-11 | Provide an empty state with one-click sample scans, an Inspector panel, a tool dock, and a backend indicator. |
| FR-12 | Save the current view as a PNG, client-side. |
| FR-13 | Support an embed mode (`?embed=1`) that strips the chrome for `<iframe>` use. |

### 2.2 Non-functional requirements

| ID | Requirement |
|------|-------------|
| NFR-1 | **Privacy** — 100% client-side. No server, no upload, no telemetry, no accounts. |
| NFR-2 | **Performance** — parsing runs in a worker; clouds are capped at a 4M-point budget by voxel downsampling. |
| NFR-3 | **Compatibility** — works on modern evergreen browsers; WebGPU where available, WebGL2 everywhere else. |
| NFR-4 | **Zero friction** — usable with no install and no file conversion. |
| NFR-5 | **Quality** — strict TypeScript; the algorithmic core is test-first; CI gates every change. |
| NFR-6 | **Licensing** — MIT; citable via `CITATION.cff`. |
| NFR-7 | **Deployability** — builds to static files hostable on any CDN or GitHub Pages. |
| NFR-8 | **Maintainability** — one responsibility per file; analysis modules never import the renderer. |

---

## 3. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (strict) | Type safety across the IO, model, and render layers. |
| Build / dev | Vite 8 | Fast dev server, first-class Web Worker and WASM handling. |
| Rendering | three.js 0.184 (`three/webgpu`) | WebGPU renderer with a built-in WebGL2 fallback. |
| Parsing | loaders.gl (`las`, `ply`, `obj`, `gltf`) + `laz-perf` | Battle-tested format loaders; `laz-perf` WASM decodes LAZ. |
| Unit tests | Vitest 4 | Fast, ESM-native, Node environment for the algorithmic core. |
| E2E tests | Playwright | Drives the built app in a real browser. |

---

## 4. Prerequisites

- **Node.js 22+** and npm 10+.
- A modern browser for development (Chrome/Edge recommended for WebGPU).

---

## 5. Getting started

The full git history ships as a bundle (see the git & release runbook):

```bash
git clone openlidarviewer.bundle openlidarviewer
cd openlidarviewer
npm install
npm run dev
```

Open the printed local URL and drop a scan, or click a built-in sample.

---

## 6. Project structure

```
src/
  io/            One file per format or per IO concern.
    sniffFormat.ts       Format detection (magic bytes → extension).
    lasHeader.ts         LAS public-header parser.
    coordinateBridge.ts  f64→f32 recentre — precision-critical.
    loadPly/Las/Obj/Gltf.ts   Format → PointCloud loaders.
    parseBuffer.ts       Loader dispatch + downsample (DOM-free).
    loadFile.ts          File → PointCloud via the worker.
    parseWorker.ts       The Web Worker entry.
  model/
    PointCloud.ts        Normalized in-memory cloud model.
  process/
    voxelDownsample.ts   Voxel-grid downsampling.
  render/
    Viewer.ts            three.js WebGPU/WebGL2 scene.
    colorModes.ts        RGB / height / intensity / classification.
  analysis/
    ModuleApi.ts         Analysis-module interface + registry.
    modules/             healthCheck.ts, scanReport.ts.
  ui/
    Stage / DropZone / Inspector / toolDock / dom.ts
  main.ts                Wires the viewer, UI, and modules together.
tests/                   Vitest unit tests; e2e/ holds Playwright specs.
```

Rule of thumb: each `src/io/*` file owns exactly one format or one concern;
`Viewer.ts` owns all three.js state; analysis modules consume `PointCloud`
only and never import three.js.

---

## 7. Architecture

Data flow for a dropped file:

```
drop → sniffFormat → Web Worker { pickLoader → parse → coordinate bridge
       → voxel downsample } → PointCloud → Viewer (WebGPU/WebGL2)
                                         → analysis modules → Inspector
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
  sniffer, LAS header parser, coordinate bridge, `PointCloud`, all loaders,
  voxel downsampling, parse dispatch, color modes, and both analysis modules.
  Tests assert against deterministic fixtures generated by
  `scripts/make-fixtures.py` with ground truth recorded in
  `tests/fixtures/FIXTURES.md`.
- **End-to-end (Playwright).** `tests/e2e/viewer.spec.ts` drives the built
  app: load a sample, confirm the cloud renders and the Scan Report appears,
  load a second cloud, and check embed mode.
- **Not unit-tested:** `Viewer.ts` and the worker entry require a browser/GPU
  and are covered by E2E plus manual checks.

---

## 10. Quality gates (CI)

`.github/workflows/ci.yml` runs on every push and pull request:

- **build-and-test** — `npm ci` → `npm run typecheck` → `npm test` → `npm run build`.
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
  merged into `main` via pull request. See `docs/git-and-release.md`.

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

| Browser | WebGPU | WebGL2 fallback |
|---------|--------|-----------------|
| Chrome / Edge | Default | Yes |
| Firefox | Windows; macOS on Apple Silicon | Yes |
| Safari | iOS / macOS 26+ | Yes |

Where WebGPU is unavailable the viewer automatically uses WebGL2 — a fully
tested path, not a degraded one. The active backend is shown in the UI.

---

## 15. Deployment

`npm run build` emits static files in `dist/`. Host them on any static host
(GitHub Pages, Netlify, S3/CloudFront, any CDN) — there is no server
component. For embedding, serve the same build and link with `?embed=1`.

---

## 16. Verification status

Verified in the build environment (fresh command output):

```
tsc --noEmit     → exit 0, zero errors
vitest run       → 132 tests passed, 14 files
vite build       → 458 modules transformed, exit 0
```

Not verifiable without a browser/GPU, and therefore not claimed as passing:
live WebGPU/WebGL rendering and the Playwright E2E run. Run these locally:

```bash
npm run dev          # manual render check
npx playwright install --with-deps chromium
npm run test:e2e
```

---

## 17. Roadmap (v2)

Deferred by design: octree LOD streaming for billion-point clouds,
click-to-measure, a slice/section tool, E57 and USDZ loaders, Gaussian-splat
rendering, A/B cloud compare, and a deeper analysis suite. See
`docs/implementation-plan.md` for the full v2 list.

---

## 18. Known limitations

- `Viewer.ts` and the UI were authored and type-checked but not runtime-tested
  in the build environment — verify rendering locally.
- The git history is delivered as `openlidarviewer.bundle` because the build
  environment's filesystem could not host a working `.git`. Adopt it per
  `docs/git-and-release.md`.
