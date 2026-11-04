/**
 * The paired injection-recovery test of the profile's ground-first rule:
 * validation/protocols/profile-ground-first-paired-v1.md. Reads the corridor
 * fixtures, runs the app's sampler on each scene with and without the feature,
 * and returns the protocol's measures by background, rule and label set.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleProfile, DEFAULT_GROUND_PERCENTILE, DEFAULT_PROFILE_SAMPLE_COUNT, autoCorridorWidth } from '../../src/render/measure/profileSampler';

export const PAIRED_DIR = join(__dirname, '../fixtures/profile-paired');
const AMP = 0.6;
const LAM = 6;
const X0 = 40;
const X1 = 88;
const Y0 = 54;
const UP: [number, number, number] = [0, 0, 1];

export type Rule = 'all-returns' | 'ground-first';
export type LabelSet = 'filter' | 'ground-known' | 'classified';
export const RULES: readonly Rule[] = ['all-returns', 'ground-first'];
export const LABEL_SETS: readonly LabelSet[] = ['filter', 'ground-known', 'classified'];

interface Scene {
  readonly background: string;
  readonly phase: number;
  readonly p0: Float32Array;
  readonly p1: Float32Array;
  readonly cls: Uint8Array;
  readonly smrf0: Uint8Array;
  readonly smrf1: Uint8Array;
}

function readScene(dir: string, file: string, background: string, phase: number): Scene {
  const rows = readFileSync(join(dir, file), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
  const n = rows.length;
  const p0 = new Float32Array(n * 3);
  const p1 = new Float32Array(n * 3);
  const cls = new Uint8Array(n);
  const smrf0 = new Uint8Array(n);
  const smrf1 = new Uint8Array(n);
  rows.forEach(([x, y, z0, z1, c, s0, s1], i) => {
    p0.set([x!, y!, z0!], i * 3);
    p1.set([x!, y!, z1!], i * 3);
    cls[i] = c!;
    smrf0[i] = s0!;
    smrf1[i] = s1!;
  });
  return { background, phase, p0, p1, cls, smrf0, smrf1 };
}

function labels(s: Scene, set: LabelSet, withFeature: boolean): Uint8Array {
  if (set === 'classified') return s.cls;
  if (set === 'ground-known') return s.cls.map((c) => (c === 2 ? 2 : 1));
  const flag = withFeature ? s.smrf1 : s.smrf0;
  return flag.map((g) => (g ? 2 : 1));
}

function background(name: string, x: number, y: number): number {
  const c = 64;
  if (name === 'flat') return 0;
  if (name.startsWith('rampx')) return (Number(name.slice(5)) / 100) * (x - c);
  if (name === 'hill') return 10 * Math.exp(-((x - c) ** 2 + (y - c) ** 2) / (2 * 25 ** 2));
  throw new Error(`unknown background ${name}`);
}

const rms = (v: readonly number[]): number => Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);

/** Least squares by normal equations with Gaussian elimination; the design here is small and well conditioned. */
function solve(m: number[][], b: number[]): number[] {
  const n = b.length;
  const a = m.map((r, i) => [...r, b[i]!]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(a[k]![i]!) > Math.abs(a[p]![i]!)) p = k;
    [a[i], a[p]] = [a[p]!, a[i]!];
    for (let k = i + 1; k < n; k++) {
      const f = a[k]![i]! / a[i]![i]!;
      for (let j = i; j <= n; j++) a[k]![j]! -= f * a[i]![j]!;
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let t = a[i]![n]!;
    for (let j = i + 1; j < n; j++) t -= a[i]![j]! * out[j]!;
    out[i] = t / a[i]![i]!;
  }
  return out;
}

/** The sine and cosine coefficients of y at the feature's frequency, with an intercept and a linear trend. */
function tone(x: readonly number[], y: readonly number[]): [number, number] {
  const k = (2 * Math.PI) / LAM;
  const mid = x.reduce((a, b) => a + b, 0) / x.length;
  const basis = (v: number): number[] => [Math.sin(k * v), Math.cos(k * v), 1, v - mid];
  const size = 4;
  const ata = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const aty = new Array<number>(size).fill(0);
  x.forEach((v, i) => {
    const b = basis(v);
    for (let r = 0; r < size; r++) {
      aty[r]! += b[r]! * y[i]!;
      for (let c = 0; c < size; c++) ata[r]![c]! += b[r]! * b[c]!;
    }
  });
  const c = solve(ata, aty);
  return [c[0]!, c[1]!];
}

export interface PairedFigures {
  readonly E: number;
  readonly G: number;
  readonly H: number;
  /** Stations with no return in either scene, summed over the realisations. */
  readonly emptyStations: number;
}

