# Gate 2 — Per-cloud elevation/intensity filtering (implementation plan)

Status: **not implemented.** This is a device-verified plan for the one remaining
correctness gate from the v0.5.6 filter review. It is device-untestable in CI
(WebGPU shader-graph change), so every stage below has an on-device checkpoint.

## Problem

The elevation filter converts a world-space window into **one** attribute-space
window using a **single** origin and up-axis:

- `Viewer.setElevationFilter` uses `streamingCloud.renderOrigin` **or** the first
  static cloud's `origin`, and `_worldUp` for the axis.
- `_elevMaskMultiplier()` folds **shared** uniforms (`_elevFilterMin/Max/AxisIsZ`)
  into every material's `sizeNode`.
- The CPU pick predicate (`_currentFilterWindow`) reads those same shared uniforms.

Meshes are added at scene origin with no per-mesh transform, so two static layers
recentred by **different** origins, or a mix of Z-up and Y-up layers, filter
against the wrong reference. Intensity is raw units with no origin, so intensity
is already per-cloud-correct — **this gate is elevation-only.**

Correctness target: the world-space window is converted **per cloud** using that
cloud's own origin + up-axis, on both the GPU (what you see) and the CPU pick
predicate (what you can select), so screen and pick agree for every layer.

## Design

Keep the shared `_elevFilterEnabled` (on/off). Make **min/max/axis per material**.

1. **Store the window in world space.** Replace the shared attribute-space
   uniforms with:
   - `private _elevFilterWorld: [number, number] | null` (world units, user input)
   - keep `_elevFilterEnabled` shared.
2. **Per-material uniforms.** `WeakMap<PointsNodeMaterial, { min: UniformNode;
   max: UniformNode; axisIsZ: UniformNode }>`, created lazily per material.
3. **Per-cloud conversion helper (pure, tested).** Reuse `elevationFilterUniform`
   (already exists and tested): `elevationFilterUniform(worldRange, axis, originAlongAxis)`
   → `{ enabled, min, max }`. Add a thin `elevWindowForCloud(worldRange, axisIsZ,
   originAlongAxis)` if a clearer signature helps; keep the math in the pure module.
4. **`_elevMaskMultiplier(material)`** reads that material's uniforms instead of the
   shared ones. Node shape is otherwise identical to today's (proven) graph:
   `mix(1, step(min,elev)*step(elev,max), enabled)` with
   `elev = pos.z*axisIsZ + pos.y*(1-axisIsZ)`.
5. **Apply on filter change.** `setElevationFilter(worldRange)` stores the world
   range, sets `_elevFilterEnabled`, then for every material looks up its cloud's
   `originAlongAxis` + `axisIsZ` and writes that material's min/max/axis uniforms.
6. **Apply on mesh build.** `buildPointMesh` must know the cloud's origin + axis to
   seed a new mesh's uniforms from the current world window. Two options:
   - **(a)** add `originAlongAxis: number, axisIsZ: boolean` params to
     `buildPointMesh` (static: `cloud.origin` + `isZUpFormat`; streaming: the
     renderer passes `renderOrigin` + the streaming axis), or
   - **(b)** register the mesh's cloud origin/axis in a side map at `addCloud` /
     streaming-attach time and have a `_seedElevUniforms(material)` read it.
   Prefer **(b)** — it keeps `buildPointMesh`'s signature stable and localizes the
   origin/axis lookup to where the cloud entry is known.
7. **Per-cloud pick window.** `_currentFilterWindow()` currently returns one window.
   Change the pick paths to build the elevation part **per cloud**:
   - `_pickDetailed`: for each static cloud entry, compute its own `elevMin/Max/axis`
     from `_elevFilterWorld` + that cloud's origin/axis, and pass into
     `buildPointFilterAccept`.
   - streaming pick `acceptForNode`: use the streaming origin/axis for every node.
   The class + intensity parts stay global (class mask is shared; intensity is raw).

## Staged rollout (each stage builds + device-checks before the next)

Work on a branch (`feat/v0.5.6-gate2-percloud`) so it can be reverted cleanly.

- **Stage A — infra, behaviourally identical.** Add the per-material WeakMap and
  `_elevFilterWorld`; make `_elevMaskMultiplier(material)` read per-material
  uniforms; seed every material from the single active window (same value for all).
  With one cloud this is numerically identical to today.
  - **Device check:** `npm run build:live && npm run preview`; open one static LAS
    and one streaming COPC; apply an elevation filter; confirm rendering + the
    existing `filterElevation` behaviour is unchanged. Run `npm run test:smoke:live`.
- **Stage B — per-cloud GPU conversion.** In `setElevationFilter` and the seed-on-
  build path, convert the world window per cloud (origin + axis). Single-cloud
  output is unchanged; multi-cloud now diverges correctly.
  - **Device check:** load two static layers with **different** origins (two tiles
    from different areas), and separately a Z-up survey + a Y-up phone scan; confirm
    each layer clips at the correct world height.
- **Stage C — per-cloud pick window.** Update `_pickDetailed` and the streaming
  `acceptForNode` to build the elevation predicate per cloud. Verify pick == render
  by picking a point right at the filter boundary on each layer.
  - **Device check:** with a filter active, confirm you cannot snap/measure a point
    that's hidden on any layer, on both the near and far side of the window.
- **Stage D — cleanup + notes.** Remove the "single up-axis/origin" *Known
  limitations* note from `CHANGELOG.md`; update the elevation-filter bullet to state
  per-layer conversion. Re-run `npm run test:release`.

## Tests (CI-runnable, no GPU)

- Extend `pointFilterAccept` tests: two synthetic clouds with different origins →
  the same world window yields different attribute-space accept thresholds.
- New pure test for the per-cloud conversion (`elevationFilterUniform` already has
  coverage; add a case asserting two origins produce two windows from one world
  range).
- A Viewer-level unit test isn't feasible (constructs `WebGPURenderer`); rely on the
  pure tests + the Stage B/C device checks.

## Risks & rollback

- **Shader-graph change (Stage A).** Reading per-material uniforms instead of shared
  ones changes the compiled node graph. If it regresses rendering, the `onGpuError`
  hook now surfaces it; revert the branch. Keep Stage A a separate commit so it can
  be bisected against.
- **Uniform lifetime.** Per-material uniforms live as long as the material; they're
  dropped when the material is disposed (`removeCloud`). No extra teardown needed
  since the WeakMap keys on the material.
- **Perf.** `setElevationFilter` now iterates materials writing uniform values
  (cheap, no pipeline rebuild — uniform writes don't recompile). Only the
  active-state **toggle** rebuilds (already handled by `_reapplyAllSizeModes`).
