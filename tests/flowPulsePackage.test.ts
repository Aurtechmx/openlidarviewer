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

/** Extract a stored (uncompressed) entry's bytes from a store-only ZIP. */
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
const textOf = (zip: Uint8Array, name: string): string => {
  const bytes = extractEntry(zip, name);
  if (!bytes) throw new Error(`entry not found: ${name}`);
  return new TextDecoder().decode(bytes);
};
const jsonOf = <T,>(zip: Uint8Array, name: string): T => JSON.parse(textOf(zip, name)) as T;

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

describe('the config reproduces the field digest', () => {
  it('re-running the exported config over the same terrain gives the same fieldDigest (raw)', () => {
    const original = runOf({ conditioning: 'raw' });
    const zip = buildFlowPulsePackage(original, { basename: 'flow' });
    const config = jsonOf<Record<string, unknown>>(zip, 'flow.olv-field-sim.json');

    expect(config.kind).toBe('terrain-flow');
    const reRun = runFlowPulse(bowlDtm(), projected, {
      conditioning: config.conditioning as FlowPulseParams['conditioning'],
      routing: config.routing as FlowPulseParams['routing'],
      interpolated: config.interpolated as FlowPulseParams['interpolated'],
      fillEpsilon: config.fillEpsilon as number,
      fillNoData: config.fillNoData as FlowPulseParams['fillNoData'],
      maxCells: config.maxCells as number,
      withheldExcluded: original.basis.withheldExcluded,
    }, identity);
    expect(reRun.ok).toBe(true);
    if (!reRun.ok) return;
    expect(reRun.record.result.fieldDigest).toBe(original.record.result.fieldDigest);
  });

  it('reproduces the field digest for a conditioned run too', () => {
    const original = runOf({ conditioning: 'priority-flood', fillEpsilon: 0.01 });
    const config = buildFlowPulseConfig(original);
    const reRun = runFlowPulse(bowlDtm(), projected, {
      conditioning: config.conditioning as FlowPulseParams['conditioning'],
      routing: config.routing as FlowPulseParams['routing'],
      interpolated: config.interpolated as FlowPulseParams['interpolated'],
      fillEpsilon: config.fillEpsilon as number,
      fillNoData: config.fillNoData as FlowPulseParams['fillNoData'],
      maxCells: config.maxCells as number,
      withheldExcluded: original.basis.withheldExcluded,
    }, identity);
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
