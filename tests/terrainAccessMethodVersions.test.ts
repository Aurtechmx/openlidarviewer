/**
 * terrainAccessMethodVersions.test.ts — the Terrain Access methods carry the
 * versions their behaviour has, and the run's input digest binds each method
 * by id AND version.
 *
 * The A* search changed numerically in this release (diagonal moves refused
 * when they cut an unsupported corner, and width clearance measured to cell
 * rectangles, both through `transitionAllowed` / `footprintClearance.ts`), so
 * `olv.simulation.terrain-access.astar` is v2 and the footprint clearance
 * module is inventoried under the cost map that calls it. A digest that wrote
 * method ids alone could not tell a v1 run from a v2 run over the same input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { METHOD_REGISTRY, methodRef } from '../src/science/methodRegistry';
import {
  TERRAIN_ACCESS_METHODS, TERRAIN_ACCESS_MODEL,
} from '../src/simulation/terrainAccess/terrainAccessRunner';
import {
  TERRAIN_ACCESS_INPUT_DIGEST_SCHEME, terrainAccessSimulationInputDigest,
} from '../src/simulation/terrainAccess/terrainAccessInputDigest';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function flatDtm(): DtmGrid {
  const n = 9;
  return {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: 3, rows: 3, cellSizeM: 1, originH1: 0, originH2: 0, crs: 'EPSG:32610', horizontalEpsg: 32610,
    verticalDatum: null, verticalEpsg: null, verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
}
const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const digestInput = { dtm: flatDtm(), scale, dsm: null, roi: null, evidenceGapPolicy: 'exploratory' as const };

afterEach(() => {
  vi.doUnmock('../src/science/methodRegistry');
  vi.doUnmock('../src/terrain/ground/horizontalScale');
  vi.resetModules();
});

describe('Terrain Access method versions', () => {
  it('the A* search is v2 and the run model names the registry version', () => {
    expect(METHOD_REGISTRY['olv.simulation.terrain-access.astar'].version).toBe(2);
    expect(TERRAIN_ACCESS_MODEL).toEqual(methodRef('olv.simulation.terrain-access.astar'));
  });

  it('footprint clearance is inventoried under the method that calls it', () => {
    expect(METHOD_REGISTRY['olv.simulation.terrain-access.cost-map'].implementation)
      .toContain('src/simulation/terrainAccess/footprintClearance.ts');
  });

  it('every method the run uses is registered', () => {
    for (const id of TERRAIN_ACCESS_METHODS) expect(METHOD_REGISTRY[id]).toBeDefined();
  });
});

describe('the input digest binds method versions', () => {
  it('names scheme v5', () => {
    expect(TERRAIN_ACCESS_INPUT_DIGEST_SCHEME).toBe('olv.simulation.terrain-access.input-digest.v5');
  });

  it('a method version change alone changes the digest', async () => {
    const before = terrainAccessSimulationInputDigest(digestInput);
    vi.resetModules();
    vi.doMock('../src/science/methodRegistry', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/science/methodRegistry')>();
      const id = 'olv.simulation.terrain-access.local-step';
      const bumped: typeof real.METHOD_REGISTRY = { ...real.METHOD_REGISTRY, [id]: { ...real.METHOD_REGISTRY[id], version: 99 } };
      return {
        ...real,
        METHOD_REGISTRY: bumped,
        methodRef: (x: string) => ({ id: x, version: bumped[x].version }),
      };
    });
    const mod = await import('../src/simulation/terrainAccess/terrainAccessInputDigest');
    const after = mod.terrainAccessSimulationInputDigest(digestInput);
    expect(after).not.toBe(before);
  });

  it('a geographic run binds the degree-to-metre model; a projected run does not read it', async () => {
    const geo = { ...digestInput, scale: { isGeographic: true, latitudeDeg: 45, unitToMetres: 1, resolved: true } };
    const geoBefore = terrainAccessSimulationInputDigest(geo);
    const projectedBefore = terrainAccessSimulationInputDigest(digestInput);
    vi.resetModules();
    vi.doMock('../src/terrain/ground/horizontalScale', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/terrain/ground/horizontalScale')>()),
      GEOGRAPHIC_DEGREE_MODEL: 'another-model',
    }));
    const mod = await import('../src/simulation/terrainAccess/terrainAccessInputDigest');
    expect(mod.terrainAccessSimulationInputDigest(geo)).not.toBe(geoBefore);
    expect(mod.terrainAccessSimulationInputDigest(digestInput)).toBe(projectedBefore);
  });
});
