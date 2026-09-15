import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { icpRegister, applyIcp, type Vec3, type IcpResult } from '../src/terrain/change/icpRegister';

/**
 * Pins the solver's exact numbers on deterministic fixtures. The fixture set
 * covers the cases a change to the correspondence search could move: clean
 * pairs, trimmed pairs with blunders, partial overlap, exact duplicate target
 * points and equidistant targets (where the first target index must win),
 * and a degenerate pair. Any change to the search or to the arithmetic order
 * shows up as a diff against `tests/fixtures/icpRegister.snapshot.json`.
 * Regenerate with `ICP_SNAPSHOT_WRITE=1` only when the method itself changes.
 */

const SNAPSHOT = resolve(__dirname, 'fixtures', 'icpRegister.snapshot.json');
const WRITE = process.env.ICP_SNAPSHOT_WRITE === '1';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function cloud(n: number, size: number, seed: number): Vec3[] {
  const rnd = prng(seed);
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) pts.push([rnd() * size, rnd() * size, rnd() * size * 0.25]);
  return pts;
}

/** A lattice cloud: many exact ties in distance, and duplicate targets. */
function lattice(n: number, step: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) pts.push([(i % 7) * step, Math.floor(i / 7) * step, (i % 3) * step]);
  for (let i = 0; i < 10; i++) pts.push(pts[i]); // exact duplicates at higher indices
  return pts;
}

function moved(src: readonly Vec3[], yaw: number, t: Vec3): Vec3[] {
  return src.map((p) => applyIcp({ yawRad: yaw, translation: t }, p));
}

interface Fixture { readonly name: string; readonly source: Vec3[]; readonly target: Vec3[]; readonly options: Parameters<typeof icpRegister>[2] }

function fixtures(): Fixture[] {
  const a = cloud(120, 40, 11);
  const b = cloud(400, 60, 23);
  const blunders = cloud(40, 40, 5).map(([x, y, z]) => [x + 200, y, z] as Vec3);
  const lat = lattice(120, 2);
  return [
    { name: 'identity', source: a, target: a, options: {} },
    { name: 'translation', source: a, target: moved(a, 0, [5, -3, 2]), options: {} },
    { name: 'yaw+translation', source: b, target: moved(b, 0.05, [2, 1, -0.5]), options: {} },
    { name: 'trimmed blunders', source: [...a, ...blunders], target: moved(a, 0.02, [1, 1, 0]), options: { trimFraction: 0.7 } },
    { name: 'partial overlap', source: b.slice(0, 250), target: moved(b.slice(100), 0.01, [0.5, 0.5, 0]), options: { maxResidual: 5 } },
    { name: 'lattice ties', source: moved(lat, 0, [0.9, 0.9, 0]), target: lat, options: {} },
    { name: 'lattice ties trimmed', source: moved(lat, 0.03, [1.2, 0.4, 0.1]), target: lat, options: { trimFraction: 0.8, maxResidual: 3 } },
    { name: 'degenerate', source: a.slice(0, 2), target: a, options: {} },
    { name: 'few iterations', source: b, target: moved(b, 0.1, [4, 4, 1]), options: { maxIterations: 3, tolerance: 0 } },
  ];
}

describe('icpRegister snapshot', () => {
  it('reproduces the recorded transforms, residuals and states exactly', () => {
    const results: Record<string, IcpResult> = {};
    for (const f of fixtures()) results[f.name] = icpRegister(f.source, f.target, f.options);
    // JSON has no Infinity; the degenerate residual travels as a string.
    const replacer = (_k: string, v: unknown): unknown => (v === Infinity ? 'Infinity' : v);
    const reviver = (_k: string, v: unknown): unknown => (v === 'Infinity' ? Infinity : v);
    if (WRITE) {
      writeFileSync(SNAPSHOT, JSON.stringify(results, replacer, 2) + '\n');
      return;
    }
    const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8'), reviver) as Record<string, IcpResult>;
    expect(Object.keys(results)).toEqual(Object.keys(recorded));
    for (const name of Object.keys(recorded)) {
      expect(results[name], name).toEqual(recorded[name]);
    }
  });
});
