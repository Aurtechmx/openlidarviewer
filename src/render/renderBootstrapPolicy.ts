/**
 * renderBootstrapPolicy.ts
 *
 * The decisions the renderer bootstrap makes that need no GPU: the drawing
 * buffer size a canvas resolves to before layout has run, the device pixel
 * ratio after the ceiling, the camera's clip range, the scene background, and
 * which depth buffer a renderer gets (reversed, or logarithmic). Pure and Node-tested;
 * `viewerRenderBootstrap.ts` applies them to three.js.
 */

/** Fallback drawing-buffer size for a canvas that has not been laid out yet. */
export const FALLBACK_BUFFER = { width: 800, height: 600 } as const;
/** Perspective camera vertical field of view, degrees. */
export const DEFAULT_FOV = 60;
/** Perspective camera clip range: near enough for a room, far enough for a survey. */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 5_000_000;
/** Deep Navy, the brand background the EDL highlights sit on. */
export const SCENE_BACKGROUND = 0x070b16;

export interface DrawingBuffer {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
}

/** The drawing buffer for a canvas's client box, with the fallback for an unlaid-out canvas. */
export function resolveDrawingBuffer(clientWidth: number, clientHeight: number): DrawingBuffer {
  const width = clientWidth || FALLBACK_BUFFER.width;
  const height = clientHeight || FALLBACK_BUFFER.height;
  return { width, height, aspect: width / height };
}

/** The pixel ratio the renderer runs at: the device's, capped by the quality ceiling. */
export function effectivePixelRatio(devicePixelRatio: number | undefined, ceiling: number): number {
  return Math.min(devicePixelRatio || 1, ceiling);
}

/** Whether a renderer owns a logarithmic depth buffer, read off the instance rather than assumed. */
export function usesLogDepthOf(renderer: { logarithmicDepthBuffer?: boolean }): boolean {
  return renderer.logarithmicDepthBuffer === true;
}

/** The depth options a renderer is built with: exactly one of the two buffers. */
export interface DepthOptions {
  readonly reversedDepthBuffer: boolean;
  readonly logarithmicDepthBuffer: boolean;
}

/**
 * Reversed float depth where the backend can do it, the logarithmic buffer
 * elsewhere. WebGPU always can; the WebGL 2 fallback needs EXT_clip_control.
 * Both hold a 0.1 m near plane out to 5000 km. Reversed depth is the finer of
 * the two and keeps the GPU's early depth test, which the logarithmic buffer
 * loses by writing depth from the fragment shader: 1.2 to 2.9 times the frame
 * time on the point pass (validation/performance/depth-mode).
 */
export function depthOptionsFor(forceWebGL: boolean, webglClipControl: boolean): DepthOptions {
  const reversed = !forceWebGL || webglClipControl;
  return { reversedDepthBuffer: reversed, logarithmicDepthBuffer: !reversed };
}

/**
 * After init(): a renderer that asked for reversed depth and did not get it
 * (WebGPU failed inside three.js and its WebGL 2 fallback lacks
 * EXT_clip_control) would be left on a plain 24-bit buffer, which cannot
 * separate surfaces a metre apart at 1.5 km. Give it the logarithmic buffer.
 * Materials read the flag when they compile, so this must run before the
 * first render. Returns the mode in use.
 */
export function settleDepthMode(renderer: { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean }): 'reversed' | 'log' {
  if (renderer.reversedDepthBuffer === true) return 'reversed';
  renderer.logarithmicDepthBuffer = true;
  return 'log';
}
