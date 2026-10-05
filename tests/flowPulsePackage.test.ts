/**
 * flowPulsePackage.test.ts: the Flow Pulse deliverable, and its reproduction.
 *
 * Two properties matter more than the file list:
 *
 *   re-running the package's own reproducible config over the same terrain
 *   reproduces the same fieldDigest — the whole point of shipping a config
 *   rather than only a result;
 *
 *   the README never crosses into the language §22/§31 forbid — "flood",
 *   "discharge", "runoff" — because a package is read outside the app, where
 *   nothing else stops an overclaim from standing unchallenged.
 */
import { describe, expect, it } from 'vitest';

import { buildFlowPulseConfig, buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import {
  FLOW_PULSE_DEFAULTS,
  catchmentFrom,
  pulseFrom,
  runFlowPulse,
  type FlowPulseParams,
  type FlowPulseResult,
} from '../src/simulation/flowPulse/flowPulseRunner';
import { verifyScientificArtifactPassport } from '../src/science/scientificArtifactPassport';
import { verifyProcessingManifest } from '../src/science/processingManifest';
import { sha256Hex } from '../src/terrain/export/sha256';
import {
  FLOW_PROJECTED_SCALE as projected,
  FLOW_TEST_IDENTITY as identity,
  flowDtmOf as dtmOf,
} from './helpers/flowFixtures';
import { extractEntry, textOf, jsonOf } from './helpers/zipReader';

const params = (over: Partial<FlowPulseParams> = {}): FlowPulseParams => ({ ...FLOW_PULSE_DEFAULTS, ...over });

/** A notched bowl: gives every optional artifact something real to show — a
 * sink to condition, a path, and a catchment. */
const bowlDtm = () => dtmOf([
  [5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5],
]);

function runOf(over: Partial<FlowPulseParams> = {}): FlowPulseResult {
  const r = runFlowPulse(bowlDtm(), projected, params(over), identity);
  if (!r.ok) throw new Error(`fixture run refused: ${r.code}`);
  return r;
}

describe('the package carries every required file', () => {
  it('ships the raw-mode core set', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow' });
    for (const name of [
      'flow-accumulation.asc', 'flow-direction.asc', 'flow-sinks-depressions.csv',
      'flow-summary.csv', 'flow-simulation-run.json', 'flow.olv-field-sim.json',
      'flow-processing-manifest.json', 'flow-README.txt',
      'flow-scientific-artifact-passport.json', 'SHA256SUMS.txt',
    ]) {
      expect(extractEntry(zip, name), name).not.toBeNull();
    }
    // Nothing supplied a path or catchment, so those files are absent rather
    // than written empty.
    expect(extractEntry(zip, 'flow-flow-path.geojson')).toBeNull();
    expect(extractEntry(zip, 'flow-catchment.asc')).toBeNull();
  });

  it('adds the path and catchment files only when the caller supplies them', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const path = { cells: pulseFrom(result, 0) };
    const catchment = { mask: catchmentFrom(result, 12), outletCell: 12 };
    const zip = buildFlowPulsePackage(result, { basename: 'flow', path, catchment });
    expect(extractEntry(zip, 'flow-flow-path.geojson')).not.toBeNull();
    expect(extractEntry(zip, 'flow-catchment.asc')).not.toBeNull();

    const geojson = jsonOf<{ coordinateFrame: string; features: unknown[] }>(zip, 'flow-flow-path.geojson');
    expect(geojson.coordinateFrame).toBe('local-planar-metres');
    expect(geojson.features).toHaveLength(1);
  });

  // The ASCII rasters must carry the REAL lower-left corner in the dataset
  // CRS, not a fixed (0, 0), and a `.prj` sidecar when the CRS resolves.
  // Origin picked in the ~400000, 3600000 range to match a real
  // far-mount UTM placement (see tests/contourWorldOrigin.test.ts).
  it('writes the real lower-left corner when a world origin is supplied', () => {
    const zip = buildFlowPulsePackage(runOf(), {
      basename: 'flow',
      worldOrigin: { x: 400123.5, y: 3600456.25 },
    });
    const asc = textOf(zip, 'flow-accumulation.asc');
    expect(asc).toMatch(/xllcorner 400123\.5/);
    expect(asc).toMatch(/yllcorner 3600456\.25/);
  });

  it('writes a local (0, 0) origin and no .prj when no world origin/CRS is supplied', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow' });
    const asc = textOf(zip, 'flow-accumulation.asc');
    expect(asc).toMatch(/xllcorner 0\n/);
    expect(asc).toMatch(/yllcorner 0\n/);
    expect(extractEntry(zip, 'flow.prj')).toBeNull();
  });

  it('writes a .prj sidecar with the supplied WKT when the CRS resolves', () => {
    const wkt = 'PROJCS["NAD83(2011) / UTM zone 13N",...]';
    const zip = buildFlowPulsePackage(runOf(), {
      basename: 'flow',
      worldOrigin: { x: 400123.5, y: 3600456.25 },
      wkt,
    });
    expect(textOf(zip, 'flow.prj')).toBe(wkt);
    expect(textOf(zip, 'flow-README.txt')).toContain('flow.prj');
  });

  // Every fill-depth/elevation figure in the summary/depression CSVs is a
  // raw number with no unit; the README must state which unit applies,
  // failing closed when the caller has not resolved one.
  it('states the vertical unit is unresolved, fail-closed, with no caller-supplied unit', () => {
    const readme = textOf(buildFlowPulsePackage(runOf(), { basename: 'flow' }), 'flow-README.txt');
    expect(readme).toMatch(/Vertical unit\s+unresolved.*source units/);
  });

  it('describes the processing manifest as a self-consistency check, not tamper-evidence', () => {
    const readme = textOf(buildFlowPulsePackage(runOf(), { basename: 'flow' }), 'flow-README.txt');
    expect(readme).toContain('hash-chained (a self-consistency check, not a signature)');
    expect(readme).not.toContain('tamper-evident processing steps');
  });

  it('states the resolved vertical unit when the caller supplies one', () => {
    const readme = textOf(
      buildFlowPulsePackage(runOf(), { basename: 'flow', verticalUnitLabel: 'm' }),
      'flow-README.txt',
    );
    expect(readme).toMatch(/Vertical unit\s+m\n/);
  });

  it('every listed file hashes to what SHA256SUMS.txt records', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow' });
    const manifest = textOf(zip, 'SHA256SUMS.txt');
    const lines = manifest.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      const [hash, name] = line.split(/\s+\*?/);
      const bytes = extractEntry(zip, name);
      expect(bytes, name).not.toBeNull();
      // Recompute independently rather than trust the manifest's own claim.
      expect(sha256Hex(bytes as Uint8Array)).toBe(hash);
    }
  });

  it('binds a passport that verifies over the accumulation raster it names', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow' });
    const passport = jsonOf(zip, 'flow-scientific-artifact-passport.json') as Parameters<typeof verifyScientificArtifactPassport>[0];
    const accumulationBytes = extractEntry(zip, 'flow-accumulation.asc')!;
    expect(verifyScientificArtifactPassport(passport, { artifactBytes: accumulationBytes })).toBe('VERIFIED');
  });

  it('writes a processing manifest that verifies intact', () => {
    const zip = buildFlowPulsePackage(runOf({ conditioning: 'priority-flood' }), { basename: 'flow' });
    const manifest = jsonOf(zip, 'flow-processing-manifest.json') as Parameters<typeof verifyProcessingManifest>[0];
    expect(verifyProcessingManifest(manifest).ok).toBe(true);
  });
});

