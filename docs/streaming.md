# COPC Streaming

OpenLiDARViewer v0.3.0 opens **COPC** (Cloud Optimized Point Cloud) files
through a dedicated streaming pipeline. A `.copc.laz` file is never read or
decoded whole: only the parts the current view needs are fetched, decoded, and
uploaded to the GPU.

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

## Limitations in v0.3.0

- **A remote host must be range- and CORS-capable.** Streaming a COPC file
  from a URL needs the server to honour HTTP `Range:` requests *and* to allow
  cross-origin requests (CORS). Most static hosts and object stores (S3, GCS,
  and similar) do; an arbitrary web server may not. When a host cannot stream,
  the viewer says so plainly — a CORS-blocked or unreachable host, a host with
  no range support, or one that ignored the range and returned the whole file.

## Example data

The COPC 1.0 specification publishes test files, including the Autzen Stadium
scan (`autzen-classified.copc.laz`, ~80 MB). Any conforming `.copc.laz` from
PDAL, untwine, or another COPC writer opens the same way — locally, or from a
range- and CORS-capable URL.
