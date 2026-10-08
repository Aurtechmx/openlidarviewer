/**
 * testSeamMount.ts: the Playwright seam under `?test=1`, lifted out of main.ts.
 *
 * Mounts `window.__OLV_TEST_API__` so the e2e suite can drive a measurement
 * without the raycast headless CI cannot do. main.ts keeps the
 * `__OLV_TEST_SEAM__` compile-time guard at the call site and reaches this
 * module through a dynamic import, so any build with the constant false
 * (every shipped build) drops both the call and this chunk.
 *
 * Driven through a structural {@link TestSeamDeps} of accessor functions, the
 * same seam `measurePanelMount` and `openScan` use. The Viewer is reached only
 * through `getViewer()`, which resolves the lazy Viewer chunk.
 */

import { loadEptLaszipWorkerClient } from '../../lazyChunks';
import type { Viewer } from '../../render/Viewer';
import { ClassVisibility } from '../../render/class/classVisibility';

/** Accessor functions closing over the shell's late-bound state. */
export interface TestSeamDeps {
  /** Starts (if needed) and resolves the lazy Viewer. */
  getViewer: () => Promise<Viewer>;
  /** The active scan id, read at call time. */
  getActiveScanId: () => string | null;
  /** Mount/show the reclassify panel. */
  showReclassify: () => Promise<void> | void;
  /** Re-sync the reclassify panel's undo/redo state, if mounted. */
  refreshReclassify: () => void;
}

