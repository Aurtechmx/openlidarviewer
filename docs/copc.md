# COPC in OpenLiDARViewer

A guide for using Cloud-Optimized Point Cloud data in the viewer — what COPC
is, how the streaming works, what a server must provide, and what the viewer
does and does not promise. No prior COPC knowledge assumed.

## What COPC is

A COPC file is a LAZ 1.4 file with an internal octree index: the same
compressed points a normal LAZ carries, arranged so a reader can fetch just
the spatial region and detail level it needs, by byte range. One file serves
both roles — download it whole and it is an ordinary LAZ; range-read it and
it streams. The extension is `.copc.laz`.

## How the viewer streams it

The viewer never downloads the whole file. It reads the header and the
octree hierarchy first, then fetches only the nodes the camera can see, at
the detail the screen can use, decoding them in a worker pool off the main
thread. Moving the camera reprioritises what loads next; nodes that leave
the budget are evicted. What you see is the **resident set**: the decoded
display-resolution points currently held, not the whole file.

This is disclosed wherever it matters. The Scan Report states the loaded
count beside the source's declared total. A point-cloud export of a
streaming scan writes the resident set and says so in the file itself:

```
# SUBSET: <held> of <declared> points the source declared — streamed
  resident set at display resolution, not the whole scan
```

## Local and remote COPC

A local `.copc.laz` (dragged in or picked) streams from disk through the
same path — nothing is uploaded anywhere. A remote COPC streams over HTTP
and requires two things of the server:

- **Range requests** — `Accept-Ranges: bytes`, honoured with `206 Partial
  Content`. Without them there is nothing to stream.
- **CORS** — `Access-Control-Allow-Origin` covering the viewer's origin
  (`*` works), since the viewer is a browser page fetching cross-origin.

Public object stores (S3 and compatible) provide both when configured to.
The Open-from-URL section on the start screen states the same two
requirements behind its "Connection requirements" disclosure.

## What arrives, and what does not

Each decoded node carries position, intensity, classification, return
number/count, and GPS time; RGB and point-source id are used when every
resident node carries them. A missing attribute degrades the related
feature rather than failing the load — nothing assumes RGB or intensity
exist. The CRS comes from the file's own metadata (WKT), with the same
override path every other format has.

## Limits stated plainly

- Terrain analysis, measurements and exports on a streaming scan operate on
  the resident set. Results carry the same disclosure as the Scan Report;
  density-derived figures are uniform-stride extrapolations and say so.
- A streaming source is never merged with a static cloud, and two streaming
  sources are not merged with each other — see
  `KNOWN_LIMITATIONS` for the frame rules.
- Very large hierarchies attach progressively: the first paint uses the
  shallow levels while deeper pages continue loading.
- A malformed file — truncated ranges, corrupt hierarchy, damaged LAZ
  blocks — is refused with a structured error naming what was wrong; the
  viewer does not render partially-decoded garbage.

## Performance expectations

Streaming behaviour depends on the network, the GPU, and the dataset's
density; the project publishes one frozen benchmark protocol
(`docs/benchmarks.md`) instead of general claims. Memory is bounded by the
streaming budget; the budget selector in the Streaming panel trades detail
for memory.

## EPT

EPT (Entwine Point Tiles) streams through the same scheduler and decode
path, addressed as a directory of tiles behind an `ept.json` manifest
instead of one indexed file. The rules above — range/CORS for remote,
resident-set honesty, no cross-source merging — apply identically.
