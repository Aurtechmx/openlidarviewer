#version 300 es
// Supported expression 'glsl-es300-highp-mat4-vec4' (spe_check.SUPPORTED_EXPRESSIONS).
// The per-draw bound covers exactly the eye-space position `e`: one affine mat4 (bottom row 0,0,0,1) times
// vec4(p, 1.0), highp, evaluated by the driver in any summation order with or without fusion.
// The projection multiply and the division by w are a separate step that the bound does not cover.
precision highp float;
uniform highp mat4 u_modelView;   // Float64-composed V*M, narrowed once on the host (strategy A2)
uniform highp mat4 u_projection;
in highp vec3 a_position;         // local coordinates (tile origin subtracted in Float64, then narrowed)
out highp vec3 v_eye;
void main() {
  highp vec4 e = u_modelView * vec4(a_position, 1.0);   // <-- bounded expression
  v_eye = e.xyz;
  gl_Position = u_projection * e;                       // not covered
}
