/**
 * streamingColors.ts
 *
 * Colour computation for COPC streaming nodes. Every node is coloured against
 * **cloud-global** ranges — the Z range from the COPC header, the intensity
 * range seeded from the coarse root node — so adjacent nodes never band at
 * their shared edge.
 *
 * Pure — no DOM, no three.js — reuses the range-explicit helpers from
 * `colorModes.ts`, so the classification palette and elevation ramp stay
 * single-sourced with the static pipeline.
 */

import type { ColorMode } from '../colorModes';
import { colorByElevation, colorByIntensity, colorByClassification } from '../colorModes';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { CopcMetadata } from '../../io/copc/copcTypes';

/** Cloud-global colour ranges, so every streaming node colours consistently. */
export interface StreamingColorRanges {
  /** Local-space Z range, for elevation colouring. */
  minZ: number;
  maxZ: number;
  /** Intensity range — seeded from the root node's decoded chunk. */
  minIntensity: number;
  maxIntensity: number;
}

/**
 * The colour modes a COPC streaming cloud supports. RGB only when the point
 * format carries it; normal mode is omitted (COPC PDRF 6/7/8 carry no
 * normals).
 */
export function availableStreamingModes(metadata: CopcMetadata): ColorMode[] {
  const modes: ColorMode[] = [];
  if (metadata.header.hasRgb) modes.push('rgb');
  modes.push('intensity', 'elevation', 'classification');
  return modes;
}

/** The default colour mode for a streaming cloud — RGB when present. */
export function defaultStreamingMode(metadata: CopcMetadata): ColorMode {
  return metadata.header.hasRgb ? 'rgb' : 'elevation';
}

/** The intensity `[min, max]` of a decoded chunk — used to seed the global range. */
export function intensityRangeOf(decoded: DecodedChunk): { min: number; max: number } {
  if (decoded.pointCount === 0) return { min: 0, max: 0 };
  let min = decoded.intensity[0];
  let max = decoded.intensity[0];
  for (let i = 1; i < decoded.pointCount; i++) {
    const v = decoded.intensity[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Per-point interleaved RGB (3 bytes/point) for one decoded streaming node in
 * the active mode, using the cloud-global ranges. A mode the node cannot
 * satisfy (RGB on a format without it, normals) falls back to elevation.
 */
export function streamingNodeColors(
  mode: ColorMode,
  decoded: DecodedChunk,
  ranges: StreamingColorRanges,
): Uint8Array {
  const n = decoded.pointCount;
  switch (mode) {
    case 'rgb':
      return decoded.rgb ?? colorByElevation(decoded.positions, n, ranges.minZ, ranges.maxZ);
    case 'intensity':
      return colorByIntensity(
        decoded.intensity,
        n,
        ranges.minIntensity,
        ranges.maxIntensity,
      );
    case 'classification':
      return colorByClassification(decoded.classification, n);
    case 'elevation':
    case 'normal':
    default:
      return colorByElevation(decoded.positions, n, ranges.minZ, ranges.maxZ);
  }
}
