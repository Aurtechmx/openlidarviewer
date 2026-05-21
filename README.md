<div align="center">

# OpenLiDARViewer

### Open any 3D scan. Instantly. Privately. In a browser tab.

Drag a drone LiDAR survey or an iPhone scan onto the page — it just opens.
No install. No upload. No conversion step. Nothing leaves your device.

[![License: MIT](https://img.shields.io/badge/License-MIT-34d3bd.svg)](LICENSE)
[![Status](https://img.shields.io/badge/v1-in%20development-amber.svg)](docs/implementation-plan.md)
[![Client-side](https://img.shields.io/badge/100%25-client--side-34d3bd.svg)](#privacy)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-34d3bd.svg)](CONTRIBUTING.md)

**[▶ Live demo](https://openlidarviewer.app)** · **[Implementation plan](docs/implementation-plan.md)** · **[Contributing](CONTRIBUTING.md)**

<!-- TODO: replace with a real screen recording of a drag-drop → render → scan-report flow -->
![OpenLiDARViewer — drop a scan and it opens](docs/demo.gif)

</div>

---

## What it is

OpenLiDARViewer is a single-page, open-source point-cloud viewer. You drop a file, it figures out the format, parses it in the background, and shows you the scan — colored, framed, and ready to inspect. It opens **drone LiDAR** (`.las` / `.laz`) and **phone scans** (`.ply` / `.obj` / `.glb` / `.gltf`) from the *same* drag-and-drop, and it puts a georeferenced survey and a local scan in the same scene without the cloud jittering apart.

It runs entirely in your browser. Your scan is never uploaded anywhere.

## Why it exists

"Free LiDAR software" almost always comes with a catch. We went looking, and here is the honest state of things:

- **plas.io** — the one browser-based viewer everyone links to — appears unmaintained: no releases, and its LAZ decoding was built on Chrome's NaCl plugin, which Google removed in 2022.
- **Potree** is excellent, but it is not a viewer you can hand to someone — it needs a command-line converter to turn your file into an octree, *and* a web server to host the result.
- **Polycam's** web viewer paywalls every export format except glTF, and it requires uploading your scan to their cloud.
- **QGIS, CloudCompare, WhiteboxTools, FUSION** are powerful — and they are full desktop installs with a GIS learning curve.

So there is a real gap: **nobody lets you just open a scan.** That is the entire point of OpenLiDARViewer — own the first 60 seconds. Drop the file, see the scan, no homework.

## Features

- **One drag-and-drop, six formats** — `.las`, `.laz`, `.ply`, `.obj`, `.glb`, `.gltf`. Format is detected from the file itself, not just the extension.
- **Drone + phone in one scene** — a georeferenced UTM survey and a local phone scan, side by side, correctly placed. A precision coordinate bridge recenters every cloud so 32-bit float math never makes a survey jitter or vanish.
- **100% client-side** — no server, no upload, no account. A persistent badge on screen tells you so.
- **Zero conversion** — the raw file *is* the input. No CLI, no intermediate format.
- **The Detail slider** — large cloud? It's downsampled to stay smooth, and the slider always shows `shown / total` so you know exactly what you're looking at. Honest, never silent.
- **Smart color modes** — RGB, height, intensity, classification. The viewer auto-picks the best one on load and only offers the modes your file actually contains.
- **Scan validation, in the browser** — every scan gets a Health Check (invalid coordinates, duplicate points, stray outliers, declared-vs-decoded point count) and a Scan Report (extent, point density, resolution, attribute coverage). Know whether your scan is intact and complete before you rely on it. Built on an open analysis-module API, so the toolset grows.
- **Built to embed** — add `?embed=1` and drop the viewer into an `<iframe>`.
- **WebGPU, with a real WebGL2 fallback** — fast where WebGPU is available, and fully working where it isn't (older iPhones, Intel Macs).

## Supported formats

| Format | Extension | Typical source | Notes |
|---|---|---|---|
| LAS | `.las` | Drone / aerial LiDAR | Georeferenced; coordinate bridge applied |
| LAZ | `.laz` | Drone / aerial LiDAR | Compressed LAS, decoded in-browser (laz-perf WASM) |
| PLY | `.ply` | iPhone / Scaniverse scans | Point clouds and meshes |
| OBJ | `.obj` | Mesh scans, 3D tools | Mesh vertices used as points (v1) |
| glTF / GLB | `.gltf` `.glb` | Polycam (free tier), AR tools | Mesh vertices used as points (v1) |

## How it works

```
drop a file
   │
   ▼
sniff format ──▶ parse in a Web Worker ──▶ normalize to one PointCloud model
                                                   │
                          recenter to a shared local origin (f64 → f32)
                                                   │
                              voxel-downsample if over the point budget
                                                   │
                                   render with three.js (WebGPU / WebGL2)
```

Everything above happens on your machine. The only network request OpenLiDARViewer ever makes is loading its own code and — if you click one — a built-in sample scan.

## Quick start

```bash
git clone https://github.com/your-org/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

Then open the local URL and drop a scan on the page. To build for static hosting (GitHub Pages, Netlify, any CDN — it's just files):

```bash
npm run build
```

## Embedding

```html
<iframe
  src="https://openlidarviewer.app/?embed=1"
  width="800" height="500"
  style="border:0;border-radius:12px"
  title="OpenLiDARViewer">
</iframe>
```

`?embed=1` strips the chrome down to a bare canvas with minimal controls.

## Analysis modules

Analysis is an open API. A module receives the normalized `PointCloud` (and an optional selection) and returns a result — it never touches the renderer:

```ts
interface AnalysisModule {
  id: string;
  label: string;
  run(cloud: PointCloud, selection?: Selection): AnalysisResult;
}
```

v1 ships two scan-validation modules:

- **Health Check** — integrity. Flags invalid (NaN/infinite) coordinates, duplicate points, stray outliers, and a mismatch between the point count the file's header declares and the count actually decoded.
- **Scan Report** — completeness and resolution. Reports extent (width × depth × height), point density, estimated point spacing, and attribute coverage (RGB / intensity / classification).

Together they answer the question every scan raises: *is this data intact, complete, and detailed enough to rely on?* Writing your own module is a single file plus a `registerModule()` call.

## Privacy

OpenLiDARViewer is **100% client-side**. Your scan is read, parsed, and rendered in your browser and never sent anywhere — there is no server to send it to. Safe for confidential survey data, client work, and proprietary sites. The viewer can run fully offline once loaded.

## Browser support

| Browser | WebGPU | WebGL2 fallback |
|---|---|---|
| Chrome / Edge | ✅ Default | ✅ |
| Firefox | ✅ Windows; macOS on Apple Silicon (Tahoe) | ✅ |
| Safari | ✅ iOS / macOS 26+ | ✅ |

Where WebGPU isn't available, OpenLiDARViewer automatically uses WebGL2 — it is a fully tested path, not a degraded one. A small indicator shows which backend is active.

## Roadmap

**v1 (in development)** — the six-format drag-drop viewer, coordinate bridge, color modes, Detail slider, the Health Check + Scan Report validation modules, the stage UI, embed mode. See the [implementation plan](docs/implementation-plan.md).

**v2 (planned)** — octree LOD streaming for billion-point clouds (so nothing is downsampled away), click-to-measure (distance and area), a slice/section tool, box-selection feeding analysis modules, E57 and USDZ loaders, Gaussian-splat rendering for phone scans, A/B cloud compare, and a deeper analysis suite.

## Documentation

- **[Developer Manual](docs/developer-manual.md)** — requirements (functional & non-functional), architecture, build & test, extending the analysis API, security, deployment.
- **[Implementation plan](docs/implementation-plan.md)** — the task-by-task v1 plan and the v2 roadmap.
- **[Git & release runbook](docs/git-and-release.md)** — branching model, commit conventions, publishing, and cutting a release.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small, test-first (Vitest + Playwright), TypeScript, and deliberately modular: one file per format, one file per concern. Good first issues are tagged on the tracker.

## License & citation

MIT — see [LICENSE](LICENSE). If you use OpenLiDARViewer in research, a [CITATION.cff](CITATION.cff) is included so it can be cited directly.

## Acknowledgements

Built on [three.js](https://threejs.org), [loaders.gl](https://loaders.gl), and [laz-perf](https://github.com/hobuinc/laz-perf). Inspired by what [Potree](https://github.com/potree/potree) made possible for the web, and by the friction-free, no-upload feel of [SuperSplat](https://github.com/playcanvas/supersplat).