/** Re-run `bowlDtm()` under a `.olv-field-sim.json` config's own parameters. */
function reRunFromConfig(config: Record<string, unknown>, withheldExcluded: boolean | null) {
  return runFlowPulse(bowlDtm(), projected, {
    conditioning: config.conditioning as FlowPulseParams['conditioning'],
    routing: config.routing as FlowPulseParams['routing'],
    interpolated: config.interpolated as FlowPulseParams['interpolated'],
    fillEpsilon: config.fillEpsilon as number,
    fillNoData: config.fillNoData as FlowPulseParams['fillNoData'],
    maxCells: config.maxCells as number,
    withheldExcluded,
  }, identity);
}

describe('the config reproduces the field digest', () => {
  it('re-running the exported config over the same terrain gives the same fieldDigest (raw)', () => {
    const original = runOf({ conditioning: 'raw' });
    const zip = buildFlowPulsePackage(original, { basename: 'flow' });
    const config = jsonOf<Record<string, unknown>>(zip, 'flow.olv-field-sim.json');

    expect(config.kind).toBe('terrain-flow');
    const reRun = reRunFromConfig(config, original.basis.withheldExcluded);
    expect(reRun.ok).toBe(true);
    if (!reRun.ok) return;
    expect(reRun.record.result.fieldDigest).toBe(original.record.result.fieldDigest);
  });

  it('reproduces the field digest for a conditioned run too', () => {
    const original = runOf({ conditioning: 'priority-flood', fillEpsilon: 0.01 });
    const config = buildFlowPulseConfig(original);
    const reRun = reRunFromConfig(config, original.basis.withheldExcluded);
    expect(reRun.ok).toBe(true);
    if (!reRun.ok) return;
    expect(reRun.record.result.fieldDigest).toBe(original.record.result.fieldDigest);
  });

  it('a config that changes the fieldDigest is a real finding, not silently swallowed', () => {
    const raw = runOf({ conditioning: 'raw' });
    const flooded = runOf({ conditioning: 'priority-flood' });
    expect(raw.record.result.fieldDigest).not.toBe(flooded.record.result.fieldDigest);
  });
});

