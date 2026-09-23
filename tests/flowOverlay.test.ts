/**
 * flowOverlay.test.ts — the three.js binding for the flow overlay's lifecycle.
 *
 * three/webgpu constructs geometries, materials and objects without a GPU, so
 * attach/detach/dispose and the visibility toggle are provable in Node, the
 * same way `contourOverlay.test.ts` proves `ContourOverlay`'s. What a headless
 * test cannot prove is that the result is visible on screen — that is the
 * `tests/e2e/flowPulseLab.spec.ts` check.
 *
 * The §17 proof (toggling never touches the run's own digest) lives here too,
 * at the layer where "toggle" is an actual state — `setAccumulationVisible`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { FlowOverlay } from '../src/render/FlowOverlay';
import { buildFlowAccumulationBuffers, buildFlowCatchmentBuffers, buildFlowPathBuffers, flowOverlayFrame } from '../src/render/flowOverlayGeometry';
import { flowFieldDigest } from '../src/simulation/flowPulse/flowFieldDigest';
import { FLOW_PULSE_DEFAULTS, runFlowPulse, type FlowRunIdentity } from '../src/simulation/flowPulse/flowPulseRunner';
import { catchmentClick, traceClick } from '../src/simulation/flowPulse/flowClickGuard';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/** A host that records what the overlay attaches and detaches. */
function fakeHost() {
  const objects: THREE.Object3D[] = [];
  let frames = 0;
  return {
    add: (o: THREE.Object3D) => { objects.push(o); },
    remove: (o: THREE.Object3D) => {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    requestFrame: () => { frames++; },
    objects,
    get frames() { return frames; },
  };
}

const projected: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: '0.7.0-alpha.1', id: 'run-1',
  generatedAt: '2026-09-22T00:00:00.000Z', processingManifestHead: null,
};

function dtmOf(rows: readonly (readonly (number | null)[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      coverage[r * w + c] = 2;
    }
  }
  return {
    z, coverage, confidence: new Float32Array(n), counts: new Uint32Array(n),
    interpDistanceCells: new Float32Array(n), cols: w, rows: h, cellSizeM: 1,
    originH1: 0, originH2: 0, crs: null, verticalDatum: null, coverageMode: 'full',
  } as DtmGrid;
}

function slope() {
  const dtm = dtmOf([[4, 2], [null, null]]);
  const outcome = runFlowPulse(dtm, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
  if (!outcome.ok) throw new Error('fixture must run');
  return outcome;
}

const frame = flowOverlayFrame('z', 0, 0, 1);

describe('FlowOverlay — accumulation layer', () => {
  it('attaches one mesh on the first upload, updates it in place on the next', () => {
    const host = fakeHost();
    const overlay = new FlowOverlay(host);
    const result = slope();
    expect(host.objects).toHaveLength(0);

    overlay.setAccumulation(buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame));
    expect(host.objects).toHaveLength(1);
    expect(overlay.accumulationCellCount).toBe(2);

    overlay.setAccumulation(buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame));
    expect(host.objects).toHaveLength(1); // still one mesh, not a second

    overlay.dispose();
  });

  it('shows and hides without discarding the upload', () => {
    const host = fakeHost();
    const overlay = new FlowOverlay(host);
    const result = slope();
    overlay.setAccumulation(buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame));
    const mesh = host.objects[0] as THREE.Mesh;

    overlay.setAccumulationVisible(false);
    expect(mesh.visible).toBe(false);
    expect(host.objects).toHaveLength(1); // hidden, not removed

    overlay.setAccumulationVisible(true);
    expect(mesh.visible).toBe(true);

    overlay.dispose();
  });

  it('removes the mesh and releases GPU resources on clear', () => {
    const host = fakeHost();
    const overlay = new FlowOverlay(host);
    const result = slope();
    overlay.setAccumulation(buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame));
    overlay.clearAccumulation();
    expect(host.objects).toHaveLength(0);
    expect(overlay.accumulationCellCount).toBe(0);
  });
});

describe('FlowOverlay — path and catchment layers', () => {
  it('draws a path, then clears it independently of the catchment and accumulation', () => {
    const host = fakeHost();
    const overlay = new FlowOverlay(host);
    const result = slope();

    const trace = traceClick(result, { col: 0, row: 0 }, false);
    if (!trace.ok) throw new Error('fixture trace must resolve');
    overlay.setPath(buildFlowPathBuffers(result.grid, trace.path, frame));
    expect(overlay.pathSegmentCount).toBe(1);
    expect(host.objects).toHaveLength(1);

    const catchment = catchmentClick(result, { col: 1, row: 0 }, false);
    if (!catchment.ok) throw new Error('fixture catchment must resolve');
    overlay.setCatchment(buildFlowCatchmentBuffers(result.grid, catchment.mask, frame));
    expect(host.objects).toHaveLength(2); // path AND catchment both on scene

    overlay.clearPath();
    // clearPath() detaches the path object (like the contour/measure overlays'
    // own `clear()`: hide-and-detach, not wipe) — the segment count it last
    // held is not the contract; being off the host's object list is.
    expect(host.objects).toHaveLength(1); // catchment still drawn, path detached

    overlay.dispose();
    expect(host.objects).toHaveLength(0);
  });
});

describe('§17 — the overlay never touches the run it draws', () => {
  it('leaves fieldDigest unchanged across an upload, a visibility toggle, and dispose', () => {
    const host = fakeHost();
    const overlay = new FlowOverlay(host);
    const result = slope();
    const before = flowFieldDigest(result.grid, result.routed, result.accumulation, result.conditioned);

    overlay.setAccumulation(buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame));
    overlay.setAccumulationVisible(false);
    overlay.setAccumulationVisible(true);
    const trace = traceClick(result, { col: 0, row: 0 }, false);
    if (trace.ok) overlay.setPath(buildFlowPathBuffers(result.grid, trace.path, frame));
    overlay.dispose();

    const after = flowFieldDigest(result.grid, result.routed, result.accumulation, result.conditioned);
    expect(after).toBe(before);
  });
});
