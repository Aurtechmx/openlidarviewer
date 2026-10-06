/**
 * The reference plane is visual only: drawing it changes no scientific result.
 *
 * The same digests the presentation-invariance matrix pins (terrain DTM
 * product, lasso stockpile result, profile series and section, scan-report
 * density) plus the scan's own position and classification bytes are taken
 * with the plane off, with it drawn (horizontal at the scan minimum, then
 * through three points picked from the scan), and after it is turned off
 * again. All must be identical.
 *
 * On its own this cannot fail: the analyses never receive the scene. What
 * makes it true is held by `workplaneDataIsolation.test.ts`, which fails if a
 * source file walks the scene graph or a data-path module imports the plane.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  digestOf,
  dtmOutcome,
  profileOutcome,
  resolvePresentation,
  scanReportDensity,
  staticScene,
  stockpileOutcome,
  STATIC_LASSO_WORLD,
} from './helpers/scientificDigests';
import { createWorkplaneController } from '../src/app/workplaneController';
import { WorkplaneOverlay } from '../src/render/workplane/WorkplaneOverlay';
import { spatialContextFrom } from '../src/geo/SpatialContext';

const RP = resolvePresentation({ dpr: 1, edl: true, budget: 'default', governor: 'nominal', pose: 'A' });

function results(scene: ReturnType<typeof staticScene>): Record<string, string> {
  const profile = profileOutcome(scene, RP);
  return {
    dtm: dtmOutcome(scene, RP).digest,
    stockpile: stockpileOutcome(scene, RP, STATIC_LASSO_WORLD).digest,
    profileSeries: profile.seriesDigest,
    profileSection: profile.sectionDigest,
    density: scanReportDensity(scene),
    positions: digestOf(Array.from(scene.cloud.positions)),
    classification: digestOf(Array.from(scene.cloud.classification ?? [])),
  };
}

describe('reference plane: analysis invariance', () => {
  it('every result digest is identical with the plane off, drawn, and off again', () => {
    const scene = staticScene();
    const off = results(scene);

    const objects = new Set<THREE.Object3D>();
    const host = { add: (o: THREE.Object3D) => objects.add(o), remove: (o: THREE.Object3D) => objects.delete(o), requestFrame: () => {} };
    const pos = scene.cloud.positions;
    let pickIndex = 0;
    const pickOrder = [0, 39, 40 * 39]; // three corners of the fixture grid
    const listeners = new Map<string, (e: PointerEvent) => void>();
    const viewer = {
      getCameraState: () => ({ position: [20, -40, 60] as [number, number, number], target: [20, 20, 0] as [number, number, number] }),
      orthographic: false,
      derivedLayerHost: () => host,
      onDrawnFrame: () => () => {},
      pickPoint: () => {
        const i = pickOrder[pickIndex++ % 3];
        return { x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] };
      },
      mergedVisibleBounds: () => [0, 0, 0, 40, 40, 36],
      measure: { worldUp: [0, 0, 1], datumResolved: true },
      clouds: () => ['invariance-fixture'],
      hasStreamingCloud: false,
    };
    const canvas = {
      clientWidth: 1200,
      clientHeight: 800,
      addEventListener: (t: string, l: (e: PointerEvent) => void) => listeners.set(t, l),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    const controller = createWorkplaneController({
      viewer: () => viewer,
      canvas,
      context: () => spatialContextFrom({ source: 'wkt', name: 'UTM', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
      sceneOrigin: () => [0, 0, 0],
      makeDrawing: (h) => new WorkplaneOverlay(h),
      lightBackdrop: () => false,
      onChange: () => {},
    });

    controller.setEnabled(true);
    controller.useScanMinimum();
    expect(controller.view().drawn).toBe(true);
    expect(objects.size).toBe(1);
    expect(results(scene)).toEqual(off);

    controller.beginPick('three-point');
    for (let k = 0; k < 3; k++) {
      listeners.get('pointerdown')!({ button: 0, offsetX: 600, offsetY: 400 } as PointerEvent);
      listeners.get('pointerup')!({ button: 0, offsetX: 600, offsetY: 400 } as PointerEvent);
    }
    expect(controller.view().settings.orientation).toBe('three-point');
    expect(results(scene)).toEqual(off);

    controller.setEnabled(false);
    expect(objects.size).toBe(0);
    expect(results(scene)).toEqual(off);
  });
});
