/**
 * drawPrecision.ts: the per-draw precision bound as a diagnostic.
 *
 * Wraps the vendored spe-check checker (`src/vendor/spe-check/`, MIT, A. Urias,
 * from the paper "Per-Draw Precision Bounds for Large-Coordinate Rendering in
 * WebGL2 and WebGPU"). For one cloud and one camera it returns an upper bound
 * on the error of the eye-space point position `modelView * vec4(p, 1.0)` as
 * the GPU evaluates it in binary32, and compares it with a tolerance.
 *
 * What the bound covers: the eye-space position of each point centre, before
 * projection, under the declared arithmetic contract (round to nearest binary32)
 * and only when the shader evaluates exactly the declared expression. What it
 * does not cover: the projection multiply, the division by w, the point sprite
 * offset added in clip space, depth encoding, and anything about survey
 * accuracy. A draw path whose shader is not verified against the declared
 * expression is reported NOT_TESTED, never PASS. The mapping is documented, with
 * evidence, in docs/architecture/draw-precision-contract.md and pinned by
 * tests/drawPrecisionShaderContract.test.ts.
 *
 * A DIAGNOSTIC, NOT A DRAW GATE. Nothing here is consulted by the render loop;
 * it runs when a report asks for it.
 *
 * Pure: no DOM, no three.js. Runs unchanged in Node tests.
 */

import { float32Spacing } from '../geo/inMemoryPrecision';
import {
  EXPRESSION_GLSL,
  EXPRESSION_WGSL,
  encodeTile,
  preflightDraw,
} from '../vendor/spe-check/olv_preflight.mjs';

/** Method id in `methodRegistry.ts`. */
export const DRAW_PRECISION_METHOD_ID = 'olv.render.draw-precision-bound';

/**
 * Default tolerance: 1 mm in metres. Converted to source units through the
 * CRS linear unit before the comparison; with no established unit there is no
 * comparison at all (the bound is reported in source units, ungraded).
 */
export const DRAW_PRECISION_TAU_METRES = 1e-3;

/** The arithmetic contract the bound is stated under (round to nearest, ties to even). */
export const DRAW_PRECISION_CONTRACT: DrawContract = 'rn';

/** The expression name passed for a draw path whose shader is not verified. */
export const UNVERIFIED_EXPRESSION = 'olv-unverified-point-path';

export type RenderBackend = 'webgpu' | 'webgl2';

/**
 * Which point draw path produced the draw.
 *
 * - `instanced-quad-highp`: the shared `Viewer.buildPointMesh` mesh (a
 *   `PointsNodeMaterial` on an instanced quad, `positionNode` = the Float32
 *   local centre) drawn by a renderer with `highPrecision = true`. Verified to
 *   evaluate `highpModelViewMatrix * vec4(centre, 1.0)` with the model-view
 *   composed in binary64 on the CPU and narrowed once.
 * - `unverified`: any other path. Always NOT_TESTED.
 */
export type DrawPath = 'instanced-quad-highp' | 'unverified';

/** The per-cloud quantities the bound needs, computed once and cached. */
export interface DrawTile {
  /** Per-axis upper bound on the storage (narrowing) error of the local coordinates. */
  readonly rho: readonly [number, number, number];
  /** Per-axis maximum absolute local coordinate. */
  readonly r: readonly [number, number, number];
  /**
   * `measured`: rho taken from the binary64 source values (`encodeTile`).
   * `narrowing-bound`: only the stored Float32 buffer is resident, so rho is
   * the worst-case round-to-nearest narrowing error at the axis reach, half the
   * Float32 spacing at `r`. That is an upper bound on the measured rho whenever
   * each stored coordinate was produced by one round-to-nearest narrowing of
   * a binary64 local value, which is how a `Float32Array` store behaves.
   */
  readonly basis: 'measured' | 'narrowing-bound';
}

/** What a report needs to evaluate the bound for the current view. */
export interface DrawPrecisionView {
  /** Column-major binary64 model-view, as three.js composes it for this mesh. */
  readonly modelView64: ArrayLike<number>;
  readonly backend: RenderBackend;
  readonly path: DrawPath;
}

export type DrawPrecisionState = 'PASS' | 'NOT_CERTIFIED' | 'NOT_TESTED' | 'UNGRADED';

export interface DrawPrecisionDiagnostic {
  readonly state: DrawPrecisionState;
  /** The bound in source units; null when NOT_TESTED. */
  readonly boundSourceUnits: number | null;
  /** The bound in metres; null when NOT_TESTED or no unit is established. */
  readonly boundMetres: number | null;
  /** The tolerance in metres; null when no comparison was made. */
  readonly tauMetres: number | null;
  readonly expression: string;
  readonly backend: RenderBackend;
  readonly tileBasis: DrawTile['basis'];
  /** Why the state is NOT_TESTED or UNGRADED; null otherwise. */
  readonly reason: string | null;
  /** The arithmetic contract the bound is stated under. */
  readonly contract: DrawContract;
  /** The checker's own evidence record for this draw, when it evaluated one. */
  readonly evidence: DrawEvidence | null;
}

/** Round to nearest (`rn`), or the looser `faithful` rounding the WGSL and GLSL ES specs guarantee. */
export type DrawContract = 'rn' | 'faithful';

/** The checker's evidence states for one draw (the paper's Table 3). */
export interface DrawEvidence {
  readonly boundState: string;
  readonly measuredState: string;
  readonly verificationState: string;
  readonly clean: boolean;
}

