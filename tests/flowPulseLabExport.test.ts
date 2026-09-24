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
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const projected: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true,
};

const identity: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: '0.7.0-alpha.1', id: 'run-1',
  generatedAt: '2026-09-22T00:00:00.000Z', processingManifestHead: null,
};

function dtmOf(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n),
    counts: new Uint32Array(n), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0, crs: null,
    verticalDatum: null, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, meanConfidence: 1, warnings: [],
  } as DtmGrid;
}

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

  // ── Defect D: `buildFlowPulseExport` must forward the caller's real
  // world origin / CRS through to the package builder, rather than dropping
  // it on the floor and letting every raster land at a fixed (0, 0).
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
