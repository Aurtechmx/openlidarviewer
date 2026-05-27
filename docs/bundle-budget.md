# Bundle budget — v0.3.3 audit

> **Honest scope note:** an earlier internal target was "≤ 700 KB preferred /
> ≤ 550 KB stretch". After audit, the realistic landing zone with the
> current architecture is ~1,200 KB pre-gzip. Hitting < 700 KB requires
> architectural decisions captured at the bottom of this doc as the
> bundle-slim follow-up work.

## Baseline (v0.3.3)

```
dist/assets/index-*.js            1,304 KB pre-gzip  /  384 KB gzip
dist/assets/three.core-*.js         126 KB pre-gzip  /   42 KB gzip (already split)
dist/assets/loadLas-*.js            347 KB pre-gzip  /  127 KB gzip (lazy — opens on first .las/.laz)
dist/assets/copcWorker-*.js         341 KB pre-gzip  /  ~120 KB gzip (lazy — opens on first COPC)
dist/assets/loadGltf-*.js           102 KB pre-gzip  /  ~30 KB gzip (lazy — opens on first .gltf/.glb)
dist/assets/export-*.js              32 KB pre-gzip  /   12 KB gzip (lazy — opens on first export)
dist/assets/EptStreamingPointCloud   15 KB pre-gzip  /    6 KB gzip (lazy — opens on first .ept.json)
dist/assets/StreamingScheduler-*     15 KB pre-gzip  /    6 KB gzip (lazy)
all other lazy chunks                <10 KB each
```

**Initial-load bytes:** main + three.core = **1,430 KB pre-gzip / 426 KB gzip**.

## What's in the main bundle

The 1,304 KB main bundle is dominated by:

1. **three.js webgpu renderer (~500-650 KB minified).** The webgpu
   package is much larger than the WebGL2 fallback that ships in
   `three.core`. Splitting it requires a per-module lazy boundary
   that rolldown's automatic chunking doesn't infer.
2. **The Viewer class + its render pipeline (~250-350 KB).**
   `Viewer.ts` is ~1,900 lines and eagerly imports MeasureController,
   InspectTool, AnnotationController, LiveProbe, NavController, and
   the EDL post-processing pipeline. These ship together because
   the render loop needs them every frame.
3. **The UI shell (~150-200 KB).** Stage, DropZone, Inspector,
   ToolDock, NavBar, ProjectCard, HelpOverlay, the streaming +
   measurement + annotation panels, the embed bridge.
4. **The Studio + scan-report card (~50 KB).** Wait — these are
   already lazy. They're NOT in the main bundle.

## What's already lazy (v0.3.3)

| Lazy chunk | When it loads | Bytes saved from main |
|---|---|---|
| `loadLas` | First `.las`/`.laz` open | 347 KB |
| `copcWorker` + `copcWorkerClient` | First COPC stream | 343 KB |
| `loadGltf` | First `.gltf`/`.glb` open | 102 KB |
| `loadPly` / `loadObj` / `loadPcd` / `loadPts` / `loadPtx` / `loadXyz` | First open of each format | ~50 KB total |
| `loadE57` | First `.e57` open | 8 KB |
| EPT chunks (`eptDetect`, `EptStreamingPointCloud`, `EptChunkDecoder`) | First `ept.json` URL | ~25 KB |
| Streaming runtime (`StreamingScheduler`, `StreamingRenderer`, `StreamingNodeStore`, `streamingColors`, `streamingBenchmark`) | First streaming source | ~30 KB |
| `export` (Studio + all 7 mode factories + ScanReportRenderer + LegendRenderer + Presets) | First export-button click | 32 KB |
| `DebugOverlay` + `streamingBenchmark` | `?debug=1` or `?benchmark=1` | 12 KB |
| `HttpRangeSource` + `InstrumentedRangeSource` + `LocalFileRangeSource` | First remote / local-COPC open | 9 KB |

**Total bytes deferred from initial bundle: ~960 KB.** Without these
splits the initial bundle would be ~2,260 KB pre-gzip. The current
architecture already does substantial code-splitting; the remaining
1,304 KB is what needs to be on the page for the app to BOOT.

## v0.3.3 wins shipped

| Change | Bundle delta |
|---|---|
| `startEmbedBridge` switched to lazy `await import('./ui/embedBridge')` — only fetched when `?embed=1` | ~2 KB (rolldown inlined the small chunk; the win is parse-time savings on non-embed loads, not byte savings) |

## Path to < 700 KB

The realistic gap from current 1,304 KB → 700 KB target is 600 KB of
work. The honest options:

1. **three.js webgpu split (~500 KB potential).** Configure rolldown
   `manualChunks` to put `three/webgpu` + `three/tsl` in their own
   chunk loaded in parallel with main. Risk: the obfuscator-plus-
   chunk-emission-guard build pipeline is fragile against new manual
   chunks; needs careful testing.

2. **MeasureController + AnnotationController lazy split (~120 KB
   potential).** These eagerly construct in the Viewer constructor.
   Refactor to construct on first use ("first measurement / annotation"),
   with a stub passthrough for the event wiring in the meantime.
   Risk: the render loop touches them every frame for overlay rendering.

3. **HelpOverlay + AnnotationEditor + AnnotationPanel + MeasurePanel
   lazy split (~30 KB potential).** UI panels that only show on
   demand. Lower risk; medium UX impact (first-? key press needs to
   await the chunk fetch).

4. **EDL post-processing lazy split (~50 KB potential).** Disabled by
   default on the low device profile; could be lazy-loaded only when
   the user enables it. Risk: feels janky if the first EDL enable
   stalls on chunk fetch.

A realistic post-split target is ≤ 900 KB pre-gzip after wins 1–3. The
≤ 700 KB stretch assumed three.js-WebGPU splitting + UI-controller
deferral both landing — both individually high-risk changes.

## How to verify

```bash
npm run build:live
ls -la dist/assets/index-*.js dist/assets/three.core-*.js | awk '{print $5, $NF}'
```

The current numbers (pre-gzip):
```
1,301,328 dist/assets/index-BPDQST_L.js
  126,393 dist/assets/three.core-BzbzJYom.js
```

Multiply by ~0.30 for the gzip-on-the-wire figure.
