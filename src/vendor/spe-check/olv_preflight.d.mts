// SPDX-License-Identifier: MIT
// Type declarations for the vendored olv_preflight.mjs (A. Urias, MIT; see LICENSE in this directory).
import type { CheckResult, EncodedTile, Vec3 } from './spe_check.mjs';

export declare const EXPRESSION_GLSL: 'glsl-es300-highp-mat4-vec4';
export declare const EXPRESSION_WGSL: 'wgsl-mat4x4f-vec4f';
export declare function rowMajor(m: ArrayLike<number>): number[][];
export declare function composeModelView64(view: ArrayLike<number>, model: ArrayLike<number>): Float64Array;
export declare function encodeTile(positions64: ArrayLike<number>, origin: ArrayLike<number>): EncodedTile;
export declare function preflightDraw(args: {
  modelView64: ArrayLike<number>;
  tile: { rho: Vec3; r: Vec3 };
  tau: number | null | undefined;
  contract?: string;
  expression?: string;
}): CheckResult;
export declare function minSeparation(enc: ArrayLike<number>): number;
export declare function pairMargin(dMin: number, bound: number): number;
export { SUPPORTED_EXPRESSIONS, boundAffineDraw } from './spe_check.mjs';
