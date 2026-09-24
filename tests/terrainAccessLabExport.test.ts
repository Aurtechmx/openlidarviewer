/**
 * terrainAccessLabExport.test.ts — the Terrain Access Lab's export action.
 *
 * Mirrors `flowPulseLabExport.test.ts`: `buildTerrainAccessExport` is the pure
 * core the Lab's `handleExport` calls once the lazy package-builder chunk
 * resolves. It refuses a stale result (§18) and a run that never completed,
 * and otherwise hands `buildTerrainAccessPackage` the current run.
 */
import { describe, expect, it } from 'vitest';

import { buildTerrainAccessExport } from '../src/ui/fieldSimulation/terrainAccessLab';
import { buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function dtmOf(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

const RESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

const PERMISSIVE: TerrainAccessProfile = Object.freeze({
  name: 'test',
  maxLongitudinalGrade: 10,
  maxCrossSlope: 10,
  maxStepHeight: 10,
  maxRuggedness: null,
  vehicleWidth: 0,
  vehicleLength: null,
  minimumTerrainConfidence: 0,
  unknownPolicy: 'block',
  obstacleHeightThreshold: null,
});

const identity = {
  layerId: 'layer-a', filename: 'site', sourceDigest: null, analysisInputDigest: 'digest',
  build: 'test-build', id: 'run-1', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};

const flat = () => dtmOf([
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]);

function runOf() {
  const result = runTerrainAccess(flat(), RESOLVED, PERMISSIVE, 0, 11, TERRAIN_ACCESS_DEFAULTS, identity);
  if (!result.ok) throw new Error(`fixture run refused: ${result.code}`);
  return result;
}

/** Extract a stored entry's bytes from the store-only ZIP. */
function extractEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const wantName = new TextEncoder().encode(name);
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameBytes = zip.subarray(p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    let match = nameBytes.length === wantName.length;
    for (let j = 0; match && j < wantName.length; j++) {
      if (nameBytes[j] !== wantName[j]) match = false;
    }
    if (match) return zip.subarray(dataStart, dataStart + compSize);
    p = dataStart + compSize;
  }
  return null;
}

describe('a stale result (§18)', () => {
  it('is refused before the package builder runs', () => {
    const out = buildTerrainAccessExport(runOf(), true, 'site', 'layer-a', buildTerrainAccessPackage);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('stale');
  });
});

describe('a run that never completed', () => {
  it('is refused with no package built', () => {
    const refusal = runTerrainAccess(null, RESOLVED, PERMISSIVE, 0, 1, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(refusal.ok).toBe(false);
    const out = buildTerrainAccessExport(refusal, false, 'site', 'layer-a', buildTerrainAccessPackage);
    expect(out.ok).toBe(false);
  });

  it('is refused when there is no outcome at all', () => {
    const out = buildTerrainAccessExport(null, false, 'site', 'layer-a', buildTerrainAccessPackage);
    expect(out.ok).toBe(false);
  });
});

describe('a fresh, non-stale result', () => {
  it('builds a package whose contents include the run record and config', () => {
    const out = buildTerrainAccessExport(runOf(), false, 'site', 'layer-a', buildTerrainAccessPackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filename).toBe('site-terrain-access.zip');
    expect(extractEntry(out.bytes, 'site-simulation-run.json')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site.olv-field-sim.json')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site-route.geojson')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site-traversability.asc')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site-diagnostics.csv')).not.toBeNull();
  });

  it('falls back to the layer id when no filename is known', () => {
    const out = buildTerrainAccessExport(runOf(), false, null, 'layer-a', buildTerrainAccessPackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filename).toBe('layer-a-terrain-access.zip');
  });
});
