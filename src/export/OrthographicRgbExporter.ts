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
  ExportSceneAdapter,
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

/**
 * Decide whether this export can ship as a GEOREFERENCED top-down ortho
 * package (PNG + .pgw + .prj) instead of the WYSIWYG view capture.
 * All four gates must hold (v0.4.5, workplan C4):
 *
 *   1. The adapter implements the framed top-down render (older hosts and
 *      test stubs don't — they keep the view-capture path untouched).
 *   2. A cloud is loaded (the framing needs an AABB footprint).
 *   3. The world origin AND the CRS WKT are both known — the same honesty
 *      gate `buildStudioPngPackage` enforces; checking it here means we
 *      never swap the user's view capture for a top-down frame that would
 *      then fail to georeference anyway.
 *   4. No class filter is active. A filtered raster must carry the
 *      "showing N of M classes" banner, and burning that banner into a
 *      placed GIS layer would corrupt its pixels as data — a filtered
 *      export therefore stays a bannered view capture.
 *
 * Exported for unit tests — the decision is the contract; the GPU render
 * behind it is covered by the live build.
 */
export function shouldExportGeoreferencedOrtho(
  adapter: ExportSceneAdapter,
  classScopeStamp: string | undefined,
): boolean {
  if (typeof adapter.framedTopDownSnapshot !== 'function') return false;
  if (!adapter.localBoundsAabb()) return false;
  if ((classScopeStamp ?? '').trim().length > 0) return false;
  const geo = adapter.georefContext?.() ?? null;
  if (!geo || geo.worldOrigin == null) return false;
  return geo.wkt != null && geo.wkt.trim().length > 0;
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
    // Georeferenced path (v0.4.5, workplan C4) — when the scan carries a
    // world origin + CRS WKT, this mode finally earns its name: a TRUE
    // top-down orthographic frame of the full footprint, returned with the
    // exact extent so the host packages PNG + .pgw + .prj into one ZIP a
    // GIS places directly. The framed render is the only raster an affine
    // world file can describe; the perspective view capture below cannot
    // be georeferenced, which is why the world file only exists here.
    if (shouldExportGeoreferencedOrtho(context.adapter, context.classScopeStamp)) {
      // The gates above guarantee the hook + context are present.
      const geo = context.adapter.georefContext!()!;
      const framed = await context.adapter.framedTopDownSnapshot!({
        widthPx: options.width,
      });
      // A null framed render (device hiccup, degenerate footprint) falls
      // through to the plain view capture rather than failing the export.
      if (framed) {
        return {
          blob: framed.blob,
          mode: 'orthographic-rgb',
          width: framed.widthPx,
          height: framed.heightPx,
          mimeType: 'image/png',
          metadata: { framing: 'top-down orthographic', georeferenced: 'yes' },
          worldFile: {
            extent: framed.extent,
            widthPx: framed.widthPx,
            heightPx: framed.heightPx,
            worldOrigin: geo.worldOrigin!,
            wkt: (geo.wkt as string).trim(),
          },
        };
      }
    }

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
