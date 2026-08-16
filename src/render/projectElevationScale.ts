/**
 * projectElevationScale.ts — the shared elevation colour window across layers
 * that sit in one project frame.
 *
 * By default each mounted layer colours elevation against its OWN per-cloud
 * percentile window, so one world height can read as different colours across
 * layers and the legend describes a single cloud. The opt-in project-shared
 * mode paints every frame-sharing layer against ONE window — the union of the
 * colored static clouds' world-Z ranges — so identical world heights land at
 * the same ramp position and the legend describes the whole project.
 *
 * The comparability authority is the MOUNT/PROJECT FRAME, not a vertical-unit
 * name: layers the mount system placed in the shared frame are unit/datum
 * compatible by construction, so a union of their world-Z ranges is sound
 * without a per-layer unit label the live model does not carry.
 *
 * Pure math only (no Viewer / WebGL state) so it is unit-testable.
 */

import { rampRangeForMode, colorForMode, type ColorForModeOptions } from './colorModes';
import { writeFloatColorsInto } from './colorEncode';
import { isZUpFormat } from '../io/sniffFormat';
import { participatesInSharedAnalysis, type LayerCompatibility } from '../model/layerCompatibility';
import type { PointCloud } from '../model/PointCloud';

interface Range {
  min: number;
  max: number;
}

/** A loaded layer as this module reads it — a structural subset of CloudEntry. */
export interface FrameLayer {
  cloud: PointCloud;
  mode: string;
  mounted?: boolean;
  compatibility?: LayerCompatibility;
}

/** Which interleaved component is "up" for a cloud (Z for surveys, Y for phone scans). */
export function upAxisOf(cloud: PointCloud): 0 | 1 | 2 {
  return isZUpFormat(cloud.sourceFormat) ? 2 : 1;
}

/**
 * Whether a layer sits in the project frame: mounted (mount system placed it)
 * and compatibility-clean. Layers that pass are unit/datum-compatible by
 * construction, so their world-Z ranges may be unioned without a unit name.
 */
export function sharesProjectFrame(e: {
  mounted?: boolean;
  compatibility?: LayerCompatibility;
}): boolean {
  return e.mounted !== false && participatesInSharedAnalysis(e.compatibility ?? 'verified');
}

/** A range both of whose ends are finite and ordered (min <= max). */
function isFiniteOrdered(r: Range): boolean {
  return Number.isFinite(r.min) && Number.isFinite(r.max) && r.min <= r.max;
}

/**
 * The shared elevation window in WORLD-Z: the union of the per-cloud world-Z
 * ranges. Non-finite / disordered ranges are ignored. Returns null when fewer
 * than two usable ranges remain — a single layer has nothing to share against,
 * so the caller falls back to per-cloud percentile windows (unchanged).
 */
export function sharedElevationWorldRange(
  ranges: ReadonlyArray<Range>,
): Range | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const r of ranges) {
    if (!isFiniteOrdered(r)) continue;
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
    count++;
  }
  if (count < 2) return null;
  return { min, max };
}

/**
 * Map a shared WORLD-Z window onto one cloud's LOCAL (origin-subtracted) frame
 * by subtracting the cloud's up-axis origin from both ends. Elevation colouring
 * runs on local Z, so applying this local override makes a given world height
 * land at the same ramp position across layers with different origins.
 */
export function localOverrideFor(shared: Range, originUp: number): Range {
  return { min: shared.min - originUp, max: shared.max - originUp };
}

/**
 * The shared elevation window across the elevation-coloured, frame-sharing
 * layers: the world-Z union of their percentile ramp ranges. `trim` is the
 * active height-percentile trim. Null when fewer than two such layers exist.
 */
export function computeSharedElevationRange(
  layers: Iterable<FrameLayer>,
  trim: number,
): Range | null {
  const ranges: Range[] = [];
  for (const e of layers) {
    if (e.mode !== 'elevation' || !sharesProjectFrame(e)) continue;
    const upAxis = upAxisOf(e.cloud);
    const r = rampRangeForMode('elevation', e.cloud, { heightPercentileTrim: trim, upAxis });
    if (!r) continue;
    const o = e.cloud.sourceOrigin[upAxis];
    ranges.push({ min: r.min + o, max: r.max + o });
  }
  return sharedElevationWorldRange(ranges);
}

/**
 * Elevation colour opts for one layer, folding in the shared-scale override
 * (its LOCAL frame) when a shared window exists and the layer is in-frame.
 */
export function elevationOptsFor(
  e: FrameLayer,
  shared: Range | null,
  trim: number,
): ColorForModeOptions {
  const upAxis = upAxisOf(e.cloud);
  const override =
    shared && sharesProjectFrame(e)
      ? localOverrideFor(shared, e.cloud.sourceOrigin[upAxis])
      : undefined;
  return { heightPercentileTrim: trim, upAxis, elevationRangeOverride: override };
}

/** A layer whose colour buffer can be rewritten in place (CloudEntry subset). */
export interface RecolorableLayer extends FrameLayer {
  colorAttr: { array: ArrayLike<number>; needsUpdate: boolean };
}

/**
 * Repaint every elevation-mode layer's colour buffer in place, folding in the
 * shared window (per-cloud local override) when one is supplied. Kept beside the
 * range math so the Viewer holds one call; writes GPU-bound buffers, so not pure.
 */
export function applyElevationColors(
  layers: Iterable<RecolorableLayer>,
  shared: Range | null,
  trim: number,
): void {
  for (const e of layers) {
    if (e.mode !== 'elevation') continue;
    const raw = colorForMode('elevation', e.cloud, elevationOptsFor(e, shared, trim));
    writeFloatColorsInto(e.colorAttr.array as Float32Array, raw); // sRGB → linear seam
    e.colorAttr.needsUpdate = true;
  }
}
