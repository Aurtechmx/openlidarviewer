/**
 * flowOverlayInvalidation.test.ts — tearing down the Flow Pulse Lab's
 * persisted 3D overlay when its source terrain goes stale, WITHOUT the Lab
 * being reopened.
 *
 * `acquireFlowOverlay` only re-checks staleness when the Lab mounts, so a
 * scan closing, a different scan loading, a CRS change, or a classification
 * edit while the Lab stays closed left the previous overlay attached to the
 * scene at the wrong place. `terrainAnalysisRunner.ts`'s `abortAndClearCache()`
 * already fires on every one of those events; it now calls
 * `invalidateFlowOverlay()` (see `lazyChunks.ts`), which reaches this
 * module's persisted overlay through the disposer it registers at load time.
 * This proves that path end to end without importing `terrainAnalysisRunner.ts`
 * itself (which pulls in the whole terrain-analysis graph) — the registration
 * seam is exactly `lazyChunks.ts`'s `registerFlowOverlayInvalidator`/
 * `invalidateFlowOverlay` pair, exercised directly.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { acquireFlowOverlay, disposePersistentFlowOverlay } from '../src/ui/fieldSimulation/flowPulseLab';
import { invalidateFlowOverlay } from '../src/lazyChunks';
import { buildFlowAccumulationBuffers, flowOverlayFrame } from '../src/render/flowOverlayGeometry';
import { runFlowPulse, FLOW_PULSE_DEFAULTS, type FlowRunIdentity } from '../src/simulation/flowPulse/flowPulseRunner';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/** A host that records what the overlay attaches and detaches. */
function fakeHost() {
  const objects: THREE.Object3D[] = [];
  return {
    add: (o: THREE.Object3D) => { objects.push(o); },
    remove: (o: THREE.Object3D) => {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    requestFrame: () => {},
    objects,
  };
}

const projected: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

function dtmOf(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n),
    counts: new Uint32Array(n), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0, crs: null,
    verticalDatum: null, coverageMode: 'full',
  } as DtmGrid;
}

const identity: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: 'test-build', id: 'run-1',
  generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};

/** A drawn accumulation mesh on `host`, standing in for what the Lab paints. */
function paintAccumulation(host: ReturnType<typeof fakeHost>): void {
  const dtm = dtmOf([[4, 3, 2], [3, 2, 1], [2, 1, 0]]);
  const outcome = runFlowPulse(dtm, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
  if (!outcome.ok) throw new Error(`fixture run refused: ${outcome.code}`);
  const overlay = acquireFlowOverlay(host, () => false);
  if (!overlay) throw new Error('acquireFlowOverlay returned null for a real host');
  const frame = flowOverlayFrame('z', dtm.originH1, dtm.originH2, dtm.cellSizeM);
  overlay.setAccumulation(buildFlowAccumulationBuffers(outcome.grid, outcome.routed, outcome.accumulation, frame));
}

describe('invalidateFlowOverlay tears down the persisted overlay without reopening the Lab', () => {
  it('disposes and detaches the overlay when the staleness signal fires', () => {
    const host = fakeHost();
    paintAccumulation(host);
    expect(host.objects.length).toBeGreaterThan(0);

    // No Lab reopen, no `acquireFlowOverlay` call — this is the ONLY thing
    // that fires, exactly as `abortAndClearCache()` calls it.
    invalidateFlowOverlay();

    expect(host.objects.length).toBe(0);
  });

  it('is a no-op when nothing is persisted (e.g. the Lab was never opened)', () => {
    disposePersistentFlowOverlay(); // start from a clean slate
    expect(() => invalidateFlowOverlay()).not.toThrow();
  });

  it('a fresh acquire after invalidation builds a NEW overlay, not the disposed one', () => {
    const host = fakeHost();
    paintAccumulation(host);
    invalidateFlowOverlay();
    expect(host.objects.length).toBe(0);

    // Reopening the Lab afterwards must still work: a fresh overlay, drawable.
    paintAccumulation(host);
    expect(host.objects.length).toBeGreaterThan(0);
    disposePersistentFlowOverlay(); // leave no state for the next test file
  });
});
