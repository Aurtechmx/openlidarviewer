/**
 * latticeForensics.test.ts
 *
 * Analytic fixtures for coordinate-history forensics: the visibility law, the folded peak
 * location, and end-to-end decisions on synthetic histories with known truth.
 */
import { describe, expect, it } from 'vitest';
import {
  visibility, predictPeaks, packWindows, peakScore, decodeHistories, fold, sinc, phaseTest, nullScores,
  type CandidateHistory, type Mat2,
} from '../src/diagnostics/latticeForensics';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Continuous points in a square, stored on an ancestral lattice (rotation theta, step s1), re-rounded at s2. */
function history(n: number, sizeM: number, s1: number | null, s2: number, theta = 0, seed = 3) {
  const r = rng(seed);
  const nx = new Int32Array(n), ny = new Int32Array(n);
  const c = Math.cos(theta), s = Math.sin(theta);
  for (let i = 0; i < n; i++) {
    let x = r() * sizeM, y = r() * sizeM;
    if (s1 !== null) {
      const u = Math.round((c * x + s * y) / s1), v = Math.round((-s * x + c * y) / s1);
      x = s1 * (c * u - s * v); y = s1 * (s * u + c * v);
    }
    nx[i] = Math.round(x / s2); ny[i] = Math.round(y / s2);
  }
  return { nx, ny };
}

const rot = (theta: number, scale = 1): Mat2 => [
  [scale * Math.cos(theta), -scale * Math.sin(theta)],
  [scale * Math.sin(theta), scale * Math.cos(theta)],
];

describe('visibility law', () => {
  it('is sinc(r) on the axis and vanishes for integer coarsening', () => {
    expect(visibility(0.25)).toBeCloseTo(sinc(0.25), 12);
    expect(visibility(2)).toBeLessThan(1e-12);
    expect(visibility(3.28084)).toBeCloseTo(0.0749, 3);
  });
  it('folds predicted peaks into [-1/2, 1/2)', () => {
    const p = predictPeaks(rot(0), 0.01 * 0.3048, 0.01);
    expect(p[0].k[0]).toBeCloseTo(fold(1 / 0.3048), 10);
    expect(p[0].amplitude).toBeCloseTo(visibility(0.01 / (0.01 * 0.3048)), 10);
  });
});

describe('measured amplitude follows the prediction', () => {
  it('matches within 5% for a rotated non-integer history', () => {
    const theta = 0.21, s1 = 0.0137, s2 = 0.01;
    const { nx, ny } = history(120_000, 60, s1, s2, theta);
    const pack = packWindows(nx, ny, 1000, { maxWindows: 60 });
    const peak = predictPeaks(rot(theta), s1, s2)[0];
    const { amplitude } = peakScore(pack, peak.k);
    expect(Math.abs(amplitude - peak.amplitude) / peak.amplitude).toBeLessThan(0.05);
  });
});

describe('decodeHistories', { timeout: 60_000 }, () => {
  const candidates: CandidateHistory[] = [
    { label: 'same frame, metres', step: 0.01, jacobian: rot(0) },
    { label: 'rotated 3 deg frame, US feet', step: 0.01 * 1200 / 3937, jacobian: rot((3 * Math.PI) / 180) },
    { label: 'rotated 3 deg frame, US feet', step: 0.001 * 1200 / 3937, jacobian: rot((3 * Math.PI) / 180) },
  ];

  it('supports nothing on a single-quantisation control', () => {
    const { nx, ny } = history(24_000, 60, null, 0.001, 0, 11);
    const res = decodeHistories(packWindows(nx, ny, 10_000, { maxWindows: 36, minPoints: 20 }), 0.001, candidates, { nNull: 120 });
    expect(res.filter((r) => r.supported)).toHaveLength(0);
  });

  it('recovers a 0.01 m refinement and reports it as most specific', () => {
    const { nx, ny } = history(24_000, 60, 0.01, 0.001, 0, 12);
    const res = decodeHistories(packWindows(nx, ny, 10_000, { maxWindows: 36, minPoints: 20 }), 0.001, candidates, { nNull: 120 });
    const best = res.find((r) => r.mostSpecific);
    expect(best?.label).toBe('same frame, metres');
  });

  it('recovers a rotated US-foot ancestor and prefers 0.01 ft over the nested 0.001 ft lattice', () => {
    const { nx, ny } = history(24_000, 60, 0.01 * 1200 / 3937, 0.001, (3 * Math.PI) / 180, 13);
    const res = decodeHistories(packWindows(nx, ny, 10_000, { maxWindows: 36, minPoints: 20 }), 0.001, candidates, { nNull: 120 });
    const ms = res.filter((r) => r.mostSpecific);
    expect(ms).toHaveLength(1);
    expect(ms[0].label).toBe('rotated 3 deg frame, US feet');
    expect(ms[0].step).toBeCloseTo(0.01 * 1200 / 3937, 12);
  });
});

