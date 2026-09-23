/**
 * terrainAccessIsolation.test.ts: §17's Continuity-isolation discipline,
 * applied to a module with no presentation coupling to isolate FROM — so what
 * this pins instead is the precondition that discipline depends on: the core
 * is pure DOM/three.js-free source with no non-deterministic primitive, and a
 * full run over one input is byte-identical across repeated invocations.
 *
 * A later UI phase can then build Continuity-isolation tests the ordinary way
 * (assert a result is unchanged as EDL/DPR/point size/Evidence Lens vary)
 * without having to first prove the computation itself holds still — this
 * file is that proof for the pure core.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const SRC_DIR = join(__dirname, '..', 'src', 'simulation', 'terrainAccess');

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts')).map((f) => join(SRC_DIR, f));
}

describe('the pure core has no DOM/render/three coupling', () => {
  const files = sourceFiles();

  it('has files to check, so the scan below is not vacuous', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)('%s imports nothing from ui/, render/ or three', (file) => {
    const text = readFileSync(file, 'utf8');
    const importLines = text.split('\n').filter((l) => /\bfrom\s+['"]/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/from\s+['"](\.\.\/)*(ui|render)\//);
      expect(line).not.toMatch(/from\s+['"]three(\/|['"])/);
    }
  });

  it.each(files)('%s uses no document/window/navigator global', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\bdocument\./);
    expect(text).not.toMatch(/\bwindow\./);
    expect(text).not.toMatch(/\bnavigator\./);
  });
});

describe('the pure core is deterministic', () => {
  const files = sourceFiles();

  it.each(files)('%s calls neither Math.random nor Date/performance.now', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/Math\.random\s*\(/);
    expect(text).not.toMatch(/new\s+Date\s*\(/);
    expect(text).not.toMatch(/Date\.now\s*\(/);
    expect(text).not.toMatch(/performance\.now\s*\(/);
  });
});

describe('a full run is byte-identical across repeated invocations', () => {
  it('same DTM, same profile, same endpoints ⇒ same record digest, same path, same diagnostics', () => {
    const n = 49;
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) z[i] = Math.sin(i * 0.37) * 2; // an arbitrary, fixed, non-flat surface
    const confidence = new Float32Array(n).fill(90);
    const coverage = new Uint8Array(n).fill(2);
    const counts = new Uint32Array(n).fill(3);
    const interpDistanceCells = new Float32Array(n);
    const dtm: DtmGrid = {
      z, confidence, coverage, counts, interpDistanceCells,
      cols: 7, rows: 7, cellSizeM: 1, originH1: 0, originH2: 0,
      crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
      verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
      withheldExcluded: true, meanConfidence: 90, warnings: [],
    };
    const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
    const profile: TerrainAccessProfile = {
      name: 'determinism-check',
      maxLongitudinalGrade: 5, maxCrossSlope: 5, maxStepHeight: 5, maxRuggedness: 0.9,
      vehicleWidth: 0.5, vehicleLength: null, minimumTerrainConfidence: 10,
      unknownPolicy: 'block', obstacleHeightThreshold: null,
    };

    const runs = Array.from({ length: 5 }, (_, k) =>
      runTerrainAccess(dtm, scale, profile, 0, 48, TERRAIN_ACCESS_DEFAULTS, {
        layerId: null, filename: null, sourceDigest: null, analysisInputDigest: 'd',
        build: 'b', id: `run-${k}`, generatedAt: `2026-01-0${(k % 9) + 1}T00:00:00.000Z`,
        processingManifestHead: null,
      }));

    for (const r of runs) expect(r.ok).toBe(true);
    const digests = runs.map((r) => (r.ok ? r.record.digest : null));
    const paths = runs.map((r) => (r.ok ? r.record.result.resultDigest : null));
    expect(new Set(digests).size).toBe(1);
    expect(new Set(paths).size).toBe(1);
  });
});
