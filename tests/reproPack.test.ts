/**
 * reproPack.test.ts — reproducibility + calibration evidence.
 *
 * Runs the REAL pure cores over deterministic synthetic fixtures with analytic
 * ground truth and (a) asserts calibration invariants so they are CI-guarded,
 * and (b) under `REPRO=1`, writes `benchmarks/out/metrics.{json,md}` — the
 * paper's Evaluation table. No external data, no network: every number is
 * reproducible from a fixed seed.
 *
 *   npm test                 → runs the assertions in the unit bucket
 *   npm run repro            → also writes the metrics artifacts + figures
 *
 * Metrics:
 *   M1  epoch-registration vertical bias: full-3D ICP absorbs a uniform vertical
 *       change into its z-shift; the horizontal-only constraint preserves it.
 *   M2  planar alignment recovers a known horizontal misregistration.
 *   M3  stockpile ± band coverage: empirical coverage of the reported 1σ band
 *       against nominal on synthetic piles with a noisy top surface.
 *   M4  report digest is deterministic and verifies (tamper-evidence).
 */
import { describe, test, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alignEpochClouds } from '../src/terrain/change/alignEpochs';
import type { EpochCloud } from '../src/terrain/change/compareEpochs';
import { stockpileVolume, type StockpileInput } from '../src/render/measure/stockpileVolume';
import { buildReportManifest, verifyReportManifest } from '../src/render/measure/reportManifest';

/** Deterministic LCG so every metric is reproducible from a fixed seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const gauss = (r: () => number): number => {
  // Box–Muller.
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const round = (x: number, d = 4): number => Number(x.toFixed(d));
const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / (a.length || 1);

/** An irregular terrain-like cloud, as interleaved xyz. */
function terrain(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const f = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = r() * 40;
    const y = r() * 25;
    f[i * 3] = x;
    f[i * 3 + 1] = y;
    f[i * 3 + 2] = Math.sin(x * 0.2) + Math.cos(y * 0.15) + r() * 0.03;
  }
  return f;
}

/** Apply a horizontal (yaw + shift) transform and a uniform vertical change. */
function makeAfter(before: Float32Array, dx: number, dy: number, yawDeg: number, dz: number): Float32Array {
  const c = Math.cos((yawDeg * Math.PI) / 180);
  const s = Math.sin((yawDeg * Math.PI) / 180);
  const f = new Float32Array(before.length);
  for (let i = 0; i < before.length / 3; i++) {
    const x = before[i * 3], y = before[i * 3 + 1], z = before[i * 3 + 2];
    f[i * 3] = c * x - s * y + dx;
    f[i * 3 + 1] = s * x + c * y + dy;
    f[i * 3 + 2] = z + dz;
  }
  return f;
}

const cloud = (positions: Float32Array): EpochCloud => ({ positions });

/** Mean vertical difference of aligned-after vs before over corresponding points. */
function detectedVerticalChange(before: Float32Array, alignedAfter: Float32Array): number {
  let sum = 0;
  const n = before.length / 3;
  for (let i = 0; i < n; i++) sum += alignedAfter[i * 3 + 2] - before[i * 3 + 2];
  return sum / n;
}

// ── The metrics object (also written under REPRO=1) ───────────────────────────
const metrics: Record<string, unknown> = {};

