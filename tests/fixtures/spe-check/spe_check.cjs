// SPDX-License-Identifier: MIT
// SPE per-draw check, JavaScript port of spe_check.py: same contracts, validator, range model, underflow term and
// host inflation. See spe_check.py for the operation model and the host-evaluation argument.
'use strict';
const CONTRACTS = { rn: 2 ** -24, faithful: 2 ** -23 };   // rn: round to nearest, ties to even; faithful: either adjacent value
const SUPPORTED_EXPRESSIONS = { 'glsl-es300-highp-mat4-vec4': 'shaders/a2_affine.glsl', 'wgsl-mat4x4f-vec4f': 'shaders/a2_affine.wgsl' };
const LAMBDA = 2 ** -126, N_OPS = 7, ROW_LIMIT = 2 ** 126, COEF_MIN = 2 ** -126, COEF_MAX = 2 ** 100, EXTENT_MAX = 2 ** 100;
const HOST_INFLATION = 1 + 2 ** -40;
const gamma = (n, u) => n * u / (1 - n * u);
const fr = Math.fround;

class UnsupportedDraw extends Error { constructor(m) { super(m); this.name = 'UnsupportedDraw'; } }
class InvalidEvidence extends Error { constructor(m) { super(m); this.name = 'InvalidEvidence'; } }

function encodeLocal(P64, origin) {
  const n = P64.length / 3, enc = new Float32Array(P64.length), rho = [0, 0, 0], r = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const x = P64[3 * i + k] - origin[k], e = fr(x); enc[3 * i + k] = e;
    rho[k] = Math.max(rho[k], Math.abs(e - x)); r[k] = Math.max(r[k], Math.abs(e));
  }
  return { enc, rho, r };
}

function vec3(v, name) {
  if (!Array.isArray(v) && !(ArrayBuffer.isView(v))) throw new UnsupportedDraw(`${name} must be an array of length 3`);
  if (v.length !== 3) throw new UnsupportedDraw(`${name} must have length 3`);
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new UnsupportedDraw(`${name} must be finite`);
    if (x < 0) throw new UnsupportedDraw(`${name} must be non-negative`);
    if (x > EXTENT_MAX) throw new UnsupportedDraw(`${name} exceeds 2^100`);
  }
  return Array.from(v);
}

// A64: 3x4 or 4x4 (affine) row-major array of rows, binary64.
function validateDraw(rho, r, A64, contract = 'rn') {
  const u = CONTRACTS[contract]; if (u === undefined) throw new UnsupportedDraw(`unknown arithmetic contract ${contract}`);
  if (!Array.isArray(A64) || (A64.length !== 3 && A64.length !== 4) || A64.some(row => !row || row.length !== 4))
    throw new UnsupportedDraw('matrix must be 4x4 affine or 3x4');
  if (A64.length === 4) { const b = A64[3]; if (!(b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1)) throw new UnsupportedDraw('projective or non-affine matrix (bottom row is not [0,0,0,1])'); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
    const a = A64[i][j];
    if (typeof a !== 'number' || !Number.isFinite(a)) throw new UnsupportedDraw('non-finite matrix coefficient');
    const m = Math.abs(a); if (m !== 0 && (m < COEF_MIN || m > COEF_MAX)) throw new UnsupportedDraw('nonzero coefficient outside [2^-126, 2^100]');
  }
  rho = vec3(rho, 'rho'); r = vec3(r, 'r');
  const g = gamma(4, u);
  for (let i = 0; i < 3; i++) {
    let s = Math.abs(fr(A64[i][3])), sa = 0;
    for (let j = 0; j < 3; j++) { const at = Math.abs(fr(A64[i][j])); s += at * r[j]; sa += at; }
    if (s * (1 + g) + LAMBDA * (N_OPS + sa) * 2 > ROW_LIMIT) throw new UnsupportedDraw('a partial result could overflow binary32');
  }
  return { rho, r, u };
}

function components(rho, r, A64, u) {
  const g = gamma(4, u), out = { storage: [], coefficients: [], arithmetic: [], underflow: [] };
  for (let i = 0; i < 3; i++) {
    let st = 0, co = 0, ar = 0, sa = 0;
    for (let j = 0; j < 3; j++) {
      const a = A64[i][j], at = fr(a);
      st += Math.abs(a) * rho[j]; co += Math.abs(at - a) * r[j]; ar += Math.abs(at) * r[j]; sa += Math.abs(at);
    }
    const b = A64[i][3], bt = fr(b);
    out.storage.push(st); out.coefficients.push(co + Math.abs(bt - b));
    out.arithmetic.push(g * (ar + Math.abs(bt))); out.underflow.push(LAMBDA * (1 + g) * (N_OPS + sa));
  }
  return out;
}