describe('phaseTest', () => {
  // Ancestral grid: step 0.0137 m rotated 0.21 rad, origin shifted by (0.004, -0.003) m; stored at 0.01 m.
  const theta = 0.21, s1 = 0.0137, s2 = 0.01, c: [number, number] = [0.004, -0.003];
  const r = rng(21);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const pts: [number, number][] = [];
  for (let i = 0; i < 40_000; i++) {
    const x = r() * 40, y = r() * 40;
    const u = Math.round((cs * (x - c[0]) + sn * (y - c[1])) / s1), v = Math.round((-sn * (x - c[0]) + cs * (y - c[1])) / s1);
    pts.push([Math.round((s1 * (cs * u - sn * v) + c[0]) / s2), Math.round((s1 * (sn * u + cs * v) + c[1]) / s2)]);
  }
  const k = predictPeaks(rot(theta), s1, s2)[0].kUnfolded;
  function windowsWithNode(node: [number, number]) {
    const wins: { nx: number[]; ny: number[]; node: [number, number]; k: [number, number] }[] = [];
    for (let gx = 0; gx < 4; gx++) for (let gy = 0; gy < 4; gy++) {
      const nx: number[] = [], ny: number[] = [];
      for (const p of pts) if (Math.floor(p[0] / 1000) === gx && Math.floor(p[1] / 1000) === gy) { nx.push(p[0]); ny.push(p[1]); }
      wins.push({ nx, ny, node, k: [k[0], k[1]] });
    }
    return wins;
  }
  it('aligns on the true grid nodes', () => {
    const res = phaseTest(windowsWithNode([c[0] / s2, c[1] / s2]));
    expect(res.Z).toBeGreaterThan(12); // 16 windows: Z cannot exceed 16 and is ~Exp(1) without alignment
    expect(Math.abs(res.phaseCycles)).toBeLessThan(0.05);
    expect(Number.isFinite(res.phaseSdCycles)).toBe(true);
    expect(res.phaseSdCycles).toBeLessThan(0.05);
  });
  it('keeps Z but moves the phase when the predicted origin moves by a constant', () => {
    const base = phaseTest(windowsWithNode([c[0] / s2, c[1] / s2]));
    const d: [number, number] = [0.3 * s1 * cs / s2, 0.3 * s1 * sn / s2];
    const moved = phaseTest(windowsWithNode([c[0] / s2 + d[0], c[1] / s2 + d[1]]));
    expect(Math.abs(moved.Z - base.Z) / base.Z).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(moved.phaseCycles - base.phaseCycles) - 0.3)).toBeLessThan(0.02);
  });
  it('measures a known offset of the predicted nodes', () => {
    // predicted node displaced by a quarter of the ancestral cell along the first lattice axis
    const d: [number, number] = [0.25 * s1 * cs / s2, 0.25 * s1 * sn / s2];
    const res = phaseTest(windowsWithNode([c[0] / s2 + d[0], c[1] / s2 + d[1]]));
    expect(Math.abs(Math.abs(res.phaseCycles) - 0.25)).toBeLessThan(0.05);
  });
});

describe('frozen rule defaults', () => {
  it('scores 2 000 null wavevectors outside |k| = 0.05', () => {
    const { nx, ny } = history(4_000, 20, null, 0.01, 0, 5);
    const pack = packWindows(nx, ny, 1000, { maxWindows: 4, minPoints: 20 });
    const nul = nullScores(pack);
    expect(nul.length).toBe(2000);
  });
  it('reduces windows on dense tiles so about 80 000 points enter, never below 20', () => {
    const { nx, ny } = history(60_000, 60, null, 0.01, 0, 6);
    const dense = packWindows(nx, ny, 1000, { maxWindows: 36, maxPoints: 40_000 });
    expect(dense.counts.length).toBe(24);
    const floor = packWindows(nx, ny, 1000, { maxWindows: 36, maxPoints: 1_000 });
    expect(floor.counts.length).toBe(20);
  });
  it('predicts A = 1 for an exact refinement in the file frame', () => {
    const { nx, ny } = history(24_000, 60, 0.01, 0.001, 0, 12);
    const pack = packWindows(nx, ny, 10_000, { maxWindows: 36, minPoints: 20 });
    const [own] = decodeHistories(pack, 0.001, [{ label: 'own frame', step: 0.01, jacobian: rot(0), sameFrame: true }], { nNull: 120 });
    expect(own.peaks.every((p) => p.amplitude === 1)).toBe(true);
    expect(own.supported).toBe(true);
  });
});

describe('no usable windows', () => {
  it('reports every candidate untestable instead of scoring NaN', () => {
    const { nx, ny } = history(30, 60, null, 0.01, 0, 9);
    const pack = packWindows(nx, ny, 1000);
    expect(pack.counts.length).toBe(0);
    const res = decodeHistories(pack, 0.01, [{ label: 'any', step: 0.0137, jacobian: rot(0) }]);
    expect(res[0].status).toBe('untestable');
    expect(res[0].supported).toBe(false);
  });
});
