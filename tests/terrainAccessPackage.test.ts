/**
 * terrainAccessPackage.test.ts: the Terrain Access deliverable, and its
 * reproduction. Mirrors `flowPulsePackage.test.ts`'s two properties:
 *
 *   re-running the package's own reproducible config over the same terrain
 *   reproduces the same resultDigest — the whole point of shipping a config
 *   rather than only a result;
 *
 *   the README never crosses into the §22 forbidden language — "safe",
 *   "drivable", "passable" — as a positive claim, because a package is read
 *   outside the app, where nothing else stops an overclaim from standing
 *   unchallenged.
 */
import { describe, expect, it } from 'vitest';

import { buildTerrainAccessConfig, buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS, type TerrainAccessParams } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { verifyScientificArtifactPassport } from '../src/science/scientificArtifactPassport';
import { verifyProcessingManifest } from '../src/science/processingManifest';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const RESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

const identity = {
  layerId: 'layer-a', filename: 'site', sourceDigest: 'aaaa', analysisInputDigest: 'bbbb',
  build: '0.7.0-alpha.1', id: 'run-1', generatedAt: '2026-09-23T00:00:00.000Z', processingManifestHead: null,
};

const PROFILE: TerrainAccessProfile = Object.freeze({
  name: 'test profile',
  maxLongitudinalGrade: 1,
  maxCrossSlope: 1,
  maxStepHeight: 5,
  maxRuggedness: null,
  vehicleWidth: 0,
  vehicleLength: null,
  minimumTerrainConfidence: 0,
  unknownPolicy: 'block',
  obstacleHeightThreshold: null,
});

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

const bowlDtm = () => dtmOf([
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
]);

function runOf(overrides: Partial<TerrainAccessParams> = {}) {
  const result = runTerrainAccess(
    bowlDtm(), RESOLVED, PROFILE, 0, 24, { ...TERRAIN_ACCESS_DEFAULTS, ...overrides }, identity,
  );
  if (!result.ok) throw new Error(`fixture run refused: ${result.code}`);
  return result;
}

/** Re-run a parsed/rebuilt `*.olv-field-sim.json` config over the same terrain and basis. */
function reRunFromConfig(original: ReturnType<typeof runOf>, config: Record<string, unknown>) {
  return runTerrainAccess(
    bowlDtm(), RESOLVED, config.profile as TerrainAccessProfile,
    config.startIndex as number, config.endIndex as number,
    {
      interpolated: config.interpolated as TerrainAccessParams['interpolated'],
      maxCells: config.maxCells as number,
      withheldExcluded: original.basis.withheldExcluded,
      weights: config.weights as TerrainAccessParams['weights'],
    },
    identity,
  );
}

/** Extract a stored entry's bytes from the store-only ZIP. */
function extractEntry(zip: Uint8Array, name: string): Uint8Array {
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
  throw new Error(`entry not found: ${name}`);
}

function textOf(zip: Uint8Array, name: string): string {
  return new TextDecoder().decode(extractEntry(zip, name));
}

function jsonOf<T>(zip: Uint8Array, name: string): T {
  return JSON.parse(textOf(zip, name)) as T;
}

describe('the package carries every required file', () => {
  it('includes the route, raster, diagnostics, run record, config, manifest, passport and README', () => {
    const zip = buildTerrainAccessPackage(runOf(), { basename: 'ta' });
    for (const name of [
      'ta-route.geojson', 'ta-traversability.asc', 'ta-diagnostics.csv',
      'ta-simulation-run.json', 'ta.olv-field-sim.json', 'ta-processing-manifest.json',
      'ta-scientific-artifact-passport.json', 'ta-README.txt', 'SHA256SUMS.txt',
    ]) {
      expect(() => extractEntry(zip, name)).not.toThrow();
    }
  });

  it('the route GeoJSON declares an explicit local coordinate frame, not lon/lat', () => {
    const zip = buildTerrainAccessPackage(runOf(), { basename: 'ta' });
    const geojson = jsonOf<{ coordinateFrame: string }>(zip, 'ta-route.geojson');
    expect(geojson.coordinateFrame).toBe('local-planar-metres');
  });

  it('the passport and manifest verify against their own bytes', () => {
    const zip = buildTerrainAccessPackage(runOf(), { basename: 'ta' });
    const manifest = jsonOf(zip, 'ta-processing-manifest.json');
    expect(verifyProcessingManifest(manifest as never).ok).toBe(true);
    const passport = jsonOf(zip, 'ta-scientific-artifact-passport.json');
    expect(verifyScientificArtifactPassport(passport as never)).toBe('VERIFIED');
  });
});

