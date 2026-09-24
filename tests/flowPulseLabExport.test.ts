/**
 * flowPulseLabExport.test.ts — the Flow Pulse Lab's export action.
 *
 * `buildFlowPulseExport` is the pure core `handleExport` calls once the lazy
 * package-builder chunk resolves: it refuses a stale result and a run that
 * never completed, and otherwise hands `buildFlowPulsePackage` the current
 * path/catchment traces. Exercised here against the real package builder so
 * "package contents include the run record and config" is a property of the
 * actual ZIP, not a mock's assumption.
 */
import { describe, expect, it } from 'vitest';

import { buildFlowPulseExport } from '../src/ui/fieldSimulation/flowPulseLab';
import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import {
  FLOW_PULSE_DEFAULTS,
  runFlowPulse,
  type FlowPulseResult,
  type FlowRunIdentity,
} from '../src/simulation/flowPulse/flowPulseRunner';
import { traceClick, catchmentClick } from '../src/simulation/flowPulse/flowClickGuard';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import { extractEntry } from './helpers/zipReader';
import { flowDtmOfCounted as dtmOf } from './helpers/flowFixtures';

const projected: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true,
};

const identity: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: '0.7.0-alpha.1', id: 'run-1',
  generatedAt: '2026-09-22T00:00:00.000Z', processingManifestHead: null,
};

const bowl = () => dtmOf([
  [5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5],
]);

function runOf(): FlowPulseResult {
  const r = runFlowPulse(bowl(), projected, { ...FLOW_PULSE_DEFAULTS }, identity);
  if (!r.ok) throw new Error(`fixture run refused: ${r.code}`);
  return r;
}

describe('a stale result', () => {
  it('is refused before the package builder runs', () => {
    const out = buildFlowPulseExport(runOf(), true, null, null, 'site', 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('stale');
  });
});

describe('a run that never completed', () => {
  it('is refused with no package built', () => {
    const refusal = runFlowPulse(null, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
    expect(refusal.ok).toBe(false);
    const out = buildFlowPulseExport(refusal, false, null, null, 'site', 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(false);
  });
});

describe('a fresh, non-stale result', () => {
  it('builds a package whose contents include the run record and config', () => {
    const out = buildFlowPulseExport(runOf(), false, null, null, 'site', 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filename).toBe('site-flow-pulse.zip');
    expect(extractEntry(out.bytes, 'site-simulation-run.json')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site.olv-field-sim.json')).not.toBeNull();
  });

  it('falls back to the layer id when no filename is known', () => {
    const out = buildFlowPulseExport(runOf(), false, null, null, null, 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filename).toBe('layer-a-flow-pulse.zip');
  });

  it('includes the traced path and catchment when present', () => {
    const result = runOf();
    const path = traceClick(result, { col: 0, row: 0 }, false);
    const catchment = catchmentClick(result, { col: 2, row: 2 }, false);
    const out = buildFlowPulseExport(result, false, path, catchment, 'site', 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(extractEntry(out.bytes, 'site-flow-path.geojson')).not.toBeNull();
    expect(extractEntry(out.bytes, 'site-catchment.asc')).not.toBeNull();
  });

  // `buildFlowPulseExport` must forward the caller's real world origin /
  // CRS through to the package builder, rather than dropping it on the
  // floor and letting every raster land at a fixed (0, 0).
  it('forwards the georef to the package, writing the real corner and a .prj', () => {
    const out = buildFlowPulseExport(
      runOf(), false, null, null, 'site', 'layer-a', buildFlowPulsePackage,
      { worldOrigin: { x: 400123.5, y: 3600456.25 }, crsName: 'EPSG:6342', wkt: 'PROJCS["fixture",...]' },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const asc = new TextDecoder().decode(extractEntry(out.bytes, 'site-accumulation.asc')!);
    expect(asc).toMatch(/xllcorner 400123\.5/);
    expect(asc).toMatch(/yllcorner 3600456\.25/);
    expect(extractEntry(out.bytes, 'site.prj')).not.toBeNull();
  });

  it('writes a local (0, 0) origin and no .prj when no georef is supplied', () => {
    const out = buildFlowPulseExport(runOf(), false, null, null, 'site', 'layer-a', buildFlowPulsePackage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const asc = new TextDecoder().decode(extractEntry(out.bytes, 'site-accumulation.asc')!);
    expect(asc).toMatch(/xllcorner 0\n/);
    expect(extractEntry(out.bytes, 'site.prj')).toBeNull();
  });
});