export function mountTestSeam(deps: TestSeamDeps): void {
  void deps.getViewer().then((v) => {
  const placePoint = (x: number, y: number, z: number, layer?: string): void => {
    if (![x, y, z].every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new Error(
        'placeMeasurementPoint: { x, y, z } must all be finite numbers',
      );
    }
    v.measure.addPoint([x, y, z], layer ? v.getCloud(v.clouds().find((id) => v.getCloud(id)?.name === layer) ?? '') : undefined);
  };
  (window as unknown as { __OLV_TEST_API__: unknown }).__OLV_TEST_API__ = {
    version: '1',
    setMeasureMode: (on: boolean) => v.setMeasureMode(on),
    setMeasureKind: (kind: string) => {
      // The MeasureController validates the kind itself; we just pass
      // through. Invalid kinds throw a clear error at the controller
      // level so the test sees a precise failure.
      v.measure.setKind(kind as Parameters<typeof v.measure.setKind>[0]);
    },
    placeMeasurementPoint: (p: { x: number; y: number; z: number; layer?: string }) => {
      placePoint(p.x, p.y, p.z, p.layer);
    },
    finishMeasurement: () => v.measure.finishCurrent(),
    clearMeasurements: () => v.clearMeasurements(),
    getMeasurementCount: () => v.measure.getMeasurements().length,
    layerProjectPoints: (i: number) => v.layerProjectPoints(i), getCameraPose: () => v.getCameraPose(),
    // A scene point projected to page coordinates through the camera the last
    // frame drew with, so a spec can click a known scan point in any projection.
    projectToClient: (p: { x: number; y: number; z: number }): { x: number; y: number } | null => {
      const cam = (v as unknown as { _activeCamera(): { matrixWorldInverse: { elements: number[] }; projectionMatrix: { elements: number[] } } })._activeCamera();
      const m = cam.matrixWorldInverse.elements;
      const q = cam.projectionMatrix.elements;
      const e = [p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12], p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13], p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14], 1];
      const c = [0, 1, 2, 3].map((r) => q[r] * e[0] + q[4 + r] * e[1] + q[8 + r] * e[2] + q[12 + r] * e[3]);
      if (!(c[3] !== 0)) return null;
      const canvas = document.querySelector<HTMLCanvasElement>('.olv-canvas');
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return null;
      return { x: rect.left + ((c[0] / c[3] + 1) / 2) * rect.width, y: rect.top + ((1 - c[1] / c[3]) / 2) * rect.height };
    },
    // Whether the viewer's own point pick finds the scan at a page position.
    pickAtClient: (x: number, y: number): boolean => {
      const rect = document.querySelector<HTMLCanvasElement>('.olv-canvas')?.getBoundingClientRect();
      if (!rect) return false;
      return v.pickPoint(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1) !== null;
    },
    // Elevation filter (v0.5.6) device-verify seam: pass a world-space
    // [min, max] window (or null to clear) and confirm points outside it hide.
    setElevationFilter: (range: [number, number] | null) =>
      v.setElevationFilter(range ?? undefined),
    // Intensity filter (v0.5.6) device-verify seam: pass a raw-intensity
    // [min, max] window (or null to clear) and confirm points outside it hide.
    setIntensityFilter: (range: [number, number] | null) =>
      v.setIntensityFilter(range ?? undefined),
    // Classification edit seam — seed a uniform class, reclassify a screen
    // lasso, undo/redo, and read a point's class, so the reclassify tool's
    // full flow is e2e-verifiable without running the heavy classifier.
    seedUniformClass: (cls: number): number => {
      const id = deps.getActiveScanId();
      if (!id) return 0;
      const cloud = v.getCloud(id);
      if (!cloud) return 0;
      const n = cloud.positions.length / 3;
      v.applyDerivedClassification(id, new Uint8Array(n).fill(cls));
      return n;
    },
    reclassifyLasso: (lasso: ReadonlyArray<{ x: number; y: number }>, newClass: number): number => {
      const id = deps.getActiveScanId();
      return id ? v.reclassifyLasso(id, lasso, newClass).changedCount : 0;
    },
    undoClass: (): boolean => {
      const id = deps.getActiveScanId();
      return id ? v.undoClassification(id) : false;
    },
    redoClass: (): boolean => {
      const id = deps.getActiveScanId();
      return id ? v.redoClassification(id) : false;
    },
    // Hide `hidden` class codes through the GPU class filter, then count the
    // points it still draws from the uploaded classification attribute.
    gpuDrawnCount: (hidden: number[]): number => {
      const visibility = new ClassVisibility();
      for (const code of hidden) visibility.setVisible(code, false);
      v.applyClassVisibility(visibility);
      const id = deps.getActiveScanId();
      return id ? v.classFilterDrawnCount(id) : -1;
    },
    classAt: (i: number): number => {
      const id = deps.getActiveScanId();
      const c = id ? v.getCloud(id)?.classification : undefined;
      return c ? c[i] : -1;
    },
    // Mount/show the reclassify panel (normally triggered when a
    // classification appears) and re-sync its undo/redo enabled state, so the
    // visible controls are e2e-drivable without running the full classifier.
    showReclassify: () => deps.showReclassify(),
    refreshReclassify: () => deps.refreshReclassify(),
    // EPT laszip decode-worker round-trip — the one path no other e2e
    // exercises end-to-end in a real browser: the lazy worker-client chunk
    // load, `new Worker(new URL(...))` URL resolution (the seam the live
    // source-transform can scramble), laz-perf WASM init inside the worker,
    // decode of a complete LAZ tile, and the zero-copy transfer back.
    // Returns the decoded point count so the spec can assert against the
    // known fixture. Owns and disposes its own worker — never touches
    // viewer state.
    decodeEptLaszipTileInWorker: async (tile: ArrayBuffer): Promise<number> => {
      const { EptLaszipWorkerClient } = await loadEptLaszipWorkerClient();
      const client = new EptLaszipWorkerClient();
      try {
        const decoded = await client.decodeTile(tile, [0, 0, 0]);
        return decoded.pointCount;
      } finally {
        client.dispose();
      }
    },
  };
  // Diagnostic so a stray production page with the flag still shows
  // up in the console — discourages anyone from depending on it
  // outside the e2e suite.
  console.warn(
    'OpenLiDARViewer: ?test=1 enabled — window.__OLV_TEST_API__ ' +
      'is mounted. This is for Playwright only; do not ship URLs ' +
      'with this flag to end users.',
  );
  });
}
