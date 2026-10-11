/**
 * speCheckVendor.test.ts: the vendored spe-check checker (src/vendor/spe-check/,
 * MIT, A. Urias) is the published code, and it behaves as upstream's own tests
 * say. Ports test_spe_check.js (39 checks) and test_olv_preflight.mjs.
 *
 * Pins:
 *  - tests/fixtures/spe-check/spe_check.js.txt is upstream spe_check.js, kept as
 *    text (loaded here as CommonJS through node:vm) so it is data, not a module,
 *    SHA-256 53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b;
 *  - the vendored spe_check.mjs is that file with only the documented
 *    mechanical edits (ESM banner comment, no 'use strict', export statement);
 *  - the two builds return bit-identical bounds on random affine draws.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../src/vendor/spe-check/spe_check.mjs';
import {
  rowMajor,
  composeModelView64,
  encodeTile,
  preflightDraw,
  minSeparation,
  pairMargin,
  EXPRESSION_GLSL,
} from '../src/vendor/spe-check/olv_preflight.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_SHA256 = '53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b';
const CJS_PATH = resolve(ROOT, 'tests/fixtures/spe-check/spe_check.js.txt');
const ESM_PATH = resolve(ROOT, 'src/vendor/spe-check/spe_check.mjs');
/** The upstream CommonJS build, evaluated with a fresh `module` object. */
function loadCjs(): typeof S {
  const mod = { exports: {} as unknown };
  runInNewContext(readFileSync(CJS_PATH, 'utf8'), { module: mod, Math, Number, Array, ArrayBuffer, Float64Array, BigInt64Array, Object, Error, TypeError });
  return mod.exports as typeof S;
}
const C = loadCjs();

const I = (): number[][] => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

describe('vendored source identity', () => {
  it('the upstream fixture carries the published SHA-256', () => {
    const h = createHash('sha256').update(readFileSync(CJS_PATH)).digest('hex');
    expect(h).toBe(UPSTREAM_SHA256);
  });

  it('spe_check.mjs is the upstream code with only the export statement changed', () => {
    const cjs = readFileSync(CJS_PATH, 'utf8').split('\n');
    const esm = readFileSync(ESM_PATH, 'utf8').split('\n');
    // Mechanical transform, line for line.
    const expected = [...cjs];
    expected.splice(1, 0, '// ES-module build of spe_check.js, generated mechanically: identical code, ES exports instead of module.exports.');
    const strict = expected.indexOf("'use strict';");
    expect(strict).toBeGreaterThan(0);
    expected.splice(strict, 1);
    const exp = expected.findIndex((l) => l.startsWith("if (typeof module !== 'undefined') module.exports = {"));
    expect(exp).toBeGreaterThan(0);
    expected[exp] = expected[exp].replace("if (typeof module !== 'undefined') module.exports = {", 'export {');
    expect(esm).toEqual(expected);
  });
});

