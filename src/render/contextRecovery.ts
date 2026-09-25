/**
 * contextRecovery.ts — redraw the scene after a WebGL context is restored.
 *
 * three.js r186's WebGPURenderer cannot come back from a lost WebGL context in
 * place. Its WebGL backend listens for `webglcontextlost` only; the renderer's
 * loss handler sets `_isDeviceLost`, which nothing ever clears, and every
 * render, compute and clear returns early on it. Its backend caches (buffers,
 * programs, VAOs, textures, the GL state mirror) still hold handles from the
 * dead context. So a restored context gets no draw calls at all.
 *
 * Recovery therefore builds a fresh renderer on the same canvas: the canvas
 * hands the new backend the restored context, and the new renderer has no GPU
 * data, so it uploads every geometry, texture and program from the CPU-side
 * objects the scene still holds. The scene, cameras, controls, measurements
 * and the EDL pass node are the same objects throughout; only the renderer
 * and the post pipeline that wraps it are replaced.
 *
 * The lost renderer is retired, never disposed. `WebGLBackend.dispose()` calls
 * `WEBGL_lose_context.loseContext()` on the shared context, which would kill
 * the context just restored, and its managers would delete handles the new
 * context does not own. Retiring stops its animation frame loop, drops the
 * dispose listeners it put on scene objects (so it does not stay reachable
 * through them) and removes its context-loss listener from the canvas.
 */
import type * as THREE from 'three/webgpu';
import type { DeviceGeneration } from './deviceGeneration';
import type { EdlUniforms, createViewerRenderCore } from './viewerRenderBootstrap';

/** The renderer and post pipeline a Viewer draws with. */
export interface RecoverableCore {
  readonly renderer: THREE.WebGPURenderer;
  readonly pipeline: THREE.RenderPipeline;
  /** A pass node the factory built beside them that recovery does not use. */
  readonly scenePass?: { dispose(): void };
}

export interface ContextRecoveryHost {
  /** The renderer that lost its context. */
  readonly renderer: THREE.WebGPURenderer;
  /** The pipeline wrapping it; its output node (the EDL graph) is kept. */
  readonly pipeline: THREE.RenderPipeline;
  readonly generation: DeviceGeneration;
  /** Build a fresh WebGL 2 core on the same canvas. */
  create(): RecoverableCore;
  /** Whether the owner was disposed while recovery was in flight. */
  disposed(): boolean;
  /** Swap the new renderer and pipeline in and draw a frame. */
  adopt(core: RecoverableCore): void;
}

/** Private three.js r186 internals retiring touches, each optional. */
interface RendererInternals {
  _animation?: { dispose(): void };
  _objects?: { _renderObjects?: Set<{ onDispose: () => void }>; dispose(): void };
  _geometries?: { dispose(): void };
  backend?: { _onContextLost?: EventListener };
  domElement?: EventTarget;
}

/**
 * Detach a renderer from the page without touching its GL context: stop its
 * frame loop, remove its listeners on scene objects and on the canvas.
 */
export function retireRenderer(renderer: THREE.WebGPURenderer): void {
  const r = renderer as unknown as RendererInternals;
  r._animation?.dispose();
  // RenderObject.dispose() removes its listeners and then calls onDispose,
  // which frees pipelines and bindings through the backend. Blank that first.
  for (const ro of r._objects?._renderObjects ?? []) ro.onDispose = () => {};
  r._objects?.dispose();
  r._geometries?.dispose();
  const onLost = r.backend?._onContextLost;
  if (onLost) r.domElement?.removeEventListener('webglcontextlost', onLost);
}

/** Copy the drawing-buffer and clear state the Viewer set on `from`. */
export function carryRendererState(from: THREE.WebGPURenderer, to: THREE.WebGPURenderer): void {
  to.setPixelRatio(from.getPixelRatio());
  // No runtime three import, so this chunk stays free of the vendor chunk:
  // getSize() fills its target through set(), getClearColor() returns what
  // its target's copy() returns, here a clone of the renderer's colour.
  let w = 0, h = 0;
  from.getSize({ set: (x: number, y: number) => { w = x; h = y; } } as unknown as THREE.Vector2);
  to.setSize(w, h, false);
  to.setClearColor(from.getClearColor({ copy: (c: THREE.Color) => c.clone() } as unknown as THREE.Color), from.getClearAlpha());
  const clip = (from as unknown as { localClippingEnabled?: boolean }).localClippingEnabled;
  (to as unknown as { localClippingEnabled?: boolean }).localClippingEnabled = clip === true;
}

/**
 * Replace the lost renderer with a fresh one. Resolves true when the new one
 * is drawing, false when recovery failed or was overtaken (another loss, or
 * the owner disposed) and the old state stands.
 */
export async function recoverRenderCore(host: ContextRecoveryHost): Promise<boolean> {
  const era = host.generation.current;
  let next: RecoverableCore;
  try {
    next = host.create();
    next.scenePass?.dispose();
    next.pipeline.outputNode = host.pipeline.outputNode;
    carryRendererState(host.renderer, next.renderer);
    await next.renderer.init();
  } catch (err) {
    console.error('OpenLiDARViewer: graphics context recovery failed', err);
    return false;
  }
  if (host.disposed() || host.generation.lost || host.generation.current !== era) {
    retireRenderer(next.renderer);
    return false;
  }
  retireRenderer(host.renderer);
  host.adopt({ renderer: next.renderer, pipeline: next.pipeline });
  return true;
}

/**
 * The Viewer fields recovery reads and replaces. They are private on the
 * class; the Viewer hands itself over so this wiring stays out of its chunk
 * (with its core factory, so this chunk does not pull the bootstrap along),
 * and `tests/contextRecovery.test.ts` pins the names against the class.
 */
export interface ViewerRecoverySurface {
  _renderer: THREE.WebGPURenderer;
  _post: THREE.RenderPipeline;
  readonly _canvas: HTMLCanvasElement;
  readonly _devices: DeviceGeneration;
  readonly _edlLiveStrength: EdlUniforms['strength'];
  readonly _edlNear: EdlUniforms['near'];
  readonly _edlFar: EdlUniforms['far'];
  readonly _detachContextLoss: (() => void) | null;
  _watchDevice(): void;
  requestFrame(): void;
}

/** Rebuild a Viewer's renderer on its own canvas after a context restore. */
export function recoverViewer(v: ViewerRecoverySurface, create: typeof createViewerRenderCore): Promise<boolean> {
  return recoverRenderCore({
    renderer: v._renderer,
    pipeline: v._post,
    generation: v._devices,
    disposed: () => v._detachContextLoss === null,
    create: () => create(v._canvas, true, { strength: v._edlLiveStrength, near: v._edlNear, far: v._edlFar }),
    adopt: (core) => {
      v._renderer = core.renderer;
      v._post = core.pipeline;
      v._detachContextLoss?.();
      v._watchDevice();
      v.requestFrame();
    },
  });
}