describe('reproducibility + calibration', () => {
  test('M1: full-3D registration absorbs vertical change; horizontal-only preserves it', () => {
    const before = terrain(300, 1);
    const dzSweep = [0.1, 0.3, 0.5, 1.0];
    const rows = dzSweep.map((dz) => {
      const after = makeAfter(before, 3, -2, 2, dz);
      const h = alignEpochClouds(cloud(before), cloud(after), { horizontalOnly: true });
      const f = alignEpochClouds(cloud(before), cloud(after), { horizontalOnly: false });
      const detH = detectedVerticalChange(before, h.after.positions);
      const detF = detectedVerticalChange(before, f.after.positions);
      return { dz, biasHorizontalM: round(Math.abs(detH - dz)), biasFull3dM: round(Math.abs(detF - dz)) };
    });
    metrics.M1_registration_vertical_bias = rows;
    const meanH = mean(rows.map((r) => r.biasHorizontalM));
    const meanF = mean(rows.map((r) => r.biasFull3dM));
    metrics.M1_mean_bias = { horizontalOnlyM: round(meanH), full3dM: round(meanF) };
    // Horizontal-only preserves the vertical signal; full-3D absorbs most of it.
    expect(meanH).toBeLessThan(0.05);
    expect(meanF).toBeGreaterThan(meanH * 3);
  });

  test('M2: planar alignment recovers a known horizontal misregistration', () => {
    const before = terrain(300, 7);
    const after = makeAfter(before, 4.0, -3.0, 0, 0);
    const r = alignEpochClouds(cloud(before), cloud(after), { horizontalOnly: true });
    // The applied transform maps after→before; its x/y shift should be ≈ (−4,+3).
    const errXY = Math.hypot(r.alignment.translation[0] + 4, r.alignment.translation[1] - 3);
    metrics.M2_alignment_recovery = {
      appliedShiftXYm: [round(r.alignment.translation[0]), round(r.alignment.translation[1])],
      residualM: round(r.alignment.rmsResidualM),
      recoveryErrorM: round(errXY),
    };
    expect(r.alignment.applied).toBe(true);
    expect(errXY).toBeLessThan(0.3);
  });

  test('M3: the stockpile ± band is well-calibrated (empirical coverage ≈ nominal)', () => {
    // A flat L×L slab of height H over an explicit base at z=0, with a noisy top
    // surface (sigma_eps). True volume = L^2 * H; the reported 1σ should cover
    // that truth in ~68% of noise realisations.
    const L = 10, H = 2, sigmaEps = 0.1, ptsPerSide = 22, trials = 400;
    const trueVolume = L * L * H;
    const polygon = [[0, 0, 0], [L, 0, 0], [L, L, 0], [0, L, 0]] as [number, number, number][];
    let within1 = 0;
    const relErrs: number[] = [];
    for (let t = 0; t < trials; t++) {
      const r = rng(1000 + t);
      const pts: number[] = [];
      for (let i = 0; i < ptsPerSide; i++)
        for (let j = 0; j < ptsPerSide; j++) {
          const x = 0.5 + (i / (ptsPerSide - 1)) * (L - 1);
          const y = 0.5 + (j / (ptsPerSide - 1)) * (L - 1);
          pts.push(x, y, H + gauss(r) * sigmaEps);
        }
      const input: StockpileInput = {
        polygon,
        positions: Float32Array.from(pts),
        base: { mode: 'explicit', z: 0 },
      };
      const res = stockpileVolume(input);
      if (Math.abs(res.volume - trueVolume) <= res.sigma) within1 += 1;
      relErrs.push(Math.abs(res.volume - trueVolume) / trueVolume);
    }
    const coverage1sigma = within1 / trials;
    metrics.M3_stockpile_band_coverage = {
      nominal1sigma: 0.68,
      empirical1sigma: round(coverage1sigma, 3),
      trials,
      meanRelErrorPct: round(mean(relErrs) * 100, 3),
      trueVolumeM3: trueVolume,
    };
    // Well-calibrated: the empirical 1σ coverage should sit near the nominal 68%.
    expect(coverage1sigma).toBeGreaterThan(0.58);
    expect(coverage1sigma).toBeLessThan(0.80);
  });

  test('M4: the report digest is deterministic and tamper-evident', () => {
    const input = {
      dataset: { id: 'repro-site' },
      generatedAt: '2026-06-30T00:00:00Z',
      classificationEpoch: 0,
      software: '0.5.3',
      findings: [{ label: 'Stockpile volume', value: 1254, unit: 'm³', sigma: 41, confidence: 'medium' }],
    };
    const a = buildReportManifest(input);
    const b = buildReportManifest(input);
    const tampered = { ...a, findings: [{ ...a.findings[0], value: 9999 }] };
    metrics.M4_digest = {
      deterministic: a.digest === b.digest,
      algorithm: a.digestAlgorithm,
      intactVerifies: verifyReportManifest(a),
      tamperDetected: !verifyReportManifest(tampered),
    };
    expect(a.digest).toBe(b.digest);
    expect(verifyReportManifest(a)).toBe(true);
    expect(verifyReportManifest(tampered)).toBe(false);
  });
});

afterAll(() => {
  if (!process.env.REPRO) return;
  const outDir = resolve(process.cwd(), 'benchmarks/out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');

  const m1 = metrics.M1_mean_bias as { horizontalOnlyM: number; full3dM: number };
  const m2 = metrics.M2_alignment_recovery as { residualM: number; recoveryErrorM: number };
  const m3 = metrics.M3_stockpile_band_coverage as { empirical1sigma: number; meanRelErrorPct: number; trials: number };
  const m4 = metrics.M4_digest as { deterministic: boolean; algorithm: string; tamperDetected: boolean };
  const md = `# OpenLiDARViewer — reproducible evaluation

Generated by \`npm run repro\` from deterministic synthetic fixtures with analytic
ground truth. No external data. Regenerate with a single command.

| # | Metric | Result |
|---|--------|--------|
| M1 | Mean detected-vertical-change error, horizontal-only registration | ${m1.horizontalOnlyM} m |
| M1 | Mean detected-vertical-change error, full-3D registration | ${m1.full3dM} m |
| M2 | Planar alignment horizontal-recovery error (known 5 m shift) | ${m2.recoveryErrorM} m (residual ${m2.residualM} m) |
| M3 | Stockpile ±1σ band empirical coverage (nominal 0.68, ${m3.trials} trials) | ${m3.empirical1sigma} |
| M3 | Stockpile mean relative volume error | ${m3.meanRelErrorPct} % |
| M4 | Report digest deterministic / tamper-detected (${m4.algorithm}) | ${m4.deterministic && m4.tamperDetected ? 'yes / yes' : 'FAIL'} |

M1 evidences the change-detection design choice: a full-3D rigid registration
absorbs a true uniform vertical change into its z-shift (large detected-change
error), while the horizontal-only constraint preserves it (near-zero error). M3
shows the reported uncertainty band is calibrated rather than nominal.
`;
  writeFileSync(resolve(outDir, 'metrics.md'), md);
});
