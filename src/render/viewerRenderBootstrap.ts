/**
 * viewerRenderBootstrap.ts
 *
 * The renderer, scene, cameras and post pipeline a Viewer starts from,
 * built in one place with the same settings the Viewer's constructor held:
 * a WebGPU renderer with the WebGL 2 fallback the caller chose, a
 * reversed (or logarithmic) depth buffer, no tone mapping at exposure 1 with sRGB output,
 * the Deep Navy background, the perspective camera with its orthographic
 * twin, and the Eye Dome Lighting pipeline keyed on the depth encoding the
 * renderer actually owns. The Viewer keeps every field this returns; nothing
 * here reaches back into it. The pure sizing and ratio decisions live in
 * `renderBootstrapPolicy.ts`.
 */
import * as THREE from 'three/webgpu';
import {
  pass,
  Fn,
  vec2,
  vec4,
  float,
  screenUV,
  screenSize,
  log2,
  exp,
  exp2,
  max,
  orthographicDepthToViewZ,
  perspectiveDepthToViewZ,
  select,
  uniform,
} from 'three/tsl';
import { EDL_DEFAULTS, EDL_DEPTH_BIAS } from './edl';
import { maxPixelRatio } from './quality/pixelRatioCeiling';
import { makeOrthoCamera } from './camera/orthoCamera';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_FOV, SCENE_BACKGROUND, depthOptionsFor, effectivePixelRatio, resolveDrawingBuffer, settleDepthMode, usesLogDepthOf } from './renderBootstrapPolicy';
// The page-level backend choice rides the Viewer chunk with the renderer it picks.
export { chooseRenderBackendForPage } from './renderBackendChoice';

export { DEFAULT_FOV } from './renderBootstrapPolicy';

/** A TSL node value; the node types are structural and untyped upstream. */
type TslNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The uniforms the EDL node reads live values from; the Viewer owns them. */
export interface EdlUniforms {
  readonly strength: TslNode;
  readonly near: TslNode;
  readonly far: TslNode;
}

export interface ViewerRenderCore {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  readonly scenePass: ReturnType<typeof pass>;
  readonly pipeline: THREE.RenderPipeline;
}

const releasedCores = new WeakSet<object>();

/**
 * Release what a render core owns: the post pipeline's targets, the scene
 * pass, then the renderer. Runs once per renderer; a second call is a no-op.
 * The scene and cameras hold no GPU resources of their own here.
 */
export function disposeViewerRenderCore(core: Pick<ViewerRenderCore, 'renderer' | 'pipeline' | 'scenePass'>): void {
  if (releasedCores.has(core.renderer)) return;
  releasedCores.add(core.renderer);
  core.pipeline.dispose();
  core.scenePass.dispose();
  core.renderer.dispose();
}

/** The device pixel ratio the renderer should run at right now. */
export function currentPixelRatio(): number {
  return effectivePixelRatio(typeof window !== 'undefined' ? window.devicePixelRatio : 1, maxPixelRatio());
}

/** Whether this browser's WebGL 2 offers EXT_clip_control, asked of a throwaway context. */
function webglHasClipControl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const has = gl.getExtension('EXT_clip_control') !== null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return has;
  } catch {
    return false;
  }
}

/**
 * Build the render core for `canvas`. `forceWebGL` is the backend the caller
 * already decided (WebGL 2 when the adapter probe found no WebGPU adapter).
 */
export function createViewerRenderCore(canvas: HTMLCanvasElement, forceWebGL: boolean, edl: EdlUniforms): ViewerRenderCore {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    forceWebGL,
    antialias: true,
    alpha: false,
    // Reversed float depth, or the logarithmic buffer where the WebGL 2
    // fallback cannot reverse (renderBootstrapPolicy.depthOptionsFor). Either
    // lets a 50 km tile and a 5 m room render without z-fighting.
    ...depthOptionsFor(forceWebGL, forceWebGL && webglHasClipControl()),
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
  // Every caller awaits init() before the first render; settle the depth mode
  // there, so a renderer that lost reversed depth inside three.js never draws
  // with a plain 24-bit buffer.
  const init = renderer.init.bind(renderer);
  renderer.init = async () => {
    const out = await init();
    settleDepthMode(renderer as unknown as { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean });
    return out;
  };
  renderer.setPixelRatio(currentPixelRatio());
  // updateStyle=false: the stylesheet owns the canvas display size; only the
  // drawing buffer is sized here, so the canvas keeps tracking its container
  // under browser zoom.
  const buffer = resolveDrawingBuffer(canvas.clientWidth, canvas.clientHeight);
  renderer.setSize(buffer.width, buffer.height, false);
  // Scanner-captured RGB passes straight through: no tone mapping, exposure 1,
  // sRGB output so PNG exports match the screen.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Each object's model-view matrix is formed on the CPU in float64 and
  // uploaded as one uniform, instead of multiplying the camera and model
  // matrices in the vertex shader. A mounted layer carries its offset to the
  // project frame in its mesh position, and on the GPU path both translations
  // are rounded to float32 before they cancel, which displaces the far layer
  // by millimetres at 20 km and decimetres at 1000 km. Every material here
  // reaches view space through three's `modelViewMatrix` accessor, which this
  // switches on the WebGPU backend and the WebGL 2 fallback alike. It must be
  // set before the first render: the flag is read when a material compiles.
  renderer.highPrecision = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BACKGROUND);

  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, buffer.aspect, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 0, 100);
  const orthoCamera = makeOrthoCamera(camera.near, camera.far);

  // The scene renders into a pass; the EDL node shades it from the pass's
  // colour and depth. The depth encoding is read off the renderer when the
  // shader is built, after init() has settled it, so the inversion matches
  // what the renderer writes on either backend.
  const scenePass = pass(scene, camera);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = buildEdlOutputNode(
    scenePass,
    edl.strength,
    edl.near,
    edl.far,
    EDL_DEFAULTS.radiusPx,
  ) as typeof pipeline.outputNode;
  return { renderer, scene, camera, orthoCamera, scenePass, pipeline };
}

