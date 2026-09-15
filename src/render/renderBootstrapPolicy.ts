/**
 * renderBootstrapPolicy.ts
 *
 * The decisions the renderer bootstrap makes that need no GPU: the drawing
 * buffer size a canvas resolves to before layout has run, the device pixel
 * ratio after the ceiling, the camera's clip range, the scene background, and
 * whether a renderer wrote a logarithmic depth buffer. Pure and Node-tested;
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
