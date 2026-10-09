/**
 * latticeForensics.ts — earlier storage grids in stored integer coordinates.
 *
 * A LAS/LAZ file stores X = offset + scale * N with N an integer. When data stored on one grid
 * (another scale, unit or reference system) are re-rounded onto the current one, the earlier
 * grid can remain as a faint lattice in the integers. For an earlier lattice with basis B in
 * current storage units, the integers carry structure at k = B^{-T} m, folded into
 * [-1/2, 1/2)^2, with visibility A = |sinc(k1) sinc(k2)| on the unfolded k.
 *
 * The module is pure (no DOM, no three, no proj4). The caller supplies, per candidate grid, the
 * local Jacobian J of the candidate-to-file map (file metres per candidate unit).
 *   T(k)     = sum_w |sum_{j in w} exp(2 pi i k.N_j)|^2 / sum_w n_w   (windows of fixed size)
 *   score(k) = T(k) / median T(ring of 8 points at radius 6/w)
 *   supported: Fisher-combined empirical p over testable peaks, Bonferroni over tested
 *              candidates below alpha, and median measured/predicted amplitude in [0.5, 2].
 *
 * Defaults: windows of at least 40 points, at most 250 windows reduced so that about 80 000
 * points enter (never below 20 windows), 2 000 null wavevectors with |k| > 0.05, testable peaks
 * with |k| >= 0.05 and A >= 0.01, alpha 0.01. A candidate in the file's own frame at an exact
 * integer refinement of the stored step has one rounding error value, so its peaks are
 * predicted at A = 1. Within one system the coarsest supported step is reported.
 *
 * phaseTest reports a delete-one-window jackknife, which ignores spatial correlation between
 * windows. Window selection and the null use a seeded PRNG, so results are deterministic.
 */

export type Vec2 = readonly [number, number];
export type Mat2 = readonly [readonly [number, number], readonly [number, number]];

export interface LatticePeak {
  readonly m: Vec2;
  /** Unfolded reciprocal vector in cycles per storage unit. */
  readonly kUnfolded: Vec2;
  /** Folded into [-1/2, 1/2)^2. */
  readonly k: Vec2;
  /** Predicted visibility in [0, 1]. */
  readonly amplitude: number;
}

export interface CandidateHistory {
  /** System name. Candidates sharing a label are steps of one system for the coarsest-step rule. */
  readonly label: string;
  /** Ancestral storage step in ancestral units (m, ft, deg ...). */
  readonly step: number;
  /** d(file metres)/d(ancestral units) at the tile centre, columns = ancestral axes. */
  readonly jacobian: Mat2;
  /** True when the candidate is the file's own reference system (same frame, other step). */
  readonly sameFrame?: boolean;
}

export interface CandidateResult {
  readonly label: string;
  readonly step: number;
  readonly status: 'tested' | 'untestable';
  readonly peaks: readonly LatticePeak[];
  readonly scores: readonly number[];
  readonly pJoint: number;
  readonly pBonferroni: number;
  readonly amplitudeRatio: number;
  readonly supported: boolean;
  readonly mostSpecific: boolean;
}

export interface WindowPack {
  readonly lx: Float64Array;
  readonly ly: Float64Array;
  readonly starts: Int32Array;
  readonly counts: Int32Array;
  readonly windowUnits: number;
}

export function sinc(u: number): number {
  if (u === 0) return 1;
  const x = Math.PI * u;
  return Math.sin(x) / x;
}

export function fold(v: number): number {
  return ((((v + 0.5) % 1) + 1) % 1) - 0.5;
}

/** Visibility of an ancestral lattice of step s1 rotated by theta, re-rounded at step s2 (r = s2/s1). */
export function visibility(r: number, theta = 0, m: Vec2 = [1, 0]): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const gx = r * (c * m[0] - s * m[1]);
  const gy = r * (s * m[0] + c * m[1]);
  return Math.abs(sinc(gx) * sinc(gy));
}