describe('the README never crosses into forbidden hydraulic language', () => {
  it('states SIMULATED and only ever disclaims flood/runoff/discharge, never claims them', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow' });
    const readme = textOf(zip, 'flow-README.txt');
    expect(readme).toMatch(/SIMULATED/);
    // The honest negation must be present...
    expect(readme).toMatch(/not rainfall,?\s*\n?\s*runoff, infiltration or flood modelling/i);
    expect(readme).toMatch(/accumulation counts cells, not water/i);
    // ...and the words that make it dangerous, "flood"/"discharge"/"runoff", must
    // never appear on their own as a positive claim — every SENTENCE carrying one
    // (line breaks collapsed first, so a sentence wrapped across lines is not
    // split apart) is a "not"/"never"/"no" sentence.
    const flat = readme.replace(/\s+/g, ' ');
    const sentences = flat.split(/(?<=[.!?])\s+/);
    const dangerous = /\b(flood|discharge|runoff)\b/i;
    for (const sentence of sentences) {
      if (dangerous.test(sentence)) {
        expect(sentence.toLowerCase(), sentence).toMatch(/\b(not|never|no)\b/);
      }
    }
  });

  it('names every limitation the run carried, verbatim', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const zip = buildFlowPulsePackage(result, { basename: 'flow' });
    const readme = textOf(zip, 'flow-README.txt');
    for (const l of result.limitations) expect(readme).toContain(l);
  });
});

describe('outlet elevations match the Lab readout', () => {
  const depressionRows = (zip: Uint8Array) => textOf(zip, 'flow-sinks-depressions.csv').trim().split('\n');

  it('adds the recentring origin back when the caller knows it', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const local = result.depressions.depressions[0]!.outletElevation!;
    const zip = buildFlowPulsePackage(result, { basename: 'flow', elevationOrigin: 1000 });
    const [header, first] = depressionRows(zip);
    expect(header!.split(',')[4]).toBe('outletElevation');
    expect(Number(first!.split(',')[4])).toBe(local + 1000);
    expect(textOf(zip, 'flow-summary.csv')).toContain(`largestDepressionOutletElevation,${local + 1000}`);
    expect(textOf(zip, 'flow-README.txt')).toContain('the same figure the Lab readout shows');
  });

  it('names the column Local and states the frame when the origin is unknown', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const local = result.depressions.depressions[0]!.outletElevation!;
    const zip = buildFlowPulsePackage(result, { basename: 'flow' });
    const [header, first] = depressionRows(zip);
    expect(header!.split(',')[4]).toBe('outletElevationLocal');
    expect(Number(first!.split(',')[4])).toBe(local);
    expect(textOf(zip, 'flow-summary.csv')).toContain('largestDepressionOutletElevationLocal,');
    expect(textOf(zip, 'flow-README.txt')).toContain('load-time recentred frame');
  });
});

describe('the README states an unusable terrain run', () => {
  it('names the verdict and the interpolated share', () => {
    const zip = buildFlowPulsePackage(runOf(), {
      basename: 'flow', terrainCaveat: { verdict: 'Blocked', interpolatedPercent: 99 },
    });
    const readme = textOf(zip, 'flow-README.txt');
    expect(readme).toContain('TERRAIN RUN NOT USABLE: read this result as illustration only.');
    expect(readme).toContain('Terrain verdict  Blocked');
    expect(readme).toContain('99% of the ground surface is interpolated, not measured');
  });

  it('carries no banner for a usable surface', () => {
    const readme = textOf(buildFlowPulsePackage(runOf(), { basename: 'flow' }), 'flow-README.txt');
    expect(readme).not.toContain('NOT USABLE');
  });
});

describe('README figures are rounded', () => {
  it('prints cell size to 3 decimals and contributing area to 1', () => {
    const scale = { ...projected, unitToMetres: 0.1 + 0.2 };
    const r = runFlowPulse(bowlDtm(), scale, params(), identity);
    if (!r.ok) throw new Error(`fixture run refused: ${r.code}`);
    const readme = textOf(buildFlowPulsePackage(r, { basename: 'flow' }), 'flow-README.txt');
    expect(readme).not.toMatch(/\d\.\d{4,}/);
    expect(readme).toMatch(/Cell size\s+0\.3 m/);
  });
});

