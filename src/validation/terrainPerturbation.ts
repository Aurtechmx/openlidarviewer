/**
 * terrainPerturbation.ts — deterministic, seeded perturbations for the terrain
 * validation harness. Validation-only; nothing here runs in the viewer.
 *
 * Every perturbation takes an integer seed and uses a seeded generator, never
 * Math.random, so the same (points, seed, magnitude) always reproduces the same
 * perturbed data — the property the harness's re-run checks rely on. Each
 * function returns NEW arrays and never mutates its input.
 */

import { fnv1a } from '../canonicalHash';
import type { TerrainPoint } from '../terrain/TerrainContracts';

/** Small, fast, deterministic PRNG (mulberry32) — the project's standard. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard-normal sample from a uniform generator (Box–Muller). */
export function gaussian(rng: () => number): number {
  // Guard the log against an exact 0 from the generator.
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Add seeded Gaussian vertical noise of standard deviation `sigmaZ` (metres). */
export function perturbVertical(points: readonly TerrainPoint[], seed: number, sigmaZ: number): TerrainPoint[] {
  const rng = mulberry32(seed);
  return points.map((p) => ({ x: p.x, y: p.y, z: p.z + gaussian(rng) * sigmaZ }));
}

/** Add seeded Gaussian horizontal jitter of standard deviation `sigmaXY` (metres). */
export function perturbXY(points: readonly TerrainPoint[], seed: number, sigmaXY: number): TerrainPoint[] {
  const rng = mulberry32(seed);
  return points.map((p) => ({ x: p.x + gaussian(rng) * sigmaXY, y: p.y + gaussian(rng) * sigmaXY, z: p.z }));
}

/**
 * Deterministically drop a fraction of ground (class-2) labels to Unclassified
 * (class 1), by a seeded coin per class-2 point. Returns a NEW class array; all
 * non-ground labels are left untouched. `fraction` is clamped to [0, 1].
 */
export function degradeGround(cls: Uint8Array, seed: number, fraction: number): Uint8Array {
  const f = Math.min(1, Math.max(0, fraction));
  const rng = mulberry32(seed);
  const out = new Uint8Array(cls);
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 2 && rng() < f) out[i] = 1; // ground → unclassified
  }
  return out;
}

/**
 * A stable content hash of a point set, for provenance (input vs perturbed).
 * Coordinates are quantised to 1e-4 m before hashing so the hash is
 * reproducible across platforms and independent of Float rounding noise below
 * the quantum.
 */
export function hashPoints(points: readonly TerrainPoint[]): string {
  const q = (v: number): number => Math.round(v * 1e4);
  let s = '';
  for (const p of points) s += `${q(p.x)},${q(p.y)},${q(p.z)};`;
  return fnv1a(s);
}
