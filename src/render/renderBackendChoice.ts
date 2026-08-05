/**
 * renderBackendChoice.ts
 *
 * One pure decision: which renderer backend to build — WebGPU or the WebGL 2
 * fallback — for a given `navigator.gpu`.
 *
 * WHY THIS EXISTS (the iOS / WebKit open crash). `THREE.WebGPURenderer` selects
 * its backend at CONSTRUCTION: unless `forceWebGL` is set it always builds the
 * WebGPU backend and only recovers to WebGL 2 if the WebGPU `init()` THROWS.
 * The trouble is that `navigator.gpu` being *present* is not the same as WebGPU
 * being *usable*. On WebKit (Brave / Safari on iOS) `navigator.gpu` can be a
 * truthy object while `navigator.gpu.requestAdapter()` resolves to `null` — no
 * adapter. Feeding that renderer into the streaming-open path then runs the
 * whole WebGPU init dance against an engine that has no adapter, and a null
 * adapter dereferenced anywhere on that path surfaces as WebKit's
 * "null is not an object" — the exact error the field report shows, and only on
 * WebKit because desktop Chromium returns a real adapter.
 *
 * So we make the choice OURSELVES, before construction: actually call
 * `requestAdapter()` and pick WebGL 2 when it yields nothing. Capable browsers
 * (a real adapter) still get WebGPU — this never disables it for them. Probing
 * is the only honest test; a presence check (`'gpu' in navigator`) is precisely
 * the check that fails on WebKit.
 *
 * Pure and DOM-free (takes the probe as an argument), so the null-adapter,
 * throwing-probe, and absent-`gpu` cases are all unit-tested in Node without a
 * real GPU. Mirrors the guard `defaultGpuBackendFactory` already applies on the
 * terrain-compute side, kept here as its own decision for the renderer.
 */

/** The two renderer backends the app can target. */
export type RenderBackendChoice = 'webgpu' | 'webgl2';

/** The one member of `navigator.gpu` this decision needs. */
export interface RenderAdapterProbe {
  requestAdapter(): Promise<unknown>;
}

/**
 * Choose the renderer backend by ACTUALLY requesting an adapter.
 *
 * Returns `'webgl2'` when WebGPU cannot produce an adapter — `gpu` absent, the
 * probe resolving `null`/`undefined` (WebKit's no-adapter case), or the probe
 * throwing — and `'webgpu'` only when a real adapter comes back. Never throws:
 * every failure mode collapses to the safe WebGL 2 fallback so a caller can
 * pass the result straight into `forceWebGL`.
 */
export async function chooseRenderBackend(
  gpu: RenderAdapterProbe | null | undefined,
): Promise<RenderBackendChoice> {
  if (!gpu || typeof gpu.requestAdapter !== 'function') return 'webgl2';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter == null ? 'webgl2' : 'webgpu';
  } catch {
    // A throwing `requestAdapter` (some WebKit builds, or a blocked GPU under a
    // privacy shield) is no more usable than a null adapter — fall back.
    return 'webgl2';
  }
}
