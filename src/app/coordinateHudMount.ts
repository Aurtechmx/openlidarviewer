/**
 * coordinateHudMount.ts — wire the persistent coordinate HUD to the live probe.
 *
 * The composition root owns the viewer, the stage overlay and the CRS service;
 * this module folds the three into the one seam the HUD needs, so `main.ts` adds
 * a single probe hover sink rather than the build, mount and per-hover readout.
 *
 * SCOPE: it is driven by the probe hover — the one interaction that already
 * resolves a point per frame — so the HUD is live while the probe tool is on. It
 * reads the hover's display-rounded world coordinates (exactly what a corner
 * readout shows), reconstructs the readout input with a zero origin (the values
 * are already world-frame), and renders the honest banner from {@link cursorReadout}:
 * the active CRS, real units, the frame-status badge, and lat/lon only when the
 * host supplies a conversion. Nothing here resolves a CRS or converts a
 * coordinate itself.
 */

import { buildCoordinateHud } from '../ui/coordinateHud';
import { cursorReadout } from '../geo/cursorReadout';
import type { PointInfo, RawPointInfo } from '../render/pointInfo';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { SpatialUpAxis } from '../geo/SpatialContext';

export interface CoordinateHudDeps {
  /** Mount the HUD element into the scene overlay. */
  readonly mount: (element: HTMLElement) => void;
  /** The active resolved CRS, or undefined when no scan is open. */
  readonly activeCrs: () => ResolvedCrs | undefined;
  /** The scene up-axis, for the elevation-axis naming (`'unknown'` names none). */
  readonly upAxis: () => SpatialUpAxis;
}

/**
 * Build and mount the coordinate HUD, and return the probe hover sink the viewer
 * calls with the point under the cursor (or `null` to clear).
 */
export function wireCoordinateHud(deps: CoordinateHudDeps): (info: PointInfo | null) => void {
  const hud = buildCoordinateHud();
  deps.mount(hud.element);
  return (info: PointInfo | null): void => {
    if (!info) {
      hud.update(null);
      return;
    }
    // The hover's x/y/z are already world-frame (origin restored, display-rounded),
    // so the readout input carries them as `local` with a zero origin.
    const point: RawPointInfo = {
      layer: info.layer,
      index: info.index,
      local: [info.x, info.y, info.z],
      origin: [0, 0, 0],
      distance: info.distance,
      intensity: info.intensity,
      classification: info.classification,
      rgb: info.rgb,
    };
    hud.update(cursorReadout({ crs: { active: deps.activeCrs() }, point, upAxis: deps.upAxis() }));
  };
}
