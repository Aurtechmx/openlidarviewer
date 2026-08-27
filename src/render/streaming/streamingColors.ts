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
  colorByNormal,
  colorByScalar,
  finiteMinMax,
} from '../colorModes';
import { densityForChunk, defaultCellSizeForSpacing } from '../densityColors';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import { renderLocalPositions } from '../../model/pointFrames';
import type { CopcMetadata } from '../../io/copc/copcTypes';
// Type-only: the shape a `.pnts` decoder marks a colourless node with. No
// runtime import, so the streaming colour chunk does not pull in the tileset
// parser, and the io layer keeps its own definition of what it produced.
import type { ColourUnstatedChunk } from '../../io/tiles3d/pntsDecode';
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

/**
 * The grey a node is drawn in when the channel the active mode reads is not
 * something the node states: its tile carries no colour while the rest of the
 * layer does, or the chunk carries no array for the requested scalar at all.
 *
 * Mid grey is achromatic, and every ramp the viewer paints (Turbo for
 * elevation and the scalars, the ASPRS palette for classes) is not: nothing a
 * ramp produces looks like this, so a flat patch cannot be misread as a
 * reading. It is a display value only. The chunk keeps saying the channel is
 * absent, so the point inspector, the resident-snapshot export and the patch
 * view all keep reporting that these points state nothing.
 */
export const UNSTATED_COLOUR_GREY = 128;

/**
 * The flat buffer for a mode whose channel the chunk does not carry.
 *
 * Substituting another channel would put a second reading under the first
 * one's legend: an elevation ramp under an "Intensity" label is a height map a
 * user would read as intensity. A ramp over a zero-filled stand-in would be
 * worse still, since it looks like a measurement of zero everywhere. Flat grey
 * states nothing, which is exactly what the node has to say.
 *
 * A source only offers the modes its format can fill (`colorModes()`, which is
 * `PNTS_COLOR_MODES` for point tiles), so this is the backstop for a mode
 * arriving from a restored view state rather than a path the UI walks.
 */
function channelAbsentColors(pointCount: number): Uint8Array {
  return new Uint8Array(pointCount * 3).fill(UNSTATED_COLOUR_GREY);
}

/**
 * Whether a decoded node is one a `.pnts` decoder marked as stating no colour
 * inside a layer whose colour meaning is the colour tiles state.
 *
 * Read through the marker type rather than a loose string, so renaming the mark
 * breaks the build instead of silently turning this back into a height ramp.
 */
function colourUnstated(decoded: DecodedChunk): boolean {
  return (decoded as Partial<ColourUnstatedChunk>).colourUnstated === true;
}

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
 * cloud-global colour ranges from a decoded node. One helper for intensity
 * and returnNumber so the seeding semantics can never drift per-field, and a
 * straight delegation to the static pipeline's `finiteMinMax` so the two
 * pipelines share ONE definition of the non-finite rules: skip NaN/±Infinity
 * (a malformed loader must not poison a cloud-global window) and degenerate
 * to `{ 0, 0 }` when nothing finite exists. The current seeded channels are
 * integer-typed and can never be NaN, but the guard costs nothing and any
 * future Float channel routed through here inherits it.
 */
export function scalarRangeOf(
  values: ArrayLike<number>,
  count: number,
): { min: number; max: number } {
  return finiteMinMax(values, count);
}

/**
 * The intensity `[min, max]` of a decoded chunk — used to seed the global
 * range — or null when the chunk carries no intensity.
 *
 * Null rather than `{ 0, 0 }`: a seeded window of zero width would be a claim
 * about the cloud's intensity, and a source with no intensity channel has no
 * such claim to make. The caller leaves the global range untouched instead.
 */
export function intensityRangeOf(
  decoded: DecodedChunk,
): { min: number; max: number } | null {
  if (!decoded.intensity) return null;
  return scalarRangeOf(decoded.intensity, decoded.pointCount);
}

/**
 * Per-point interleaved RGB (3 bytes/point) for one decoded streaming node in
 * the active mode, using the cloud-global ranges.
 *
 * RGB on a format without it falls back to the elevation ramp, which is the
 * layer's one meaning in that case rather than a second one. A mode whose
 * per-point channel this CHUNK does not carry is drawn flat instead — see
 * {@link channelAbsentColors}; no other channel stands in for it.
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
        // A node marked as stating no colour belongs to a layer whose other
        // nodes ARE painted from their stated RGB. Ramping it by height would
        // put a second colour meaning in the same scene, reading as the first.
        // It is drawn flat instead, and the reader says why (see the mixed
        // tileset notices in `pntsDecode.ts`).
        if (colourUnstated(decoded)) {
          return new Uint8Array(n * 3).fill(UNSTATED_COLOUR_GREY);
        }
        // Otherwise the whole source lacks RGB (a COPC/EPT format flag says so,
        // or every tile of a tileset stated none), so the elevation ramp is the
        // layer's one meaning rather than a second one.
        return colorByElevation(renderLocalPositions(decoded), n, ranges.minZ, ranges.maxZ);
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
        let v = tmp[i];
        if (tmp[i] <= 0) v = 0;
        else if (tmp[i] >= 1) v = 1;
        out[i] = Math.round(v * 255);
      }
      // The InstancedBufferAttribute upload copies the bytes — the
      // shared buffer is safe to reuse for the next node.
      return out.subarray(0, len);
    }
    case 'intensity':
      if (!decoded.intensity) return channelAbsentColors(n);
      return colorByIntensity(
        decoded.intensity,
        n,
        ranges.minIntensity,
        ranges.maxIntensity,
      );
    case 'classification':
      if (!decoded.classification) return channelAbsentColors(n);
      return colorByClassification(decoded.classification, n);
    // The scalar modes colour against the cloud-GLOBAL window (never a
    // node-local one) for the same reason elevation and intensity do:
    // per-node ranges would rebase the ramp at every node boundary and band
    // adjacent COPC/EPT nodes at their shared edge. GPS time's Float64
    // magnitude is handled inside `colorByScalar` — the min subtraction
    // happens in double precision, so sub-second deltas survive the ramp.
    case 'gpsTime':
      if (!decoded.gpsTime) return channelAbsentColors(n);
      return colorByScalar(decoded.gpsTime, n, ranges.minGpsTime, ranges.maxGpsTime);
    case 'returnNumber':
      if (!decoded.returnNumber) return channelAbsentColors(n);
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
        positions: renderLocalPositions(decoded),
        cellSize: defaultCellSizeForSpacing(
          (ranges as { spacing?: number }).spacing ?? 0,
        ),
      }).colors;
    case 'normal':
      // A chunk with no normals is drawn flat, never ramped by height: an
      // elevation ramp under a Normal legend is a second reading wearing the
      // first one's label. A source only offers this mode once a node has
      // actually stated normals, so a chunk reaching here without them is the
      // mixed-tileset case (or a restored view state), not the common path.
      if (!decoded.normals) return channelAbsentColors(n);
      // The static pipeline's own encoding, not a copy of it, so a surface gets
      // the same colour whether the scan was streamed or loaded whole.
      return colorByNormal(decoded.normals, n);
    case 'elevation':
    default:
      return colorByElevation(renderLocalPositions(decoded), n, ranges.minZ, ranges.maxZ);
  }
}
