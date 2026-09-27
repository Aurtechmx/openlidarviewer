# Observatory O11 overlay benchmark, v1

This record fixes the question, the scenarios, the measurement and the
decision rule for the OB-PR-02 empty-space overlay
(`docs/observatory/SPEC.md` OB-PR-02, O11). It was written and committed
before either overlay arm was measured, so no result could shape these
values. A value is not changed after results are seen. A change is a new
version of this record, with the reason written here.

## Question

Should the OB-PR-02 voxel overlay (`OBSERVED_EMPTY`, `SHADOWED`,
`UNADDRESSED` and the shadow frontier) be drawn as instanced boxes or as a
slice plane through the field? SPEC makes the slice plane the default until
this benchmark says otherwise.

## Arms

Both arms draw the same committed field. Neither changes a canonical byte or
`fieldDigest` (OB-INV-06).

| Arm | What is drawn | What is uploaded |
| --- | --- | --- |
| Slicing (S) | One horizontal plane through the field at one `iz` level, textured with one RGBA8 texel per voxel of that level. During measurement the level steps up by one every 10 frames and wraps, and every step re-uploads the texture. | The plane's vertex and index buffers once, plus `nx * ny * 4` bytes per texture upload, the first included. |
| Instancing (I) | One unit box per voxel whose state is `OBSERVED_EMPTY`, `SHADOWED` or `UNADDRESSED`, or that is on the frontier, with no cap. | The box's vertex and index buffers once, plus 16 bytes per instance once (three Float32 offset components and four Uint8 colour components). |

The largest slice texture is 1024 by 1024 texels (`MAX_SLICE_EDGE`). A field
wider than that on either horizontal axis is not admitted to the slicing arm
as is; no scenario below exceeds it.

## Scenarios

All four are generated deterministically by
`scripts/generate-observatory-fixtures.mjs` (`buildO11Scenarios`). No
third-party data is used. Scenes 1 to 3 are rooms with box pillars, sampled by
casting each station's angular grid against the room and pillar boxes; the
field is then built by the real Observatory kernel (rays, ledger, states,
frontier).

| Id | SPEC scenario | Source | Field |
| --- | --- | --- | --- |
| `small` | One PTX, about 100k cells | 1 station, 316 x 316 angular grid (99,856 returns), room 30 x 20 x 6 m, 4 pillars | voxel edge 0.25 m |
| `medium` | Multi-station E57, 1 to 5M returns | 3 stations, 600 x 600 each (1,080,000 returns), room 60 x 40 x 8 m, 12 pillars | voxel edge 0.5 m |
| `large` | A streaming or strided source, exercising `NOT_READ` | 2 stations, 1000 x 1000 each (2,000,000 records), stride 4: every fourth record is read, the other three quarters are passed to the ledger as not-read rays | voxel edge 0.5 m |
| `stress` | The slice plane at maximum resolution | A synthetic field of 1024 x 1024 x 8 voxels, states from a seeded integer hash in 8 x 8 blocks; no rays, because the kernel's step budget refuses a field this size by design | voxel edge 0.25 m |

## Measurement

- Browser: Chromium, headed, through Playwright, with the three flags that stop
  background throttling (`navJank.spec.ts` uses the same three). The canvas is
  1280 x 800 CSS pixels at device pixel ratio 1. The renderer is the app's own
  `three/webgpu` renderer; the backend it gets (WebGPU or WebGL 2) is recorded.
- Only the overlay is drawn: no point cloud, no other layer.
- Camera: perspective, 50 degree vertical field of view, orbiting the field's
  centre at 1.2 times the field's half-diagonal, 30 degrees above the
  horizontal, one full turn over the measured frames.
- Frame time: for each frame, the wall time from the start of `render` until
  the GPU reports the frame's work done (`queue.onSubmittedWorkDone()` on
  WebGPU, a one-pixel `readPixels` on WebGL 2). Frames run back to back, not
  paced to the display, so vsync does not floor the figure.
- 60 warm-up frames are discarded, then 600 frames are measured. The figure
  for one run is the 95th percentile of those 600.
- Each arm runs 3 times per scenario. The arm's figure is the median of the
  three 95th percentiles. Upload bytes are counted, not timed, and are the
  same in every run.
- The machine, browser version, backend and commit are recorded with the
  results.

## Order and budgets

1. The slicing arm is measured on all four scenarios first.
2. From those results, per scenario, the budgets are fixed and written into the
   results file before the instancing arm runs:
   - frame-time budget = slicing p95 x 1.2 (milliseconds);
   - upload budget = slicing upload bytes x 1.2 (MiB).
3. The instancing arm is then measured on all four scenarios.

## Decision rule

Instancing is chosen only if, on every one of the four scenarios, both hold:

- instancing p95 frame time <= 0.9 x slicing p95 frame time (at least 10%
  better), and
- instancing upload bytes <= 1.5 x slicing upload bytes.

Otherwise slicing stays. A scenario the instancing arm fails to complete
(an out-of-memory error, a lost device, or a frame above 10 seconds) counts as
failing the rule. The verdict is recorded whichever arm it keeps.

The budgets in step 2 then apply to the arm that was chosen, as the ceilings
later changes to the overlay are checked against.

## What this does not decide

- It does not decide which states the overlay shows or how they are coloured;
  that is OB-PR-02 and OB-PR-04.
- It does not measure point rendering, the kernel's run time, or memory other
  than upload bytes.
- A figure from one machine is evidence for that machine only.