/** The expression a draw path evaluates, or the unverified marker. */
export function shaderExpressionFor(backend: RenderBackend, path: DrawPath): string {
  if (path !== 'instanced-quad-highp') return UNVERIFIED_EXPRESSION;
  return backend === 'webgpu' ? EXPRESSION_WGSL : EXPRESSION_GLSL;
}

const tileCache = new WeakMap<Float32Array, DrawTile>();

/**
 * {rho, r} from a resident Float32 local buffer. O(n) once per buffer, then
 * cached by buffer identity (positions are written once by the loader).
 */
export function tileFromLocalFloat32(positions: Float32Array): DrawTile {
  const hit = tileCache.get(positions);
  if (hit) return hit;
  const r: [number, number, number] = [0, 0, 0];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = Math.abs(positions[i + k]);
      if (a > r[k]) r[k] = a;
    }
  }
  const rho: [number, number, number] = [
    float32Spacing(r[0]) / 2,
    float32Spacing(r[1]) / 2,
    float32Spacing(r[2]) / 2,
  ];
  const tile: DrawTile = { rho, r, basis: 'narrowing-bound' };
  tileCache.set(positions, tile);
  return tile;
}

/** {rho, r} measured from binary64 source positions and the origin subtracted from them. */
export function tileFromFloat64(positions64: ArrayLike<number>, origin: readonly [number, number, number]): DrawTile {
  const t = encodeTile(positions64, origin);
  return {
    rho: [t.rho[0], t.rho[1], t.rho[2]],
    r: [t.r[0], t.r[1], t.r[2]],
    basis: 'measured',
  };
}

export interface DrawPrecisionUnit {
  /** Whether the CRS declares a real linear unit. */
  readonly linearUnitKnown: boolean;
  readonly linearUnitToMetres: number;
  /** Vertical factor, when one is declared; a different factor leaves the bound ungraded. */
  readonly verticalUnitToMetres?: number;
  /**
   * The source declares a vertical unit that cannot be read. One axis then
   * has no metre factor, so the bound is left ungraded: it never borrows the
   * horizontal factor, which is only a fallback for an undeclared vertical.
   */
  readonly verticalScaleInvalid?: boolean;
}

/** The unit facts of a spatial context, as the shape {@link drawPrecisionUnitOf} reads. */
export interface DrawPrecisionUnitFacts {
  readonly linearUnitToMetres: number;
  readonly verticalUnitToMetres?: number;
  readonly verticalScaleState: 'valid' | 'absent' | 'invalid';
}

/**
 * The unit the bound is graded under, built the one way the panel, the
 * certificate and the scan report all use. `horizontalKnown` is the caller's
 * gate for ground metres; `zUp` passes the vertical factor only when storage
 * axis Z is the vertical one.
 */
export function drawPrecisionUnitOf(
  ctx: DrawPrecisionUnitFacts,
  opts: { readonly horizontalKnown: boolean; readonly zUp: boolean },
): DrawPrecisionUnit {
  return {
    linearUnitKnown: opts.horizontalKnown,
    linearUnitToMetres: ctx.linearUnitToMetres,
    verticalUnitToMetres: opts.zUp ? ctx.verticalUnitToMetres : undefined,
    verticalScaleInvalid: ctx.verticalScaleState === 'invalid',
  };
}

/** Evaluate the bound for one cloud tile and one view. Never throws for a bad draw. */
export function evaluateDrawPrecision(
  tile: DrawTile,
  view: DrawPrecisionView,
  unit: DrawPrecisionUnit,
  tauMetres: number = DRAW_PRECISION_TAU_METRES,
  contract: DrawContract = DRAW_PRECISION_CONTRACT,
): DrawPrecisionDiagnostic {
  const expression = shaderExpressionFor(view.backend, view.path);
  const f = unit.linearUnitToMetres;
  const verticalInvalid = unit.verticalScaleInvalid === true;
  const mixedUnits = unit.verticalUnitToMetres !== undefined && unit.verticalUnitToMetres !== f;
  const graded = unit.linearUnitKnown && Number.isFinite(f) && f > 0 && !mixedUnits && !verticalInvalid;
  const base = { expression, backend: view.backend, tileBasis: tile.basis, contract, evidence: null };
  let res;
  try {
    res = preflightDraw({
      modelView64: view.modelView64,
      tile,
      tau: graded ? tauMetres / f : null,
      contract,
      expression,
    });
  } catch (e) {
    return { ...base, state: 'NOT_TESTED', boundSourceUnits: null, boundMetres: null, tauMetres: null, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.expressionSupported || res.bound === null) {
    const reason = !res.expressionSupported
      ? 'the point shader path is not verified against the declared expression'
      : (res.unsupportedReason ?? 'the draw is outside the checker domain');
    return { ...base, state: 'NOT_TESTED', boundSourceUnits: null, boundMetres: null, tauMetres: null, reason };
  }
  const evidence: DrawEvidence = {
    boundState: res.boundState, measuredState: res.measuredState, verificationState: res.verificationState, clean: res.clean,
  };
  if (!graded) {
    return {
      ...base,
      evidence,
      state: 'UNGRADED',
      boundSourceUnits: res.bound,
      boundMetres: null,
      tauMetres: null,
      reason: verticalInvalid
        ? 'the vertical unit could not be interpreted'
        : mixedUnits ? 'horizontal and vertical units differ' : 'no linear unit declared',
    };
  }
  return {
    ...base,
    evidence,
    state: res.boundState === 'PASS_BOUND' ? 'PASS' : 'NOT_CERTIFIED',
    boundSourceUnits: res.bound,
    boundMetres: res.bound * f,
    tauMetres,
    reason: null,
  };
}
