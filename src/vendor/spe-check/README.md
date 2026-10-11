# spe-check for OpenLiDARViewer 0.7

Per-draw positional bound from "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU" (A. Urias). Before a draw, it returns an upper bound on the eye-space position error of `u_modelView * vec4(a_position, 1.0)` and compares it with a tolerance.

## Files

| File | Purpose |
|---|---|
| `spe_check.js` | The checker, byte-identical to `code/spe_check.js` in the paper package (SHA-256 `53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b`). CommonJS, or a plain `<script>`. |
| `spe_check.mjs` | The same code as an ES module (only the export statement differs). |
| `olv_preflight.mjs` | Adapter for column-major Float64 matrices (three.js `Matrix4.elements`, gl-matrix): composes view × model in binary64, encodes tiles, runs the check, computes the pair margin. |
| `shaders/a2_affine.glsl`, `.wgsl` | The two shader expressions the bound covers. |
| `test_spe_check.js`, `test_olv_preflight.mjs` | `node test_spe_check.js && node test_olv_preflight.mjs` (39 and 1006 checks). |
| `LICENSE` | MIT. OLV itself is AGPL-3.0; MIT code can be included in an AGPL project. Keep the SPDX headers. |

## Integration

1. **When a tile loads:** subtract its origin in binary64 and narrow it with `encodeTile(positions64, origin)`. Upload `enc` as the vertex buffer and cache `{rho, r}` with the tile. If LOD or pair margins are wanted, also cache `minSeparation(enc)`.
2. **Every frame, for each draw:** compose `modelView64 = composeModelView64(view, model)` with the tile origin in `model`. Upload it once as `u_modelView`, then call:

   ```js
   const res = preflightDraw({ modelView64, tile, tau: 0.001 });   // tau in metres
   if (res.boundState === 'PASS_BOUND') { /* draw */ } else { /* re-origin, split the tile, or flag the view */ }
   ```

   `res.bound` is the bound in metres, and `pairMargin(dMin, res.bound) > 1` means no two points of the tile can merge. The call costs about 0.4 µs on a desktop CPU. `dMin` is cached per tile, so the margin adds one division.
3. **The shader must match the declared expression.** The bound covers only `u_modelView * vec4(a_position, 1.0)`, in `highp` GLSL ES 3.00 or WGSL `f32`, as in `shaders/`.
   - If OLV's vertex shader evaluates `V * (M * p)` instead, or adds other terms, pass a different `expression`. The result is then `NOT_TESTED`, which is correct.
   - Projection and the division by w are not covered.
4. **Recheck whenever the inputs change:** camera, model matrix, origin, encoding, tile extent or LOD switch. If only `tau` changes, the bound stays the same and only the comparison is redone.

## Scope

- The bound holds under the declared arithmetic contract (`'rn'` or `'faithful'`) and the shader expression above.
- It is stated for the binary64 values the host holds. It says nothing about survey accuracy.
- `minSeparation` uses floating-point arithmetic and is for reporting and LOD only. The exact pair certificate in the paper's Supplement S19 is an offline audit.

## Citation

Cite the paper. The checker's version is the SHA-256 above.
