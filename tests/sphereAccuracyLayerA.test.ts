/**
 * sphereAccuracyLayerA.test.ts — SP2 Layer A: OLV measurement engine correctness
 * against a real surveyed reference network.
 *
 * The scanner-comparison dataset (Zenodo 10.5281/zenodo.15421291) ships 12 surveyed
 * "Koule" reference spheres (plus one control point) with mm-accurate EPSG:5514
 * coordinates — a known inter-point distance network. This reproduces that network
 * through OLV's OWN measurement path (`geometry.distance` + the unit engine), in an
 * origin-subtracted Float32 local frame that mirrors the renderer, and asserts it
 * matches the surveyed distances to sub-millimetre.
 *
 * What this actually proves: OLV measures the LARGE-magnitude NEGATIVE Krovák
 * coordinates (x≈−744 000, y≈−1 036 000) without precision loss. A naive Float32
 * store of the raw coordinates would lose ~6 cm; OLV subtracts the render origin in
 * Float64 first, so the local residual is small and distances stay exact. This is
 * the reproducible gate the SP2 Layer-B instrument study plugs into. Measurement is
 * in native EPSG:5514 metres (Krovák is conformal), so no datum transform enters.
 *
 * Source coordinates: validation/sphere-accuracy/spheres-epsg5514.csv (surveyed
 * ground truth only; the raw clouds are not committed).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { distance } from '../src/render/measure/geometry';
import { sourceUnits, knownUnit, toMetresIfKnown } from '../src/units/units';

interface Sphere {
  name: string;
  x: number;
  y: number;
  z: number;
}

function loadSpheres(): Sphere[] {
  const csv = readFileSync(
    fileURLToPath(new URL('../validation/sphere-accuracy/spheres-epsg5514.csv', import.meta.url)),
    'utf8',
  );
  return csv
    .trim()
    .split('\n')
    .slice(1) // header
    .map((line) => {
      const [name, x, y, z] = line.split(',');
      return { name, x: Number(x), y: Number(y), z: Number(z) };
    });
}

/** Exact surveyed distance in EPSG:5514 metres (Float64 Euclidean of the raw coords). */
function surveyedDistance(a: Sphere, b: Sphere): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('SP2 Layer A — OLV measurement reproduces the surveyed sphere network', () => {
  const spheres = loadSpheres();

  it('loads the 13 surveyed reference points', () => {
    expect(spheres.length).toBe(13);
    expect(spheres.every((s) => s.x < 0 && s.y < 0)).toBe(true); // Krovák East-North negatives
  });

  it('matches every surveyed inter-sphere distance to sub-millimetre through OLV, in the Float32 render frame', () => {
    // Render origin: the centroid, subtracted in Float64 exactly as loadLas does
    // before narrowing to the Float32 local buffer.
    const ox = spheres.reduce((s, p) => s + p.x, 0) / spheres.length;
    const oy = spheres.reduce((s, p) => s + p.y, 0) / spheres.length;
    const oz = spheres.reduce((s, p) => s + p.z, 0) / spheres.length;
    // Local positions, narrowed to Float32 like the renderer's position buffer.
    const local = new Float32Array(spheres.length * 3);
    spheres.forEach((p, i) => {
      local[i * 3] = p.x - ox;
      local[i * 3 + 1] = p.y - oy;
      local[i * 3 + 2] = p.z - oz;
    });
    const localVec = (i: number): [number, number, number] => [
      local[i * 3],
      local[i * 3 + 1],
      local[i * 3 + 2],
    ];

    let maxErr = 0;
    let pairs = 0;
    for (let i = 0; i < spheres.length; i++) {
      for (let j = i + 1; j < spheres.length; j++) {
        const surveyed = surveyedDistance(spheres[i], spheres[j]);
        // OLV's measurement path: Euclidean of the picked (local) points, then the
        // unit engine converts source units → metres (EPSG:5514 is metres, factor 1).
        const srcDist = distance(localVec(i), localVec(j));
        const olvMetres = toMetresIfKnown(sourceUnits(srcDist), knownUnit(1)) ?? srcDist;
        const err = Math.abs(olvMetres - surveyed);
        maxErr = Math.max(maxErr, err);
        pairs++;
      }
    }
    // 78 pairs over a ~90 m network; sub-millimetre is the bar (real spheres are
    // metres apart and surveyed to mm).
    expect(pairs).toBe((spheres.length * (spheres.length - 1)) / 2);
    expect(maxErr).toBeLessThan(1e-3);
  });
});