describe('upstream test_spe_check.js', () => {
  it('underflow product is covered', () => {
    const A = I(); A[0][0] = 2 ** -100;
    const b = S.boundAffineDraw([0, 0, 0], [2 ** -100, 0, 0], A);
    expect(Math.fround(Math.fround(2 ** -100) * Math.fround(2 ** -100))).toBe(0);
    expect(2 ** -200).toBeLessThanOrEqual(b);
  });

  it('overflow is rejected', () => {
    const A = I(); A[0][0] = 2 ** 100;
    expect(() => S.boundAffineDraw([0, 0, 0], [2 ** 100, 0, 0], A)).toThrow(S.UnsupportedDraw);
  });

  it('a projective matrix is rejected and checkDraw reports NOT_TESTED', () => {
    const P = I(); P[3][0] = 1;
    expect(() => S.boundAffineDraw([0, 0, 0], [1, 1, 1], P)).toThrow(S.UnsupportedDraw);
    const ev = S.checkDraw(1e-3, [0, 0, 0], [1, 1, 1], P);
    expect(ev.boundState).toBe('NOT_TESTED');
    expect(ev.clean).toBe(false);
  });

  it.each([2 ** -127, 2 ** 101, NaN, Infinity])('coefficient %s is rejected', (bad) => {
    const A = I(); A[1][2] = bad;
    expect(() => S.boundAffineDraw([0, 0, 0], [1, 1, 1], A)).toThrow(S.UnsupportedDraw);
  });

  it.each([
    [[-1, 0, 0], [1, 1, 1]],
    [[0, 0, 0], [-1, 1, 1]],
    [[0, 0], [1, 1, 1]],
    [[NaN, 0, 0], [1, 1, 1]],
  ])('bad vectors %j are rejected', (rho, r) => {
    expect(() => S.boundAffineDraw(rho, r, I())).toThrow(S.UnsupportedDraw);
  });

  it('an unknown contract is rejected; a 3x4 matrix is accepted', () => {
    expect(() => S.boundAffineDraw([0, 0, 0], [1, 1, 1], I(), 'nearest-maybe')).toThrow(S.UnsupportedDraw);
    expect(S.boundAffineDraw([0, 0, 0], [1, 1, 1], I().slice(0, 3))).toBeGreaterThan(0);
  });

  it.each([
    [1e-3, { bound: -1 }],
    [1e-3, { measured: -5 }],
    [1e-3, { bound: NaN, measured: 1e-4 }],
    [NaN, {}],
    [-1e-3, {}],
    [0, {}],
    [1e-3, { bound: 'x' }],
  ])('invalid evidence %j throws', (tau, kw) => {
    expect(() => S.evaluateEvidence(tau as number, kw as never)).toThrow(S.InvalidEvidence);
  });

  it('contradiction, no evidence, undeclared and supported expressions, zero rows', () => {
    const r1 = S.evaluateEvidence(1e-3, { bound: 4e-4, measured: 5e-4 });
    expect(!r1.consistent && !r1.clean).toBe(true);
    expect(S.evaluateEvidence(1e-3, {}).clean).toBe(false);
    const u = S.checkDraw(1e-3, [1e-6, 1e-6, 1e-6], [10, 10, 10], I(), 'rn');
    expect(u.boundState === 'NOT_TESTED' && u.bound !== null && !u.expressionSupported).toBe(true);
    const s = S.checkDraw(1e-3, [1e-6, 1e-6, 1e-6], [10, 10, 10], I(), 'rn', { expression: 'wgsl-mat4x4f-vec4f' });
    expect(s.boundState === 'PASS_BOUND' && s.clean).toBe(true);
    const Z = I(); for (let i = 0; i < 3; i++) Z[i] = [0, 0, 0, 0];
    const b = S.boundAffineDraw([0, 0, 0], [1, 1, 1], Z);
    expect(Number.isFinite(b) && b > 0).toBe(true);
  });

  it('measurement-interval semantics', () => {
    const E = (o: Parameters<typeof S.evaluateEvidence>[1]) => S.evaluateEvidence(1, o);
    let r = E({ bound: 1, measured: 1.05, eta: 0.1 });
    expect([r.measuredState, r.verificationState, r.boundState]).toEqual(['INCONCLUSIVE_MEASURED', 'CONSISTENT', 'PASS_BOUND']);
    r = E({ bound: 2, measured: 0.95, eta: 0.1 });
    expect(r.measuredState === 'INCONCLUSIVE_MEASURED' && !r.clean).toBe(true);
    r = E({ bound: 2, measured: 0.8, eta: 0.1 });
    expect(r.measuredState === 'PASS_MEASURED' && r.clean).toBe(true);
    r = E({ bound: 1, measured: 1.2, eta: 0.1 });
    expect(r.measuredState === 'FAIL_MEASURED' && r.verificationState === 'VERIFICATION_ERROR' && !r.clean).toBe(true);
    r = E({ measured: 0, eta: 0 });
    expect(r.measuredState === 'PASS_MEASURED' && r.clean).toBe(true);
    r = E({ measured: [] });
    expect(r.measuredState === 'NOT_TESTED' && !r.clean).toBe(true);
    for (const bad of [{ measured: 1, eta: -1 }, { measured: 1, eta: NaN }, { bound: Infinity }, { measured: -0.1 }, { measured: [1, 2], eta: [0.1, 0.1, 0.1] }]) {
      expect(() => E(bad)).toThrow(S.InvalidEvidence);
    }
  });

  it('outward interval endpoint and the exact evaluator at tau', () => {
    expect(1 + 2 ** -53).toBe(1);
    expect(S.evaluateEvidence(1, { measured: 1, eta: 2 ** -53 }).measuredState).toBe('INCONCLUSIVE_MEASURED');
    expect(S.evaluateEvidence(1, { measured: 1, eta: 0 }).measuredState).toBe('PASS_MEASURED');
  });
});