function measure(s: Scene, rule: Rule, set: LabelSet, band?: number): PairedFigures {
  const sample = (positions: Float32Array, classification: Uint8Array) => sampleProfile({
    a: [X0, Y0, 0],
    b: [X1, Y0, 0],
    up: UP,
    positions,
    samples: DEFAULT_PROFILE_SAMPLE_COUNT,
    bandWidth: band ?? autoCorridorWidth([X0, Y0, 0], [X1, Y0, 0], UP),
    groundPercentile: DEFAULT_GROUND_PERCENTILE,
    classification,
  });
  const run = (positions: Float32Array, withFeature: boolean) => {
    const cls = labels(s, set, withFeature);
    const all = sample(positions, cls);
    if (rule === 'all-returns') return all;
    // Ground-first, the rule the protocol compares: a station with ground
    // returns takes their percentile, and any other keeps the all-returns value.
    const n = cls.length;
    const ground = new Float32Array(positions.length);
    const groundCls = new Uint8Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (cls[i] !== 2) continue;
      ground.set(positions.subarray(i * 3, i * 3 + 3), m * 3);
      groundCls[m++] = 2;
    }
    const onGround = sample(ground.subarray(0, m * 3), groundCls.subarray(0, m));
    return all.map((station, i) => (Number.isFinite(onGround[i]!.height) ? onGround[i]! : station));
  };
  const without = run(s.p0, false);
  const withF = run(s.p1, true);
  const xs: number[] = [];
  const delta: number[] = [];
  const u: number[] = [];
  const heightError: number[] = [];
  let empty = 0;
  withF.forEach((w, i) => {
    const o = without[i]!;
    if (!Number.isFinite(w.height) || !Number.isFinite(o.height)) {
      empty++;
      return;
    }
    const x = X0 + w.distance;
    const feature = AMP * Math.sin((2 * Math.PI * x) / LAM + s.phase);
    xs.push(x);
    delta.push(w.height - o.height);
    u.push(feature);
    heightError.push(w.height - (background(s.background, x, Y0) + feature));
  });
  const scale = rms(u);
  const [ds, dc] = tone(xs, delta);
  const [us, uc] = tone(xs, u);
  return {
    E: rms(delta.map((d, i) => d - u[i]!)) / scale,
    G: Math.hypot(ds, dc) / Math.hypot(us, uc),
    H: rms(heightError) / scale,
    emptyStations: empty,
  };
}

export type PairedTable = Record<string, Record<LabelSet, Record<Rule, PairedFigures>>>;

/** Mean figures by background, label set and rule. `band` and `dir` override the protocol's corridor and fixtures, for exploratory runs only. */
export function pairedTable(band?: number, dir: string = PAIRED_DIR): PairedTable {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    files: Record<string, { background: string; phase: number }>;
  };
  const csvs = readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
  const scenes = csvs.map((f) => readScene(dir, f, manifest.files[f]!.background, manifest.files[f]!.phase));
  const table: PairedTable = {};
  for (const bg of [...new Set(scenes.map((s) => s.background))]) {
    const group = scenes.filter((s) => s.background === bg);
    const bySet = {} as Record<LabelSet, Record<Rule, PairedFigures>>;
    for (const set of LABEL_SETS) {
      const byRule = {} as Record<Rule, PairedFigures>;
      for (const rule of RULES) {
        const runs = group.map((s) => measure(s, rule, set, band));
        const mean = (k: 'E' | 'G' | 'H'): number => runs.reduce((a, r) => a + r[k], 0) / runs.length;
        byRule[rule] = { E: mean('E'), G: mean('G'), H: mean('H'), emptyStations: runs.reduce((a, r) => a + r.emptyStations, 0) };
      }
      bySet[set] = byRule;
    }
    table[bg] = bySet;
  }
  return table;
}

/** The protocol's decision: the rule that draws the first chart. */
export function pairedDecision(table: PairedTable): { rule: Rule; worst: Record<'filter' | 'ground-known', Record<Rule, { E: number; H: number }>> } {
  const worst = {} as Record<'filter' | 'ground-known', Record<Rule, { E: number; H: number }>>;
  let groundFirstHolds = true;
  for (const set of ['filter', 'ground-known'] as const) {
    const of = (rule: Rule, k: 'E' | 'H'): number => Math.max(...Object.values(table).map((t) => t[set][rule][k]));
    worst[set] = {
      'all-returns': { E: of('all-returns', 'E'), H: of('all-returns', 'H') },
      'ground-first': { E: of('ground-first', 'E'), H: of('ground-first', 'H') },
    };
    if (worst[set]['ground-first'].E > worst[set]['all-returns'].E + 0.1) groundFirstHolds = false;
    if (worst[set]['ground-first'].H > worst[set]['all-returns'].H + 0.1) groundFirstHolds = false;
  }
  return { rule: groundFirstHolds ? 'ground-first' : 'all-returns', worst };
}