// Returns the Euclidean norm of the componentwise bound (metres). Explicit sum of squares + Math.sqrt
// (correctly rounded); Math.hypot is implementation-approximated in ECMAScript.
function boundAffineDraw(rho, r, A64, contract = 'rn') {
  const v = validateDraw(rho, r, A64, contract), c = components(v.rho, v.r, A64, v.u);
  let ss = 0;
  for (let i = 0; i < 3; i++) { const x = c.storage[i] + c.coefficients[i] + c.arithmetic[i] + c.underflow[i]; ss += x * x; }
  const b = Math.sqrt(ss) * HOST_INFLATION;
  if (!Number.isFinite(b) || b <= 0) throw new UnsupportedDraw('non-finite or non-positive bound');
  return b;
}

function nonneg(x, name) {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new InvalidEvidence(`${name} must be finite and non-negative`);
  return x;
}

// one-ulp outward steps for interval endpoints (finite, non-NaN inputs)
const _f = new Float64Array(1), _i = new BigInt64Array(_f.buffer);
function nextUp(x) { if (x === 0) return Number.MIN_VALUE; _f[0] = x; _i[0] += x > 0 ? 1n : -1n; return _f[0]; }
function nextDown(x) { return -nextUp(-x); }

function cases(x, name) {
  if (x === null || x === undefined) return null;
  return (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x) : [x]).map(v => nonneg(v, name));
}

// Interval semantics: the exact error of case k lies in [max(0, e_k - eta_k), e_k + eta_k] (see spe_check.py).
function evaluateEvidence(tau, { bound = null, measured = null, eta = 0, arithmeticContractOk = true, measurementDomainOk = true } = {}) {
  if (tau === null || tau === undefined) return { boundState: 'NOT_APPLICABLE', measuredState: 'NOT_APPLICABLE', verificationState: 'NOT_APPLICABLE', consistent: true, clean: false };
  const t = nonneg(tau, 'tau'); if (t === 0) throw new InvalidEvidence('tau must be positive');
  const b = nonneg(bound, 'bound'), es = cases(measured, 'measured'), etas = eta === null || eta === undefined ? [0] : cases(eta, 'eta');
  if (es !== null && etas.length !== 1 && etas.length !== es.length) throw new InvalidEvidence('eta must be a scalar or have one entry per measured case');
  const bs = (b === null || !arithmeticContractOk) ? 'NOT_TESTED' : (b <= t ? 'PASS_BOUND' : 'NOT_CERTIFIED_BOUND');
  let ms = 'NOT_TESTED', lo = [];
  if (es !== null && es.length && measurementDomainOk) {
    const et = etas.length === 1 ? es.map(() => etas[0]) : etas;
    lo = es.map((e, k) => et[k] > 0 ? Math.max(0, nextDown(e - et[k])) : e); const hi = es.map((e, k) => et[k] > 0 ? nextUp(e + et[k]) : e);
    ms = Math.max(...lo) > t ? 'FAIL_MEASURED' : (Math.max(...hi) <= t ? 'PASS_MEASURED' : 'INCONCLUSIVE_MEASURED');
  }
  const verr = bs !== 'NOT_TESTED' && lo.length > 0 && Math.max(...lo) > b;
  const vs = verr ? 'VERIFICATION_ERROR' : (bs !== 'NOT_TESTED' && lo.length ? 'CONSISTENT' : 'NOT_TESTED');
  const clean = !verr && ms !== 'FAIL_MEASURED' && (bs === 'PASS_BOUND' || ms === 'PASS_MEASURED');
  return { boundState: bs, measuredState: ms, verificationState: vs, consistent: !verr, clean };
}

// expression must name a SUPPORTED_EXPRESSIONS entry (the shader actually used); otherwise boundState is NOT_TESTED.
function checkDraw(tau, rho, r, A64, contract = 'rn', { expression = null, measured = null, eta = 0, measurementDomainOk = true } = {}) {
  let bound = null, unsupportedReason = null;
  try { bound = boundAffineDraw(rho, r, A64, contract); } catch (e) { if (e instanceof UnsupportedDraw) unsupportedReason = e.message; else throw e; }
  const expressionSupported = Object.prototype.hasOwnProperty.call(SUPPORTED_EXPRESSIONS, expression);
  if (bound !== null && !expressionSupported) unsupportedReason = `shader expression ${expression} is not a supported expression`;
  return Object.assign(evaluateEvidence(tau, { bound: expressionSupported ? bound : null, measured, eta, measurementDomainOk }),
    { bound, contract, expression, expressionSupported, unsupportedReason });
}

if (typeof module !== 'undefined') module.exports = { encodeLocal, validateDraw, boundAffineDraw, evaluateEvidence, checkDraw,
  UnsupportedDraw, InvalidEvidence, CONTRACTS, SUPPORTED_EXPRESSIONS, HOST_INFLATION, LAMBDA };