/** Reciprocal peaks of the ancestral lattice B = J * s1 / s2 (current storage units). */
export function predictPeaks(jacobian: Mat2, s1: number, s2: number): LatticePeak[] {
  const f = s1 / s2;
  const b00 = jacobian[0][0] * f, b01 = jacobian[0][1] * f, b10 = jacobian[1][0] * f, b11 = jacobian[1][1] * f;
  const det = b00 * b11 - b01 * b10;
  if (!Number.isFinite(det) || det === 0) return [];
  // G = B^{-T}
  const g00 = b11 / det, g01 = -b10 / det, g10 = -b01 / det, g11 = b00 / det;
  const ms: Vec2[] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  return ms.map((m) => {
    const ku: Vec2 = [g00 * m[0] + g01 * m[1], g10 * m[0] + g11 * m[1]];
    return { m, kUnfolded: ku, k: [fold(ku[0]), fold(ku[1])] as Vec2, amplitude: Math.abs(sinc(ku[0]) * sinc(ku[1])) };
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Group points into square windows of `windowUnits` storage units, keep windows with at least
 * `minPoints`, sample at most `maxWindows` of them, and store window-local integer coordinates.
 */
export function packWindows(
  nx: ArrayLike<number>, ny: ArrayLike<number>, windowUnits: number,
  opts: { minPoints?: number; maxWindows?: number; maxPoints?: number; seed?: number } = {},
): WindowPack {
  const minPoints = opts.minPoints ?? 40;
  let maxWindows = opts.maxWindows ?? 250;
  const maxPoints = opts.maxPoints ?? 80_000;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < nx.length; i++) {
    const key = `${Math.floor(nx[i] / windowUnits)},${Math.floor(ny[i] / windowUnits)}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(i);
  }
  let keep = [...groups.entries()].filter(([, g]) => g.length >= minPoints).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (keep.length > maxWindows) {
    const rnd = mulberry32(opts.seed ?? 1);
    for (let i = keep.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [keep[i], keep[j]] = [keep[j], keep[i]]; }
  }
  // Dense tiles: fewer windows so that about maxPoints points enter, never fewer than 20 windows.
  const first = keep.slice(0, maxWindows);
  const meanCount = first.reduce((s, [, g]) => s + g.length, 0) / Math.max(first.length, 1);
  maxWindows = Math.max(20, Math.min(maxWindows, Math.floor(maxPoints / Math.max(meanCount, 1))));
  keep = keep.slice(0, maxWindows);
  const total = keep.reduce((s, [, g]) => s + g.length, 0);
  const lx = new Float64Array(total), ly = new Float64Array(total);
  const starts = new Int32Array(keep.length), counts = new Int32Array(keep.length);
  let p = 0;
  keep.forEach(([, g], w) => {
    starts[w] = p; counts[w] = g.length;
    const ox = nx[g[0]], oy = ny[g[0]];
    for (const i of g) { lx[p] = nx[i] - ox; ly[p] = ny[i] - oy; p++; }
  });
  return { lx, ly, starts, counts, windowUnits };
}

/** Normalised incoherent window power and excess-amplitude estimate at an exact (off-grid) k. */
export function incoherentPower(pack: WindowPack, k: Vec2): { T: number; A2: number } {
  let P = 0, ns = 0, nn1 = 0;
  const tau = 2 * Math.PI;
  for (let w = 0; w < pack.counts.length; w++) {
    let re = 0, im = 0;
    const s = pack.starts[w], n = pack.counts[w];
    for (let j = s; j < s + n; j++) {
      const ph = tau * (k[0] * pack.lx[j] + k[1] * pack.ly[j]);
      re += Math.cos(ph); im += Math.sin(ph);
    }
    P += re * re + im * im; ns += n; nn1 += n * (n - 1);
  }
  return { T: P / ns, A2: nn1 > 0 ? (P - ns) / nn1 : 0 };
}

function median(v: number[]): number {
  const a = [...v].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : 0.5 * (a[h - 1] + a[h]);
}

/** Peak score relative to a local ring background; also returns the amplitude estimate at k. */
export function peakScore(pack: WindowPack, k: Vec2): { score: number; amplitude: number } {
  const rad = 6 / pack.windowUnits;
  const ring: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ring.push(incoherentPower(pack, [k[0] + rad * Math.cos(a), k[1] + rad * Math.sin(a)]).T);
  }
  const c = incoherentPower(pack, k);
  return { score: c.T / Math.max(median(ring), 1e-12), amplitude: Math.sqrt(Math.max(c.A2, 0)) };
}

/** Empirical null: scores at random wavevectors with |k| >= kMin, sorted ascending. */
export function nullScores(pack: WindowPack, n = 2000, kMin = 0.05, seed = 7): Float64Array {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  while (out.length < n) {
    const k: Vec2 = [rnd() - 0.5, rnd() - 0.5];
    if (Math.hypot(k[0], k[1]) <= kMin) continue;
    out.push(peakScore(pack, k).score);
  }
  return Float64Array.from(out.sort((a, b) => a - b));
}

function empiricalP(sortedNull: Float64Array, s: number): number {
  let lo = 0, hi = sortedNull.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedNull[mid] < s) lo = mid + 1; else hi = mid; }
  return (sortedNull.length - lo + 1) / (sortedNull.length + 1);
}

/** Chi-square survival for even degrees of freedom 2k (closed form), used by Fisher's method. */
function chi2SfEven(x: number, k: number): number {
  let term = 1, sum = 1;
  for (let i = 1; i < k; i++) { term *= x / 2 / i; sum += term; }
  return Math.min(1, Math.exp(-x / 2) * sum);
}

export interface DecodeOptions {
  readonly kMin?: number;
  readonly aMin?: number;
  readonly alpha?: number;
  readonly nNull?: number;
}

/**
 * Evaluate candidate histories against one window pack. `currentStep` is the file's scale factor
 * (metres per storage unit) on the analysed axes.
 */
export function decodeHistories(
  pack: WindowPack, currentStep: number, candidates: readonly CandidateHistory[], opts: DecodeOptions = {},
): CandidateResult[] {
  const kMin = opts.kMin ?? 0.05, aMin = opts.aMin ?? 0.01, alpha = opts.alpha ?? 0.01;
  if (pack.counts.length === 0) {
    // No window holds enough points: every candidate is untestable, nothing is scored.
    return candidates.map((c) => ({
      label: c.label, step: c.step, status: 'untestable' as const, peaks: [], scores: [],
      pJoint: 1, pBonferroni: 1, amplitudeRatio: Number.NaN, supported: false, mostSpecific: false,
    }));
  }
  const nul = nullScores(pack, opts.nNull ?? 2000, kMin);
  const partial = candidates.map((c) => {
    const ratio = c.step / currentStep;
    const exactRefinement = c.sameFrame === true && Math.abs(ratio - Math.round(ratio)) < 1e-9;
    const predicted = predictPeaks(c.jacobian, c.step, currentStep);
    const peaks = (exactRefinement ? predicted.map((p) => ({ ...p, amplitude: 1 })) : predicted).filter(
      (p) => Math.hypot(p.k[0], p.k[1]) >= kMin && p.amplitude >= aMin,
    );
    if (peaks.length === 0) {
      return { c, peaks, scores: [] as number[], pJoint: 1, ratio: Number.NaN, tested: false };
    }
    const sc = peaks.map((p) => peakScore(pack, p.k));
    const ps = sc.map((s) => empiricalP(nul, s.score));
    const x = -2 * ps.reduce((a, p) => a + Math.log(p), 0);
    const ratios = sc.map((s, i) => s.amplitude / peaks[i].amplitude);
    return { c, peaks, scores: sc.map((s) => s.score), pJoint: chi2SfEven(x, ps.length), ratio: median(ratios), tested: true };
  });
  const nTested = Math.max(1, partial.filter((p) => p.tested).length);
  const results = partial.map((p) => {
    const pB = Math.min(1, p.pJoint * nTested);
    const supported = p.tested && pB < alpha && p.ratio >= 0.5 && p.ratio <= 2;
    return { p, pB, supported };
  });
  return results.map(({ p, pB, supported }) => ({
    label: p.c.label,
    step: p.c.step,
    status: p.tested ? 'tested' : 'untestable',
    peaks: p.peaks,
    scores: p.scores,
    pJoint: p.pJoint,
    pBonferroni: pB,
    amplitudeRatio: p.ratio,
    supported,
    mostSpecific: supported && !results.some((q) => q.supported && q.p.c.label === p.c.label && q.p.c.step > p.c.step * 1.0001),
  }));
}

/** One analysis window for the phase test: absolute stored integers plus the candidate's prediction. */
export interface PhaseWindow {
  readonly nx: ArrayLike<number>;
  readonly ny: ArrayLike<number>;
  /** Nearest ancestral node mapped into the file's integer frame (may be fractional). */
  readonly node: Vec2;
  /** Unfolded local reciprocal vector (cycles per storage unit). */
  readonly k: Vec2;
}

export interface PhaseResult {
  /** Rayleigh-type statistic |C|^2 / sum |z_w|^2; about Exp(1) when phases are random. */
  readonly Z: number;
  /** Coherent amplitude |C| / sum n_w. */
  readonly amplitude: number;
  /** Residual phase of the actual nodes relative to the predicted ones, in cycles of the ancestral cell. */
  readonly phaseCycles: number;
  /** Delete-one-window jackknife standard deviation of phaseCycles (NaN for fewer than 3 windows). */
  readonly phaseSdCycles: number;
}

/**
 * Phase test: do the stored points sit on the candidate's actual grid nodes?
 * For each window, z_w = sum_j exp(2 pi i k_w . (N_j - node_w)), multiplied by the sign of
 * sinc(k1) sinc(k2); C = sum_w sign_w z_w. A true candidate aligns all window phasors.
 */
export function phaseTest(windows: readonly PhaseWindow[]): PhaseResult {
  let cre = 0, cim = 0, s2 = 0, ns = 0;
  const tau = 2 * Math.PI;
  const zre: number[] = [], zim: number[] = [];
  for (const w of windows) {
    const sign = Math.sign(sinc(w.k[0]) * sinc(w.k[1])) || 1;
    let re = 0, im = 0;
    for (let j = 0; j < w.nx.length; j++) {
      const ph = tau * (w.k[0] * (w.nx[j] - w.node[0]) + w.k[1] * (w.ny[j] - w.node[1]));
      re += Math.cos(ph); im += Math.sin(ph);
    }
    zre.push(sign * re); zim.push(sign * im);
    cre += sign * re; cim += sign * im; s2 += re * re + im * im; ns += w.nx.length;
  }
  const Z = s2 > 0 ? (cre * cre + cim * cim) / s2 : 0;
  const phase = Math.atan2(cim, cre) / tau;
  // Delete-one-window jackknife of the phase (wrapped to [-1/2, 1/2) around the full estimate).
  const W = zre.length;
  let sd = Number.NaN;
  if (W > 2) {
    const d = zre.map((_, i) => fold(Math.atan2(cim - zim[i], cre - zre[i]) / tau - phase));
    const mean = d.reduce((a, b) => a + b, 0) / W;
    sd = Math.sqrt(((W - 1) / W) * d.reduce((a, b) => a + (b - mean) ** 2, 0));
  }
  return {
    Z,
    amplitude: ns > 0 ? Math.hypot(cre, cim) / ns : 0,
    phaseCycles: phase,
    phaseSdCycles: sd,
  };
}
