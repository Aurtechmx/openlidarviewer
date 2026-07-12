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
import {
  colorByElevation,
  colorByIntensity,
  colorByClassification,
  colorByScalar,
} from '../colorModes';
import { densityForChunk, defaultCellSizeForSpacing } from '../densityColors';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { CopcMetadata } from '../../io/copc/copcTypes';
import { applyRgbAppearance, type RgbAppearance } from '../rgbAppearance';

/**
 * Module-level reusable buffers for the RGB-appearance recolor path.
 *
 * Each streaming `_recolorAll` walks every resident node and was
 * allocating a fresh Float32Array + Uint8Array per node. On a streaming
 * cloud with 200+ resident nodes during a white-balance slider drag,
 * that's 400+ allocations per frame and a GC stall a user can feel.
 *
 * One node is recoloured at a time (the call is synchronous from a
 * single owner), so a single growing pair is safe. The buffers grow
 * monotonically — never shrunk — because a smaller-than-current node
 * just uses the head of the existing buffer.
 */
let _rgbWorkFloat: Float32Array | null = null;
let _rgbWorkOut: Uint8Array | null = null;

/** Cloud-global colour ranges, so every streaming node colours consistently. */
export interface StreamingColorRanges {
  /** Local-space Z range, for elevation colouring. */
  minZ: number;
  maxZ: number;
  /** Intensity range — seeded from the root node's decoded chunk. */
  minIntensity: number;
  maxIntensity: number;
  /**
   * GPS-time range — seeded from the coarsest resident node, exactly like
   * intensity. The values are Float64 absolute times (~3e8 s GPS adjusted
   * standard time); every node normalises against THIS cloud-global window
   * before ramping, both to keep sub-second deltas visible and to keep
   * adjacent nodes from banding at their shared edge on node-local minima.
   */
  minGpsTime: number;
  maxGpsTime: number;
  /** Return-number range — seeded from the coarsest resident node. */
  minReturnNumber: number;
  maxReturnNumber: number;
}

/**
 * The colour modes a COPC streaming cloud supports. RGB only when the point
 * format carries it; normal mode is omitted (COPC PDRF 6/7/8 carry no
 * normals).
 */
export function availableStreamingModes(metadata: CopcMetadata): ColorMode[] {
  const modes: ColorMode[] = [];
  if (metadata.header.hasRgb) modes.push('rgb');
  modes.push('intensity', 'elevation', 'classification', 'density');
  // The continuous scalar modes — parity with the static pipeline's
  // `availableModes`. GPS time is gated on the header flag (defensive: COPC
  // mandates PDRF 6/7/8 which always carry it, but the flag is the honest
  // source of truth); return numbers are structural in every LAS point
  // record, so the mode is always offered.
  if (metadata.header.hasGpsTime) modes.push('gpsTime');
  modes.push('returnNumber');
  return modes;
}

/** The default colour mode for a streaming cloud — RGB when present. */
export function defaultStreamingMode(metadata: CopcMetadata): ColorMode {
  return metadata.header.hasRgb ? 'rgb' : 'elevation';
}

/**
 * The `[min, max]` of any per-point scalar array — used to seed the
 * cloud-global colour ranges from a decoded node. One helper for intensity,
 * gpsTime, and returnNumber so the seeding semantics can never drift
 * per-field.
 */
