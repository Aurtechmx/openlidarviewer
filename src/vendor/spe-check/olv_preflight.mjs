// SPDX-License-Identifier: MIT
// Viewer-side adapter for the SPE per-draw check (spe_check.mjs).
// It converts the column-major Float64 matrices used by WebGL libraries (three.js Matrix4.elements, gl-matrix mat4)
// into the row-major 3x4/4x4 form the checker expects, composes model and view in binary64 (strategy A2), and runs
// checkDraw once per draw. Nothing here changes the bound: it only prepares inputs and caches per-tile quantities.
import { checkDraw, encodeLocal, boundAffineDraw, SUPPORTED_EXPRESSIONS } from './spe_check.mjs';

export const EXPRESSION_GLSL = 'glsl-es300-highp-mat4-vec4';
export const EXPRESSION_WGSL = 'wgsl-mat4x4f-vec4f';

/** Column-major 16-element matrix (Float64Array or plain array) -> row-major nested 4x4 array. */
export function rowMajor(m) {
  if (!m || m.length !== 16) throw new TypeError('expected a 16-element column-major matrix');
  return [0, 1, 2, 3].map(i => [m[i], m[4 + i], m[8 + i], m[12 + i]]);
}

/** view * model for column-major 16-element matrices, in binary64 (JavaScript numbers). Returns column-major. */
export function composeModelView64(view, model) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += view[4 * k + r] * model[4 * c + k];
    out[4 * c + r] = s;
  }
  return out;
}

/**
 * Per-tile encoding, computed once when a tile is loaded and cached with it.
 * positions64: flat Float64Array [x0,y0,z0, x1,...] of world (or source) coordinates; origin: [ox,oy,oz] in binary64.
 * Returns the binary32 vertex buffer and the rho (storage error) and r (extent) vectors the bound needs.
 */
export function encodeTile(positions64, origin) {
  return encodeLocal(positions64, origin);
}

/**
 * One-call preflight for a draw.
 *   modelView64: column-major 16-element binary64 matrix that the shader receives as u_modelView (narrowed once),
 *                with the tile origin folded into the model matrix.
 *   tile:        { rho, r } from encodeTile (cached per tile).
 *   tau:         positional tolerance in metres (application requirement).
 *   expression:  the shader expression actually used; must be one of SUPPORTED_EXPRESSIONS, otherwise the bound
 *                state is NOT_TESTED.
 * Returns the checker result: { boundState, bound, clean, unsupportedReason, ... }.
 */
export function preflightDraw({ modelView64, tile, tau, contract = 'rn', expression = EXPRESSION_GLSL }) {
  return checkDraw(tau, tile.rho, tile.r, rowMajor(modelView64), contract, { expression });
}

/**
 * Smallest separation of the tile's local coordinates, for the pair margin m = d_min / (2B).
 * O(n) expected time with a uniform grid; compute once per tile and cache. Floating-point result: use it for
 * reporting and LOD decisions. The paper's exact certificate (Supplement S19) is an offline audit, not this function.
 */
export function minSeparation(enc) {
  const n = enc.length / 3;
  if (n < 2) return Infinity;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const x = enc[3 * i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  let h = ext / Math.cbrt(n);                      // about one point per cell
  for (;;) {
    const cells = new Map(), key = (a, b, c) => `${a},${b},${c}`;
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor((enc[3 * i] - lo[0]) / h), Math.floor((enc[3 * i + 1] - lo[1]) / h), Math.floor((enc[3 * i + 2] - lo[2]) / h));
      (cells.get(k) || cells.set(k, []).get(k)).push(i);
    }
    let best = Infinity;
    for (const [k, idx] of cells) {
      const [a, b, c] = k.split(',').map(Number);
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const other = cells.get(key(a + da, b + db, c + dc)); if (!other) continue;
        for (const i of idx) for (const j of other) {
          if (j <= i) continue;
          const dx = enc[3 * i] - enc[3 * j], dy = enc[3 * i + 1] - enc[3 * j + 1], dz = enc[3 * i + 2] - enc[3 * j + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d < best) best = d;
        }
      }
    }
    if (best < h) return best;                     // any closer pair would lie in neighbouring cells
    h *= 2;
  }
}

/**
 * Pair margin m = d_min / (2B). With a rigid model-view (rotation and translation, no scale), m > 1 means the bound
 * keeps every pair of the tile's points distinct. With scaling, multiply d_min by the smallest singular value of the
 * linear part first.
 */
export function pairMargin(dMin, bound) {
  return dMin / (2 * bound);
}

export { SUPPORTED_EXPRESSIONS, boundAffineDraw };