describe('the exported rasters and path sit at their true place', () => {
  // Hand check: world origin (500000, 4000000), DTM corner offset (-120, -80),
  // 1 m cells. The true lower-left corner is (499880, 3999920).
  const georef = {
    basename: 'flow',
    worldOrigin: { x: 500000, y: 4000000 },
    gridFrame: { originH1: -120, originH2: -80, cellSize: 1 },
  } as const;
  const header = (zip: Uint8Array, name: string, key: string): number => {
    const line = textOf(zip, name).split('\n').find((l) => l.toLowerCase().startsWith(key))!;
    return Number(line.trim().split(/\s+/)[1]);
  };

  it('adds the DTM corner offset to every raster corner', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const zip = buildFlowPulsePackage(result, {
      ...georef,
      catchment: { mask: catchmentFrom(result, 12), outletCell: 12 },
    });
    for (const name of ['flow-accumulation.asc', 'flow-direction.asc', 'flow-catchment.asc']) {
      expect(header(zip, name, 'xllcorner'), name).toBe(499880);
      expect(header(zip, name, 'yllcorner'), name).toBe(3999920);
    }
  });

  it('writes path vertices at cell centres', () => {
    const result = runOf();
    const zip = buildFlowPulsePackage(result, { ...georef, path: { cells: Int32Array.from([1 * 5 + 3]) } });
    const geojson = jsonOf<{ coordinateFrame: string; features: { geometry: { coordinates: number[][] } }[] }>(zip, 'flow-flow-path.geojson');
    // Cell (col 3, row 1): east 499880 + 3.5, north 3999920 + 1.5.
    expect(geojson.features[0]!.geometry.coordinates[0]).toEqual([499883.5, 3999921.5]);
    expect(geojson.coordinateFrame).toBe('scan-source-coordinates');
  });

  it('places a Y-up scene the same way: H2 is north, and the overlay alone negates it', async () => {
    const { flowOverlayFrame } = await import('../src/render/flowOverlayGeometry');
    const frame = flowOverlayFrame('y', -120, -80, 1);
    // The overlay puts north on scene -Z; the export keeps H2 as north.
    expect(frame.negateNorthing).toBe(true);
    expect(frame.originH1).toBe(-120);
    expect(frame.originH2).toBe(-80);
    const zip = buildFlowPulsePackage(runOf(), { ...georef, path: { cells: Int32Array.from([0]) } });
    const geojson = jsonOf<{ features: { geometry: { coordinates: number[][] } }[] }>(zip, 'flow-flow-path.geojson');
    expect(geojson.features[0]!.geometry.coordinates[0]).toEqual([499880.5, 3999920.5]);
    expect(header(zip, 'flow-accumulation.asc', 'yllcorner')).toBe(3999920);
  });
});

describe('outlet elevations with an unresolved vertical unit', () => {
  it('keeps the Local columns, since the Lab readout shows no elevation', () => {
    const result = runOf({ conditioning: 'priority-flood' });
    const local = result.depressions.depressions[0]!.outletElevation!;
    const zip = buildFlowPulsePackage(result, { basename: 'flow', elevationOrigin: 1000, verticalResolved: false });
    const [head, first] = textOf(zip, 'flow-sinks-depressions.csv').trim().split('\n');
    expect(head!.split(',')[4]).toBe('outletElevationLocal');
    expect(Number(first!.split(',')[4])).toBe(local);
    expect(textOf(zip, 'flow-README.txt')).not.toContain('the same figure the Lab readout shows');
  });
});

describe('the path frame uses the Terrain Access names', () => {
  const frameOf = (zip: Uint8Array) => jsonOf<{ coordinateFrame: string }>(zip, 'flow-flow-path.geojson').coordinateFrame;
  const path = { cells: Int32Array.from([0]) };
  const gridFrame = { originH1: -120, originH2: -80, cellSize: 1 };

  it('scan-crs with a world origin and a resolved CRS', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow', path, gridFrame, worldOrigin: { x: 1, y: 2 }, wkt: 'PROJCS["x"]' });
    expect(frameOf(zip)).toBe('scan-crs');
    expect(textOf(zip, 'flow-README.txt')).toContain('coordinateFrame scan-crs');
  });

  it('scan-source-coordinates with a world origin and no CRS', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow', path, gridFrame, worldOrigin: { x: 1, y: 2 } });
    expect(frameOf(zip)).toBe('scan-source-coordinates');
  });

  it('local-planar-metres with no world origin, from the (0, 0) corner in metres', () => {
    const zip = buildFlowPulsePackage(runOf(), { basename: 'flow', path, gridFrame });
    expect(frameOf(zip)).toBe('local-planar-metres');
    const g = jsonOf<{ features: { geometry: { coordinates: number[][] } }[] }>(zip, 'flow-flow-path.geojson');
    expect(g.features[0]!.geometry.coordinates[0]).toEqual([0.5, 0.5]);
  });
});