export function scalarRangeOf(
  values: ArrayLike<number>,
  count: number,
): { min: number; max: number } {
  if (count === 0) return { min: 0, max: 0 };
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < count; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** The intensity `[min, max]` of a decoded chunk — used to seed the global range. */
export function intensityRangeOf(decoded: DecodedChunk): { min: number; max: number } {
  return scalarRangeOf(decoded.intensity, decoded.pointCount);
}

/**
 * Per-point interleaved RGB (3 bytes/point) for one decoded streaming node in
 * the active mode, using the cloud-global ranges. A mode the node cannot
 * satisfy (RGB on a format without it, normals) falls back to elevation.
 *
 * **Buffer-reuse contract.** When `mode === 'rgb'` and an `rgbAppearance`
 * is passed, the returned `Uint8Array` is a `subarray` view of a shared
 * module-level scratch buffer. The next call overwrites it. Callers MUST
 * consume (copy / upload) the bytes synchronously before the next
 * invocation. Internal call sites (`_recolorAll`, `onNodeReady`) do.
 */
export function streamingNodeColors(
  mode: ColorMode,
  decoded: DecodedChunk,
  ranges: StreamingColorRanges,
  rgbAppearance?: RgbAppearance,
): Uint8Array {
  const n = decoded.pointCount;
  switch (mode) {
    case 'rgb': {
      const src = decoded.rgb;
      if (!src) {
        return colorByElevation(decoded.positions, n, ranges.minZ, ranges.maxZ);
      }
      // When an appearance bundle is active, apply it in sRGB float
      // space (the same room the static-cloud path uses) then quantise
      // back to Uint8 for the streaming colour buffer. The renderer's
      // sRGB / linear convention upstream stays unchanged.
      if (!rgbAppearance) return src;
      const len = src.length;
      // Grow the reusable scratch buffers if the current node is
      // bigger than any seen so far. Reuse the head otherwise.
      if (!_rgbWorkFloat || _rgbWorkFloat.length < len) {
        _rgbWorkFloat = new Float32Array(len);
      }
      if (!_rgbWorkOut || _rgbWorkOut.length < len) {
        _rgbWorkOut = new Uint8Array(len);
      }
      const tmp = _rgbWorkFloat;
      for (let i = 0; i < len; i++) tmp[i] = src[i] / 255;
      // `applyRgbAppearance` operates on `[0, len)` of the buffer; the
      // tail (when the buffer is larger than the node) is untouched
      // by both the appearance maths and the upload below.
      applyRgbAppearance(tmp.subarray(0, len), rgbAppearance);
      const out = _rgbWorkOut;
      for (let i = 0; i < len; i++) {
        const v = tmp[i] <= 0 ? 0 : tmp[i] >= 1 ? 1 : tmp[i];
        out[i] = Math.round(v * 255);
      }
      // The InstancedBufferAttribute upload copies the bytes — the
      // shared buffer is safe to reuse for the next node.
      return out.subarray(0, len);
    }
    case 'intensity':
      return colorByIntensity(
        decoded.intensity,
        n,
        ranges.minIntensity,
        ranges.maxIntensity,
      );
    case 'classification':
      return colorByClassification(decoded.classification, n);
    // The scalar modes colour against the cloud-GLOBAL window (never a
    // node-local one) for the same reason elevation and intensity do:
    // per-node ranges would rebase the ramp at every node boundary and band
    // adjacent COPC/EPT nodes at their shared edge. GPS time's Float64
    // magnitude is handled inside `colorByScalar` — the min subtraction
    // happens in double precision, so sub-second deltas survive the ramp.
    case 'gpsTime':
      return colorByScalar(decoded.gpsTime, n, ranges.minGpsTime, ranges.maxGpsTime);
    case 'returnNumber':
      return colorByScalar(
        decoded.returnNumber,
        n,
        ranges.minReturnNumber,
        ranges.maxReturnNumber,
      );
    case 'density':
      // Per-node density heatmap. Cell size derives from the streaming
      // ranges' spacing hint if present; otherwise the helper clamps to a
      // safe metre-scale default. Each node colours independently — this
      // is a deliberate design choice: contrast adapts to the LOCAL node's
      // coverage variability, which is what an analyst inspecting a
      // specific region wants (the alternative is a cloud-global anchor
      // that washes out per-region variation). Side-effect: subtle banding
      // can appear at node boundaries on heterogeneous datasets. The PDF
      // report card carries the per-node mean / max so the global picture
      // can still be reconstructed.
      return densityForChunk({
        positions: decoded.positions,
        cellSize: defaultCellSizeForSpacing(
          (ranges as { spacing?: number }).spacing ?? 0,
        ),
      }).colors;
    case 'elevation':
    case 'normal':
    default:
      return colorByElevation(decoded.positions, n, ranges.minZ, ranges.maxZ);
  }
}
