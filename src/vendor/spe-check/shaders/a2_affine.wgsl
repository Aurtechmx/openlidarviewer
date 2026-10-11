// Supported expression 'wgsl-mat4x4f-vec4f' (spe_check.SUPPORTED_EXPRESSIONS).
// The per-draw bound covers exactly the eye-space position `e`: one affine mat4x4f (last row 0,0,0,1) times
// vec4f(p, 1.0), f32, in any summation order with or without fusion (WGSL permits both). Projection and the
// division by w are a separate step that the bound does not cover.
struct U { model_view : mat4x4f, projection : mat4x4f };
@group(0) @binding(0) var<uniform> u : U;
struct Out { @builtin(position) clip : vec4f, @location(0) eye : vec3f };
@vertex fn main(@location(0) position : vec3f) -> Out {
  let e = u.model_view * vec4f(position, 1.0);   // <-- bounded expression
  var o : Out;
  o.eye = e.xyz;
  o.clip = u.projection * e;                     // not covered
  return o;
}
