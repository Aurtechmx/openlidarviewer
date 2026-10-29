/**
 * sphereAccuracyLayerA.test.ts — SP2 Layer A: arithmetic and coordinate
 * handling of OLV's distance path on a published coordinate list.
 *
 * The scanner-comparison dataset (Zenodo 10.5281/zenodo.15421291) publishes the
 * coordinates of 12 "Koule" reference spheres and one control point ("Auto") in
 * the `ReferencePoints` sheet of `GroundTruth.xlsx`, stated in EPSG:5514. This
 * test computes every inter-point distance of that list two ways: in Float64
 * from the coordinates, and through OLV's measurement path (`geometry.distance`
 * plus the unit engine) on positions recentred and narrowed to Float32 as the
 * renderer holds them. It asserts the two agree to sub-millimetre.
 *
 * What it shows: OLV's recentring keeps the large negative Krovák magnitudes
 * (x ≈ −744 000, y ≈ −1 036 000) without the ~6 cm loss a raw Float32 store
 * would cause, and the distance and unit arithmetic is correct. What it does
 * not show: anything about a scan. No point cloud is read, no sphere is
 * located, and the published precision of the coordinates says nothing about
 * their physical survey accuracy.
 *
 * Source coordinates: validation/sphere-accuracy/spheres-epsg5514.csv, the 13
 * ReferencePoints entries rounded to 6 decimals; `npm run
 * validate:zenodo-small` checks them against the workbook.
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

/** Float64 Euclidean distance of the published EPSG:5514 coordinates, in metres. */
function float64Distance(a: Sphere, b: Sphere): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('SP2 Layer A — OLV distance arithmetic on the published sphere coordinates', () => {
  const spheres = loadSpheres();

  it('loads the published reference list: 12 Koule spheres + 1 control point', () => {
    expect(spheres.length).toBe(13);
    // The study is over the 12 physical "Koule" spheres; the 13th ("Auto") is a
    // published control point, valid in the distance network but not a sphere.
    expect(spheres.filter((s) => s.name.startsWith('Koule')).length).toBe(12);
    expect(spheres.some((s) => s.name === 'Auto')).toBe(true);
    expect(spheres.every((s) => s.x < 0 && s.y < 0)).toBe(true); // Krovák East-North negatives
  });

  it('reproduces every inter-point distance of the published coordinates to sub-millimetre through OLV, in the Float32 render frame', () => {
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
        const reference = float64Distance(spheres[i], spheres[j]);
        // OLV's measurement path: Euclidean of the picked (local) points, then the
        // unit engine converts source units → metres (EPSG:5514 is metres, factor 1).
        const srcDist = distance(localVec(i), localVec(j));
        const olvMetres = toMetresIfKnown(sourceUnits(srcDist), knownUnit(1)) ?? srcDist;
        const err = Math.abs(olvMetres - reference);
        maxErr = Math.max(maxErr, err);
        pairs++;
      }
    }
    // 78 pairs over a ~90 m network. Both sides start from the same published
    // coordinates, so the bar measures OLV's handling, not the survey.
    expect(pairs).toBe((spheres.length * (spheres.length - 1)) / 2);
    expect(maxErr).toBeLessThan(1e-3);
  });

  // The same 78 pairs under the origins OLV actually picks: the floored header
  // minimum the LAS loaders use on iPhone.laz, the COPC octree centre the
  // streaming path recentres on, the floored minimum of the list itself, and
  // one of the points. Each against an independent Float64 calculation.
  const ORIGINS: Record<string, [number, number, number]> = {
    'iPhone.laz loader origin (floored header min)': [-744305, -1036303, 306],
    'iPhone.laz COPC render origin (octree centre)': [-744245, -1036244, 365],
    'floored minimum of the list': [
      Math.floor(Math.min(...spheres.map((p) => p.x))),
      Math.floor(Math.min(...spheres.map((p) => p.y))),
      Math.floor(Math.min(...spheres.map((p) => p.z))),
    ],
    'the Auto point': [spheres[0].x, spheres[0].y, spheres[0].z],
  };
  for (const [label, o] of Object.entries(ORIGINS)) {
    it(`keeps all 78 distances to sub-millimetre with origin: ${label}`, () => {
      const f32 = (p: Sphere): [number, number, number] => [
        Math.fround(p.x - o[0]), Math.fround(p.y - o[1]), Math.fround(p.z - o[2]),
      ];
      let pairs = 0;
      let maxErr = 0;
      for (let i = 0; i < spheres.length; i++) {
        for (let j = i + 1; j < spheres.length; j++) {
          const d = toMetresIfKnown(sourceUnits(distance(f32(spheres[i]), f32(spheres[j]))), knownUnit(1))!;
          maxErr = Math.max(maxErr, Math.abs(d - float64Distance(spheres[i], spheres[j])));
          pairs++;
        }
      }
      expect(pairs).toBe(78);
      expect(maxErr).toBeLessThan(1e-3);
    });
  }
});
