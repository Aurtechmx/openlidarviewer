/**
 * flowHillshade.ts: the shaded relief the Flow Pulse map and the drainage
 * sheet draw under the flow lines. Pure and DOM-free.
 */

import type { FlowGrid } from './flowTypes';

/**
 * Lambertian hillshade per cell from the grid's own elevations, sun at
 * azimuth 315 deg (north-west), altitude 45 deg, in [0, 1]. Row 0 is the
 * southern row, so rows increase northwards. NoData and edge-adjacent
 * NoData neighbours fall back to the centre cell's elevation.
 */
export function hillshade(grid: FlowGrid): Float32Array {
  const { cols, rows, z, valid } = grid;
  const out = new Float32Array(cols * rows);
  // Compass azimuth 315 deg in the math convention the aspect formula uses (360 - az + 90).
  const zen = Math.PI / 4, az = (135 * Math.PI) / 180;
  const at = (c: number, r: number, fallback: number): number => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return fallback;
    const i = r * cols + c;
    return valid[i] ? z[i]! : fallback;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!valid[i]) continue;
      const z0 = z[i]!;
      const dzdx = (at(c + 1, r, z0) - at(c - 1, r, z0)) / (2 * grid.cellMetresX);
      // Horn's dz/dy runs north to south; rows here run south to north.
      const dzdy = (at(c, r - 1, z0) - at(c, r + 1, z0)) / (2 * grid.cellMetresY);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      out[i] = Math.min(1, Math.max(0, v));
    }
  }
  return out;
}