describe('the config reproduces the result digest', () => {
  it('re-running the exported config over the same terrain gives the same resultDigest', () => {
    const original = runOf();
    const zip = buildTerrainAccessPackage(original, { basename: 'ta' });
    const config = jsonOf<Record<string, unknown>>(zip, 'ta.olv-field-sim.json');

    expect(config.kind).toBe('terrain-access');
    const reRun = reRunFromConfig(original, config);
    expect(reRun.ok).toBe(true);
    if (!reRun.ok) return;
    expect(reRun.record.result.resultDigest).toBe(original.record.result.resultDigest);
  });

  it('using buildTerrainAccessConfig directly reproduces the digest too', () => {
    const original = runOf();
    const config = buildTerrainAccessConfig(original);
    const reRun = reRunFromConfig(original, config);
    expect(reRun.ok).toBe(true);
    if (!reRun.ok) return;
    expect(reRun.record.result.resultDigest).toBe(original.record.result.resultDigest);
  });

  it('a config that changes the profile is a real finding, not silently swallowed', () => {
    // A low ridge down column 2 (rows 1-4), with row 0 left flat as the only
    // gap: a loose step tolerance crosses the ridge directly (shorter,
    // diagonal route); a near-zero step tolerance cannot cross it anywhere
    // except the flat row-0 gap, forcing a longer detour — a different route,
    // and so a different resultDigest, from the SAME endpoints and terrain.
    const ridged = dtmOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0.3, 0, 0],
      [0, 0, 0.3, 0, 0],
      [0, 0, 0.3, 0, 0],
      [0, 0, 0.3, 0, 0],
    ]);
    const loose = runTerrainAccess(ridged, RESOLVED, PROFILE, 0, 24, TERRAIN_ACCESS_DEFAULTS, identity);
    const tight = runTerrainAccess(
      ridged, RESOLVED, { ...PROFILE, maxStepHeight: 0.01 }, 0, 24, TERRAIN_ACCESS_DEFAULTS, identity,
    );
    expect(loose.ok).toBe(true);
    if (tight.ok && loose.ok) {
      expect(tight.record.result.resultDigest).not.toBe(loose.record.result.resultDigest);
    } else {
      expect(tight.ok).toBe(false);
    }
  });
});

describe('the README never crosses into §22 forbidden language', () => {
  it('states the geometry-screening disclaimer and never claims safe/drivable/passable', () => {
    const zip = buildTerrainAccessPackage(runOf(), { basename: 'ta' });
    const readme = textOf(zip, 'ta-README.txt');
    expect(readme).toMatch(/geometry-based traversability screening/i);
    expect(readme).toMatch(/NOT a safety assessment, a guaranteed-passable route/i);
    // The forbidden words must never appear as a positive claim — every
    // sentence carrying one (line breaks collapsed first) is a "not"/"never"
    // sentence.
    const flat = readme.replace(/\s+/g, ' ');
    const sentences = flat.split(/(?<=[.!?])\s+/);
    const dangerous = /\b(safe|drivable|passable)\b/i;
    for (const sentence of sentences) {
      if (dangerous.test(sentence)) {
        expect(sentence).toMatch(/\b(not|never|no|n't)\b/i);
      }
    }
  });
});

// The route GeoJSON and the traversability raster must carry the REAL
// world coordinates in the dataset CRS, not a fixed local (0, 0) — and a
// `.prj` sidecar when the CRS resolves. Origin picked in the ~400000,
// 3600000 range to match a real far-mount UTM placement, so a truncation
// bug would show up as metres of drift rather than being masked by a
// small/zero origin.
describe('georeferenced export', () => {
  it('writes the real lower-left corner on the raster when a world origin is supplied', () => {
    const zip = buildTerrainAccessPackage(runOf(), {
      basename: 'ta',
      worldOrigin: { x: 400123.5, y: 3600456.25 },
    });
    const asc = textOf(zip, 'ta-traversability.asc');
    expect(asc).toMatch(/xllcorner 400123\.5/);
    expect(asc).toMatch(/yllcorner 3600456\.25/);
  });

  it('offsets the route GeoJSON coordinates by the same world origin', () => {
    const zip = buildTerrainAccessPackage(runOf(), {
      basename: 'ta',
      worldOrigin: { x: 400123.5, y: 3600456.25 },
    });
    const geojson = jsonOf<{ features: { geometry: { coordinates: [number, number][] } }[] }>(zip, 'ta-route.geojson');
    const [x0, y0] = geojson.features[0].geometry.coordinates[0];
    expect(x0).toBeCloseTo(400123.5, 6);
    expect(y0).toBeCloseTo(3600456.25, 6);
  });

  it('writes a local (0, 0) origin and no .prj when no world origin/CRS is supplied', () => {
    const zip = buildTerrainAccessPackage(runOf(), { basename: 'ta' });
    const asc = textOf(zip, 'ta-traversability.asc');
    expect(asc).toMatch(/xllcorner 0\n/);
    expect(asc).toMatch(/yllcorner 0\n/);
    expect(() => extractEntry(zip, 'ta.prj')).toThrow();
  });

  it('writes a .prj sidecar with the supplied WKT when the CRS resolves', () => {
    const wkt = 'PROJCS["NAD83(2011) / UTM zone 13N",...]';
    const zip = buildTerrainAccessPackage(runOf(), {
      basename: 'ta',
      worldOrigin: { x: 400123.5, y: 3600456.25 },
      wkt,
    });
    expect(textOf(zip, 'ta.prj')).toBe(wkt);
    expect(textOf(zip, 'ta-README.txt')).toContain('ta.prj');
  });
});
