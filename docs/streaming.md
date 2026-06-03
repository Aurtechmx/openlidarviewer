# Streaming (COPC + EPT)

OpenLiDARViewer opens **COPC** (Cloud Optimized Point Cloud) and **EPT** (Entwine Point Tile) datasets through a shared streaming pipeline. Neither format is ever read or decoded whole: only the parts the current view needs are fetched, decoded, and uploaded to the GPU. The pipeline shipped in v0.3.0 (COPC) and was hardened in v0.3.1 (hierarchy-aware eviction, camera-motion awareness, pressure adaptation, resilient remote path with retry / timeout / Content-Range / HEAD fallback). v0.3.3 adds EPT as a first-class peer of COPC behind the same scheduler + renderer + picking machinery, plus an extreme-scale dispatch-pressure gate that bounds residency at the hysteresis cap (`1.5 × pointBudget`) under 1B-synthetic-point stress (see [benchmarks.md](benchmarks.md)).

## What COPC is

A COPC file is a LAZ 1.4 file whose points are organised into a clustered
octree, with a small index — the COPC `info` VLR and a hierarchy of 32-byte
entries — that lets a reader locate any octree node's compressed chunk without
scanning the file. It is the point-cloud equivalent of a Cloud Optimized
GeoTIFF: one ordinary file, organised so a viewer can read it incrementally.

## How a COPC scan opens

1. **Detect.** The first 589 bytes are enough to confirm a COPC file — the LAS
   signature and the COPC `info` VLR at offset 375.
2. **Read the metadata.** The LAS 1.4 header and the `info` VLR give the
   octree cube, the point spacing, the scale/offset, and where the hierarchy
   lives — all from a single small range read.
3. **Read the hierarchy.** The octree hierarchy is an *index*, not point data:
   a few tens of kilobytes even for a multi-gigabyte cloud. It is read in full
   so the viewer knows every node's location and extent.
4. **Stream.** A coarse view renders almost immediately. As the camera moves,
   a view-dependent scheduler decides which octree nodes to load next.

## The streaming engine

- **Range reads.** Every fetch is a partial read of the file — a header, a
  hierarchy page, or one octree node's compressed chunk.
- **View-dependent scheduler.** Each tick it frustum-culls the octree, scores
  the visible nodes coarse-first (a shallower node always outranks a deeper
  one; within a depth the larger on-screen node wins), loads what fits the
  point budget, evicts the rest, and cancels work for nodes that left view.
- **Worker decoding.** LAZ chunk decompression runs in a dedicated worker, so
  the interface never stalls on decode.
- **Bounded memory.** Resident points are capped by a quality-based budget,
  and a least-recently-used cache of compressed chunks is capped by bytes —
  neither can grow without limit.

Because a streaming node is drawn with the same instanced-quad mesh as a static
cloud, Eye Dome Lighting, the colour modes, adaptive point sizing, and both the
WebGPU and WebGL2 backends all apply to a COPC scan exactly as to any other.

Every resident node also keeps its full decoded per-point attributes, so the
measurement, annotation, point-inspection, and live-probe tools work on a
streaming scan exactly as on a static one — a click reports the same real-world
coordinates, intensity, classification, return, GPS time, and point-source id.

## The streaming panel

While a COPC scan is open, a panel shows the load phase (detecting, reading
metadata, reading hierarchy, loading the coarse view, refining, ready), the
live node and point counts, the cache size, and controls:

- **Colour** — RGB, Height, Intensity, or Class.
- **Quality** — Low, Balanced, or High; raises or lowers the point budget.
- **Pause / Resume** — stop or resume loading new detail.
- **Clear cache** — drop the cached compressed chunks.

`?debug=1` adds a streaming section to the diagnostics overlay: visible,
queued, loading, and resident node counts, displayed and source points, cache
and GPU estimates, and the scheduler tick time.

## Opening a remote COPC scan

A COPC file does not have to be on the local disk. Because the streaming
pipeline only ever issues range reads, the same pipeline reads a COPC file
hosted at a URL over HTTP `Range:` requests. There are two ways in:

- **The start screen.** The empty state carries an *open from URL* field —
  paste a `.copc.laz` URL and the scan streams in.
- **A deep link.** Loading the viewer with `?copc=<url>` opens that remote
  scan on startup, so a hosted COPC file becomes a shareable, bookmarkable
  link. This is COPC's core promise: host the file once, stream it anywhere.

Before the streaming UI appears, a `HEAD` probe checks the host actually
supports range requests. If it does not, the load fails immediately with a
precise reason rather than stalling — see the limitation below.

## Remote-host requirements

- **A remote host must be range- and CORS-capable.** Streaming a COPC file
  from a URL needs the server to honour HTTP `Range:` requests *and* to allow
  cross-origin requests (CORS). Most static hosts and object stores (S3, GCS,
  and similar) do; an arbitrary web server may not. When a host cannot stream,
  the viewer says so plainly — a CORS-blocked or unreachable host, a host with
  no range support, or one that ignored the range and returned the whole file.
