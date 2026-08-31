/**
 * hypsometricPalette.ts — the built-in perceptual ramps as hypsometric stops.
 *
 * The surface-preview path colours a DTM tile through `hypsometricColor`, which
 * takes a `ColorStop[]` ramp; the point cloud colours elevation through the
 * named perceptual ramps in `colorModes` (cividis, viridis, …). This samples one
 * of those named ramps into the stop list the surface renderer wants, so an
 * analyst can style the terrain preview — and the PNG it exports — with the same
 * colour-blind-safe ramps the points use, and a swatch can never disagree with
 * the raster it labels.
 *
 * Pure: sampling only, no DOM and no three.js. Imported by the (lazy) Analyse
 * panel, so it never weighs on the startup bundle.
 */

import { elevationRampColor, type ElevationPalette } from './colorModes';
import type { ColorStop } from '../terrain/contour/hypsometric';

/** How many stops to sample a continuous ramp into. Enough for a smooth read. */
const DEFAULT_STOP_COUNT = 9;

/**
 * Sample a named perceptual ramp into evenly spaced hypsometric stops. `count`
 * stops span t ∈ [0, 1] inclusive; the surface renderer interpolates between
 * them exactly as it does the default terrain ramp.
 */
export function builtinHypsometricStops(
  palette: ElevationPalette,
  count = DEFAULT_STOP_COUNT,
): ColorStop[] {
  const n = Math.max(2, Math.floor(count));
  const stops: ColorStop[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [r, g, b] = elevationRampColor(t, palette);
    stops.push({ t, color: { r, g, b } });
  }
  return stops;
}