/**
 * Build the Eye Dome Lighting output node for a scene pass.
 *
 * For each screen pixel it samples the pass colour, then compares the pixel's
 * eye-space depth against four neighbours on a ring of `radiusPx` pixels and
 * darkens the pixel in proportion to how far it recedes behind them. Works in
 * `log2(eye distance)` so the cue is scale-invariant. Mirrors `edlObscurance`
 * and `edlShade` in `edl.ts`, which are unit-tested.
 *
 * The depth inversion is chosen when the shader is built, from the renderer
 * the builder carries. The renderer settles its depth mode in init() (it
 * turns the logarithmic buffer off where reversed depth is active), which is
 * after this graph is assembled and before it is compiled, so reading the
 * mode any earlier can pick the wrong inversion.
 */
export function buildEdlOutputNode(
  scenePass: ReturnType<typeof pass>,
  strength: TslNode,
  near: TslNode,
  far: TslNode,
  radiusPx: number,
): TslNode {
  const colorNode: TslNode = scenePass.getTextureNode();
  const depthNode: TslNode = scenePass.getTextureNode('depth');

  // Positive eye-space distance at a screen UV, floored away from zero so the
  // following log2 is always finite.
  //
  // The inversion MUST match the encoding the renderer actually wrote:
  //
  //  • Logarithmic depth buffer, perspective camera (the WebGL 2 fallback
  //    without EXT_clip_control): three's node pipeline (`NodeMaterial.setupDepth` →
  //    `viewZToLogarithmicDepth`) replaces fragment depth with the Ulrich
  //    near-anchored log encoding
  //        raw = log2(eyeDist / near') / log2(far / near'),
  //        near' = max(near, 1e-6),
  //    so the eye distance is recovered with
  //        eyeDist = near' · 2^(raw · log2(far / near')).
  //    This mirrors `logDepthToEyeDistance` in `edl.ts` (unit-tested) exactly,
  //    including the 1e-6 near clamp. Both the WebGPU backend and the WebGL 2
  //    fallback compile this same node graph, so one inversion covers both.
  //    (Deliberately NOT the legacy WebGLRenderer chunk
  //    `log2(1 + w) / log2(1 + far)`, that convention never runs here.)
  //
  //  • Perspective depth otherwise, reversed on every backend that can: three's
  //    `perspectiveDepthToViewZ` picks the reversed formula itself and recovers
  //    viewZ; negate for a positive distance. `perspectiveDepthToEyeDistance`
  //    in `edl.ts` is its tested twin.
  //
  //  • Orthographic camera, in every mode: depth is linear between near and far
  //    (three writes it so even with the logarithmic buffer), recovered by
  //    `orthographicDepthToViewZ`; `orthographicDepthToEyeDistance` is its twin.
  //
  // Using the wrong inversion is not subtle: treating a log-encoded sample as
  // perspective depth computes obscurance in the wrong space, EDL reads far
  // too weak up close and erratic at range, silently defeating the
  // unit-tested maths in `edl.ts`. That was the v0.4.x audit defect.
  // Asked of the pass's camera per render: the app swaps that camera when the
  // projection changes, and the compiled shader stays.
  const orthographic: TslNode = uniform(0).onRenderUpdate(() =>
    ((scenePass as unknown as { camera: THREE.Camera }).camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0);
  const eyeDistAt = Fn(([sampleUv]: TslNode[], builder: { renderer: { logarithmicDepthBuffer?: boolean } }): TslNode => {
    const raw: TslNode = depthNode.sample(sampleUv).r;
    const ortho: TslNode = orthographicDepthToViewZ(raw, near, far).negate();
    let persp: TslNode;
    if (usesLogDepthOf(builder.renderer)) {
      const nearClamped: TslNode = max(near, float(1e-6));
      persp = nearClamped.mul(exp2(raw.mul(log2(far.div(nearClamped)))));
    } else {
      persp = perspectiveDepthToViewZ(raw, near, far).negate();
    }
    return max(select(orthographic.greaterThan(0.5), ortho, persp), float(1e-4));
  });

  return Fn((): TslNode => {
    const texel: TslNode = vec2(radiusPx, radiusPx).div(screenSize);
    const logC: TslNode = log2(eyeDistAt(screenUV));
    // A neighbour contributes only when it is deeper by more than the bias ,
    // gating depth-buffer noise so EDL does not shimmer as the camera moves.
    const bias: TslNode = float(EDL_DEPTH_BIAS);
    const sum: TslNode = float(0).toVar();
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.add(vec2(texel.x, 0))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.sub(vec2(texel.x, 0))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.add(vec2(0, texel.y))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.sub(vec2(0, texel.y))))).sub(bias)));
    const shade: TslNode = exp(sum.mul(strength).negate());
    return vec4(colorNode.rgb.mul(shade), colorNode.a);
  })();
}