- **Remote EPT has the same requirements** plus the same CORS posture on every
  sub-resource (`ept.json`, the hierarchy JSON files under `ept-hierarchy/`,
  and the tile files under `ept-data/`). A CDN that strips CORS headers from
  static sub-paths will surface a precise CORS error rather than a stall.

## Example data

The COPC 1.0 specification publishes test files, including the Autzen Stadium
scan (`autzen-classified.copc.laz`, ~80 MB). Any conforming `.copc.laz` from
PDAL, untwine, or another COPC writer opens the same way — locally, or from a
range- and CORS-capable URL.

## EPT (Entwine Point Tile) — v0.3.3

EPT is the open hierarchical-point-tile format produced by Entwine and consumed by many of the same tools that read COPC. Where COPC packs an octree into a single LAZ file with an internal hierarchy, EPT spreads it across a directory tree: a top-level `ept.json` manifest, an `ept-hierarchy/` directory of small JSON files describing the octree, and an `ept-data/` directory of one tile per node (either raw `binary` records or self-contained `.laz` files).

OpenLiDARViewer reads EPT through the same `StreamingSource` interface COPC uses, so the scheduler, the renderer, picking, measurements, annotations, the inspector, the live probe, and the colour modes all behave identically across the two formats. The differences live below the interface: an `EptStreamingPointCloud` walks the JSON hierarchy (root + linked sub-files, capped to bound hostile inputs), and an `EptChunkDecoder` dispatches on the manifest's `dataType` to either a schema-driven binary decoder (precision-safe via the Float64→Float32 narrow contract) or a per-tile LAZ decoder that reuses the same cached laz-perf WASM the COPC path uses.

Opening an EPT scan works the same two ways COPC does:

- **The start screen.** Paste a `…/ept.json` URL into the open-from-URL field.
- **A deep link.** `?copc=<url>` is the URL router — it auto-detects an `ept.json` entry and routes to the EPT handler.

The remote-EPT entry has the same fail-fast posture as remote COPC: the URL is validated (http/https only, no embedded credentials, ≤ 2048 chars, must end in `/ept.json`) before any network call, and failures are classified into precise messages (CORS, manifest 404, manifest 5xx, malformed manifest, hierarchy/tile fetch failure, network down) rather than a generic "could not load" stall.

Reference EPT datasets to try: Entwine's public samples (https://entwine.io/data/), or any dataset built locally with `entwine build`.

### Hosting an EPT dataset

For an EPT to stream cleanly into the viewer, the host must serve:

- `ept.json` — the manifest
- `ept-hierarchy/*.json` — the octree hierarchy
- `ept-data/*` — the tiles (`.bin` for `binary`, `.laz` for `laszip`)

All three categories need the same CORS posture: a permissive `Access-Control-Allow-Origin` header (or an origin that matches yours) on every sub-resource. A CDN that strips CORS from static sub-paths surfaces a precise classified error rather than a stall.

Pragmatic guidance:

- **Object stores** — Amazon S3, Google Cloud Storage, Cloudflare R2, Backblaze B2 all serve EPT cleanly once CORS is configured on the bucket / origin.
- **Static hosts** — any static host that passes the headers through (Netlify, Cloudflare Pages, GitHub Pages with CORS) works.
- **CDN caching** — long-cache friendly. `ept.json` changes only when the dataset is rebuilt; hierarchy and tiles are immutable for a given dataset.

### Producing an EPT dataset

The canonical writer is [Entwine](https://entwine.io). A typical build from a directory of LAS/LAZ files:

```bash
entwine build -i ./input/*.laz -o ./out/my-dataset
```

The output directory is exactly the layout the viewer reads. Upload it to a CORS-enabled host and open the resulting `ept.json` URL in OpenLiDARViewer.

### Browser recommendation for EPT

For best EPT streaming, use a Chromium-based browser (Chrome or Edge) with WebGPU enabled and hardware acceleration on. WebGL 2.0 is the supported fallback (Safari, Firefox) and works for most datasets; performance varies with the dataset's hierarchy density and the device's GPU. See [`docs/performance.md`](performance.md) for general performance guidance.

### What the v0.3.4 EPT transport guarantees

The remote-EPT transport applies the same retry + timeout discipline the COPC remote path has had since v0.3.1:

- Per-attempt request timeout — defaults to 20 seconds; an attempt that hangs is cancelled and retried.
- Bounded retries — up to three retries on transient transport faults (408, 429, 5xx, network errors). Exponential backoff with jitter prevents thundering-herd retries on a flaky host.
- Permanent client errors (404 in particular) never retry — the user sees a precise message immediately.
- Outer-signal cancellation composes cleanly — clicking Cancel during a load aborts every in-flight EPT fetch without leaving stranded requests.

A flaky CDN or a brief network blip no longer collapses an EPT load; a genuinely unreachable host fails fast with a precise reason.