describe('upstream test_olv_preflight.mjs', () => {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  it('the ES-module build returns bit-identical bounds to the CommonJS checker (500 draws x 2 contracts)', () => {
    let mismatches = 0;
    for (let t = 0; t < 500; t++) {
      const A = [0, 1, 2].map(() => [0, 1, 2, 3].map(() => (rnd() - 0.5) * 10 ** Math.floor(rnd() * 8 - 2)));
      A.push([0, 0, 0, 1]);
      const rho = [rnd() * 1e-5, rnd() * 1e-5, rnd() * 1e-5], r = [rnd() * 1e3, rnd() * 1e3, rnd() * 1e2];
      for (const c of ['rn', 'faithful']) {
        let a: unknown, b: unknown;
        try { a = C.boundAffineDraw(rho, r, A, c); } catch (e) { a = (e as Error).name; }
        try { b = S.boundAffineDraw(rho, r, A, c); } catch (e) { b = (e as Error).name; }
        if (!Object.is(a, b)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('column-major conversion and binary64 composition', () => {
    const T = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    const R = rowMajor(T);
    expect([R[0][3], R[1][3], R[2][3], R[3][3]]).toEqual([5, 6, 7, 1]);
    const V = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, -6, -7.5, 1]);
    const MV = composeModelView64(V, T);
    expect([MV[12], MV[13], MV[14]]).toEqual([0, 0, -0.5]);
  });

  it('a local tile far from the origin passes 1 mm; an undeclared expression is NOT_TESTED; minSeparation and pairMargin', () => {
    seed = 7;
    for (let i = 0; i < 9000; i++) rnd(); // advance past the 500 draws above (18 draws each), as upstream does
    const pts = new Float64Array(3000);
    for (let i = 0; i < pts.length; i++) pts[i] = 3.2e6 + (rnd() - 0.5) * 1000;
    const origin = [3.2e6, 3.2e6, 3.2e6], tile = encodeTile(pts, origin);
    const model = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...origin, 1]);
    const view = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -origin[0] - 300, -origin[1] + 400, -origin[2] - 250, 1]);
    const res = preflightDraw({ modelView64: composeModelView64(view, model), tile, tau: 1e-3, expression: EXPRESSION_GLSL });
    expect(res.boundState).toBe('PASS_BOUND');
    expect(res.bound).toBeLessThan(1e-3);
    const res2 = preflightDraw({ modelView64: composeModelView64(view, model), tile, tau: 1e-3, expression: 'my-custom-shader' });
    expect(res2.boundState).toBe('NOT_TESTED');
    const small = tile.enc.subarray(0, 600);
    let bf = Infinity;
    for (let i = 0; i < 200; i++) for (let j = i + 1; j < 200; j++) {
      const d = Math.hypot(small[3 * i] - small[3 * j], small[3 * i + 1] - small[3 * j + 1], small[3 * i + 2] - small[3 * j + 2]);
      if (d < bf) bf = d;
    }
    expect(Math.abs(minSeparation(small) - bf)).toBeLessThanOrEqual(1e-12 * bf);
    expect(pairMargin(2, 0.5)).toBe(2);
  });
});
