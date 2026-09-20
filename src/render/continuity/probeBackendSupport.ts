/**
 * probeBackendSupport.ts
 *
 * What a real device can actually carry, asked of the device.
 *
 * `BackendSupport` has been the tier ladder's input since the ladder was
 * written, and until now nothing produced one. Every caller constructed the
 * struct by hand, which meant the ladder had never been driven by a measurement
 * in its life, and the difference between the two backends was documented in a
 * comment rather than read from hardware. This is the producer.
 *
 * The two conditions are genuinely different and the distinction decides a
 * rung, so it is worth stating precisely rather than collapsing.
 *
 * Keeping a history needs a persistent surface the renderer draws INTO whose
 * texels hold a full float, because the merge rule compares depths as a ratio
 * across scenes spanning metres to kilometres. That is an `r32float` colour
 * attachment. WebGPU renders to it unconditionally. WebGL 2 does not:
 * `EXT_color_buffer_float` is not core, and without it the framebuffer is
 * incomplete rather than slow, so the extension has to be asked for.
 *
 * Closing a gap needs only to READ neighbouring depths inside one frame, which
 * a depth texture serves. Depth textures are core in WebGL 2 and standard in
 * WebGPU, so this condition holds on both and a device that refuses the float
 * colour attachment still closes gaps. That is the whole reason `closure` sits
 * below `full` on the ladder instead of beside it.
 *
 * Pure with respect to the renderer: it takes a probe interface rather than a
 * three.js object, so the decision is unit-testable in Node and the adapter
 * that reaches a real context stays a few lines. Nothing here allocates.
 */
import { historyFits, CONSERVATIVE_LAYOUT, type HistoryLayout } from './historyBudget';
import type { BackendSupport } from './continuityTier';

/** What the probe needs from a live renderer. */
export interface DeviceProbe {
  readonly backend: 'webgpu' | 'webgl2';
  /**
   * Whether the context reports `EXT_color_buffer_float`.
   *
   * Only consulted on WebGL 2. A WebGPU probe may return anything and it is
   * ignored, because the format is renderable there without an extension and
   * asking would invent a condition the backend does not have.
   */
  colorBufferFloat(): boolean;
  /** The backing store, in device pixels. */
  backingStorePx(): { readonly widthPx: number; readonly heightPx: number };
}

/** Whether this backend can render into the history's float depth surface. */
export function historyTexturesAvailable(probe: DeviceProbe): boolean {
  if (probe.backend === 'webgpu') return true;
  try {
    return probe.colorBufferFloat() === true;
  } catch {
    // A context that throws on an extension query has not said yes.
    return false;
  }
}

/**
 * Whether a pass can read neighbouring depths.
 *
 * True on both backends. It is a function rather than a constant so the reason
 * is findable by name, and so a backend that ever fails it has somewhere to say
 * so instead of the caller hard-coding true.
 */
export function depthNeighbourhoodAvailable(probe: DeviceProbe): boolean {
  return probe.backend === 'webgpu' || probe.backend === 'webgl2';
}

/**
 * The ladder's input, measured.
 *
 * A probe that cannot report its backing store yields no fit rather than a
 * guessed one: an unknown size is not evidence that a history would fit, and
 * the ladder reads a false `historyFits` as a reason to drop a rung, which is
 * the safe direction.
 */
export function probeBackendSupport(
  probe: DeviceProbe,
  layout: HistoryLayout = CONSERVATIVE_LAYOUT,
): BackendSupport {
  let fits = false;
  try {
    const { widthPx, heightPx } = probe.backingStorePx();
    fits = historyFits(widthPx, heightPx, layout);
  } catch {
    fits = false;
  }
  return {
    historyTextures: historyTexturesAvailable(probe),
    historyFits: fits,
    depthNeighbourhood: depthNeighbourhoodAvailable(probe),
  };
}

/**
 * A probe over a live WebGL 2 context.
 *
 * `getExtension` returns an object or null, and a context that has been lost
 * throws on some implementations, which the caller above already absorbs.
 */
export function webgl2Probe(
  gl: { getExtension(name: string): unknown; drawingBufferWidth: number; drawingBufferHeight: number },
): DeviceProbe {
  return {
    backend: 'webgl2',
    colorBufferFloat: () => gl.getExtension('EXT_color_buffer_float') !== null,
    backingStorePx: () => ({ widthPx: gl.drawingBufferWidth, heightPx: gl.drawingBufferHeight }),
  };
}

/** A probe over a live WebGPU renderer, whose backing store the caller supplies. */
export function webgpuProbe(size: { widthPx: number; heightPx: number }): DeviceProbe {
  return {
    backend: 'webgpu',
    colorBufferFloat: () => true,
    backingStorePx: () => size,
  };
}
