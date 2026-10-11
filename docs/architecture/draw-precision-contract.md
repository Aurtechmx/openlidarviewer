# Draw precision bound: the shader contract

The scan report's "Draw precision bound" row comes from the spe-check checker
(`src/vendor/spe-check/`, MIT, A. Urias), which implements the bound in
A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2
and WebGPU". The checker version is pinned by the SHA-256 of upstream
`spe_check.js`, `53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b`.

The bound covers one expression only: the eye-space position
`e = modelView * vec4(p, 1.0)`, evaluated in binary32 (GLSL ES 3.00 `highp`
or WGSL `f32`), where `modelView` is an affine matrix composed in binary64 on
the CPU and narrowed once, and `p` is a Float32 local coordinate relative to a
binary64 origin. Projection, the division by w, the point sprite offset, depth
encoding and survey accuracy are outside it. A draw path is mapped to
`EXPRESSION_GLSL` or `EXPRESSION_WGSL` only when it evaluates exactly that
expression; any other path is passed `olv-unverified-point-path` and reports
NOT_TESTED.

It is a diagnostic. The render loop never calls it.

## Paths and findings

Read in three.js 0.186.0; three.js line numbers below are for that version.
The lockfile resolves 0.186.1, and every quoted excerpt is pinned by content in
`tests/drawPrecisionShaderContract.test.ts`, which passes against 0.186.1 in
CI. The test also fails on any three.js version other than these two, and on
a change to the OLV side.

| Path | Used for | Expression | State |
|---|---|---|---|
| `Viewer.buildPointMesh` on WebGPU | static clouds (evaluated), COPC/EPT streaming nodes and preview clouds (same mesh, not evaluated) | `wgsl-mat4x4f-vec4f` | PASS-eligible |
| `Viewer.buildPointMesh` on the WebGL 2 fallback | as above | `glsl-es300-highp-mat4-vec4` | PASS-eligible |
| `ObservationPointOverlay` (`THREE.PointsMaterial`) | Observatory station overlay, not a point cloud | none | not evaluated; would be NOT_TESTED |
| any path not listed | | `olv-unverified-point-path` | NOT_TESTED |

### Evidence for `buildPointMesh`

1. Float32 local centres. `src/render/Viewer.ts:1457` uploads
   `cloud.positions` as `InstancedBufferAttribute(positions, 3)`. The buffer is
   `positions[i] + sourceOrigin` = source coordinate
   (`docs/architecture/float64-transform.md`, invariant 2), written once by
   the loader.
2. The centre is the position node, unmodified. `src/render/Viewer.ts:1501`
   sets `material.positionNode = instancedBufferAttribute(positionAttr)`. No
   other file in `src/` assigns `positionNode` or `vertexNode`, overrides
   `setupPositionView`, or sets a context `modelViewMatrix`. The mesh is a plain
   `THREE.Mesh` (`Viewer.ts:1540`), not an `InstancedMesh`, so three.js adds no
   instance matrix, and no morph, skinning or displacement is set.
3. One mat4 times vec4(p, 1.0). `PointsNodeMaterial.setupPositionView`
   (`three/src/materials/nodes/PointsNodeMaterial.js:86`) returns
   `modelViewMatrix.mul( vec3( positionNode || positionLocal ) ).xyz`. A mat4
   times a vec3 is emitted as `mat4 * vec4(p, 1.0)`
   (`three/src/nodes/core/NodeBuilder.js:3424`).
4. The model-view is composed in binary64 and narrowed once.
   `modelViewMatrix` resolves to `builder.context.modelViewMatrix` when it is
   set (`three/src/nodes/accessors/ModelNode.js:130`); otherwise to
   `cameraViewMatrix.mul( modelWorldMatrix )`, a product on the GPU in binary32
   (`ModelNode.js:142`), which would NOT match. OLV creates the renderer with
   `renderer.highPrecision = true` (`src/render/viewerRenderBootstrap.ts:111`),
   whose setter assigns `highpModelViewMatrix` to the context
   (`three/src/renderers/common/Renderer.js:1266`). That uniform is computed per
   object as `object.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse,
   object.matrixWorld )` in JavaScript numbers (`ModelNode.js:190`) and narrowed
   to binary32 when it is uploaded. The mesh's world matrix carries the layer
   placement `sourceToProject - renderOrigin`, folded in binary64.
5. Precision. The WebGL 2 fallback emits `#version 300 es` with
   `precision highp float;`
   (`three/src/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js:118`); WGSL
   has only `f32`.
6. What follows is outside the bound. `PointsNodeMaterial.setupVertexSprite`
   projects `e` and then adds the quad offset in clip space
   (`PointsNodeMaterial.js:96`, `:158`).

`Viewer.cloudModelView64` (`src/render/Viewer.ts:4227`) recomposes the same
product, `camera.matrixWorldInverse x mesh.matrixWorld`, for the active camera
(perspective or orthographic), so the checker sees the matrix three.js uploads.

## Inputs

- `{rho, r}` per cloud: OLV does not keep binary64 source positions after
  load, so `r` is the per-axis maximum of the stored Float32 buffer and `rho`
  is half the Float32 spacing at `r`, the largest error one round-to-nearest
  narrowing of a binary64 local value can leave there. This is an upper bound
  on the measured `rho` that `encodeTile` would give from the binary64 values
  (tested). Computed once per buffer and cached.
- Tolerance: 1 mm (`DRAW_PRECISION_TAU_METRES`), converted to source units
  through the CRS linear unit. With no established linear unit, or a vertical
  unit that differs from the horizontal one, the bound is shown in source units
  and not graded.
- Contract: `rn` (round to nearest, ties to even).

## Where it shows

The Inspector's scan report, next to "In-memory resolution": "Draw precision
bound" (headline) and "Draw bound scope" (advanced). The value is for the
camera at the moment the report was generated; the report reruns when the
active scan, CRS or class filter changes, not on every camera move. Streaming
scans use a separate report and do not show the rows. Export manifests do not
carry it, because it describes a view, not the data.
