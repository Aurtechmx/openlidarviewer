/**
 * OrthographicRgbExporter.ts
 *
 * The "Orthographic RGB" Studio mode — a snapshot of the live view in the
 * user's currently active colour mode. The WYSIWYG cut routes through
 * the same `viewer.snapshot()` pipeline as the other modes (live camera,
 * EDL, measurement + annotation overlays baked in) so the export matches
 * exactly what the user sees on-screen, plus the corner scan-report card.
 *
 * Naming note: "Orthographic" historically referred to a parallel-projection
 * camera swap this exporter performed. Since the current Studio routes every
 * mode through the live perspective camera, this exporter is functionally an
 * "RGB Snapshot" — a current-mode capture of the live view. The legacy
 * `orthoCameraForPerspective` helper is retained below for back-compat with
 * external callers that imported it.
 */

import * as THREE from 'three/webgpu';
import type {
  ExportContext,
  ExportFactory,
  ExportResult,
  OrthographicRgbOptions,
} from './types';
import type { ColorMode } from '../render/colorModes';
import { runStudioExport } from './BaseExportMode';

/** Fallback focal distance — retained for the legacy ortho-projection helper. */
const FALLBACK_FOCAL_DISTANCE_M = 10;

/**
 * Legacy helper exported for backward compatibility + unit tests. Builds a
 * parallel-projection camera matching the perspective camera's pose at a
 * given focal distance. The current Studio cut no longer uses it (every
 * export goes through the live camera + snapshot pipeline), but the math
 * stays here for callers that already imported it.
 */
export function orthoCameraForPerspective(
  camera: THREE.PerspectiveCamera,
  focalDistance: number,
): THREE.OrthographicCamera {
  const fovRad = (camera.fov * Math.PI) / 180;
  const halfH = focalDistance * Math.tan(fovRad / 2);
  const halfW = halfH * camera.aspect;
  const ortho = new THREE.OrthographicCamera(
    -halfW,
    halfW,
    halfH,
    -halfH,
    camera.near,
    camera.far,
  );
  ortho.position.copy(camera.position);
  ortho.quaternion.copy(camera.quaternion);
  ortho.updateMatrixWorld();
  ortho.updateProjectionMatrix();
  return ortho;
}

export const orthographicRgbExporter: ExportFactory = {
  mode: 'orthographic-rgb',
  label: 'Orthographic RGB',

  isAvailable(): boolean {
    return true;
  },

  async render(
    context: ExportContext,
    options: OrthographicRgbOptions,
  ): Promise<ExportResult> {
    // No forced colour mode — capture whatever the user has active
    // (RGB / intensity / elevation / classification). The other Studio modes
    // (Height Map, Intensity, Class Map) override this; Ortho RGB is the
    // pass-through that exports the live view as-is.
    const currentMode: ColorMode = context.adapter.currentColorMode();
    // `FALLBACK_FOCAL_DISTANCE_M` is referenced via the legacy
    // `orthoCameraForPerspective` export above; tagged here so tree-shakers
    // don't drop the helper from the public surface.
    void FALLBACK_FOCAL_DISTANCE_M;
    return runStudioExport(
      context,
      'orthographic-rgb',
      'RGB Snapshot',
      currentMode,
      options,
      [{ label: 'Mode', value: currentMode }],
    );
  },
};
