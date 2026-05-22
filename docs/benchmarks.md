# Benchmarks

Reference measurements from opening real scans in OpenLiDARViewer. These are
field observations, not a formal benchmark suite — hardware, browser, dataset,
and the rendering detail you pick all change the numbers. They are recorded so
the project has a concrete sense of what "it works" means in practice.

## Test machine

Apple MacBook Pro, M3 Max, 16-inch, built-in Retina XDR display, macOS 26.5.
Browser: Brave. Rendering backend: WebGPU.

## Test 1 — Drone LiDAR survey (LAZ)

A georeferenced drone survey — the kind of file the project is squarely aimed
at.

| | |
|---|---|
| File | `20210916_FLEXIGROBOTS_L1_PRO_50M_4MS_B9.laz` |
| Size | 75.7 MB |
| Points | 9,597,830 |
| Format | Compressed LAZ, georeferenced |
| Capture | DJI Matrice 300 RTK with a Zenmuse L1 sensor, UAV flight at 50 m above ground, flown 2021-09-16 |
| Attributes | Intensity and classification present (classification codes are all 0 — never classified) |

The file opens, recenters its large UTM coordinates, and renders. Because it is
over the on-screen point budget it is voxel-downsampled on load; the viewer
shows the honest `shown / total` count.

On the first run the file opened in roughly 40 seconds. The load pipeline was
then optimised — a numeric voxel key instead of a per-point string, decode
buffers hoisted out of the per-point loop, and a single-pass budget search. In
a Linux reference run the parse stage for this exact file dropped from 27.4 s
to 15.5 s, and the viewer now keeps about 3.7M points on screen instead of
2.4M — faster *and* more detail. The proportional gain should carry over to the
test machine; it is worth re-measuring there.

This file's LAS header carries no System Identifier or Generating Software, so
the Scan Report shows no capture-sensor row. The sensor noted above comes from
the flight record, not from the file — many LiDAR exports leave those header
fields blank.

## Test 2 — iPhone LiDAR scan (glTF)

A phone scan — the other half of the project's audience, and a format most
LiDAR tools handle poorly.

| | |
|---|---|
| File | `21_5_2026.glb` |
| Size | 8.7 MB |
| Points | 55,288 |
| Format | glTF binary (`.glb`) |
| Capture | iPhone 15 Pro, scanned with Polycam, exported free as `.glb` |
| Extent | 0.6 × 0.4 × 0.5 m |
| Density | 234,064 pts/m² |
| Spacing | 0.2 cm |
| Attributes | None — vertices only |

The scan — a small statue and its base — opened instantly and rendered
immediately on the WebGPU backend, well under the point budget so no
downsampling was needed. glTF and OBJ meshes are shown as their vertices
(faces and materials are not rendered); for a dense Polycam capture that vertex
cloud is detailed enough to read clearly. The file carries no RGB, intensity,
or classification, so those Scan Report rows read "No".

This matters because it took no conversion step: Polycam's free `.glb` export
opened directly, with nothing uploaded anywhere.

## Takeaway

Two very different scans — a 9.6M-point georeferenced drone survey and a
55K-point iPhone capture — both open from a single drag-and-drop, in a browser
tab, with no install and no conversion. That is the whole point of the project.
