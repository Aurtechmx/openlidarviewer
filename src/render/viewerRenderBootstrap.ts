/**
 * viewerRenderBootstrap.ts
 *
 * The renderer, scene, cameras and post pipeline a Viewer starts from,
 * built in one place with the same settings the Viewer's constructor held:
 * a WebGPU renderer with the WebGL 2 fallback the caller chose, a
 * logarithmic depth buffer, no tone mapping at exposure 1 with sRGB output,
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
  perspectiveDepthToViewZ,
} from 'three/tsl';
import { EDL_DEFAULTS, EDL_DEPTH_BIAS } from './edl';
import { maxPixelRatio } from './quality/pixelRatioCeiling';
import { makeOrthoCamera } from './camera/orthoCamera';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_FOV, SCENE_BACKGROUND, effectivePixelRatio, resolveDrawingBuffer, usesLogDepthOf } from './renderBootstrapPolicy';
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

/** The device pixel ratio the renderer should run at right now. */
export function currentPixelRatio(): number {
  return effectivePixelRatio(typeof window !== 'undefined' ? window.devicePixelRatio : 1, maxPixelRatio());
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
    // A logarithmic depth buffer spreads precision across orders of magnitude,
    // so a 50 km tile and a 5 m room both render without z-fighting.
    logarithmicDepthBuffer: true,
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
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
  // colour and depth. The depth encoding is read back off the renderer so the
  // inversion matches what it wrote on either backend.
  const scenePass = pass(scene, camera);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = buildEdlOutputNode(
    scenePass,
    edl.strength,
    edl.near,
    edl.far,
    EDL_DEFAULTS.radiusPx,
    usesLogDepthOf(renderer as unknown as { logarithmicDepthBuffer?: boolean }),
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
 * @param usesLogDepth - Whether the renderer owns a logarithmic depth buffer,
 * read back off the renderer instance at construction. Decides which depth
 * inversion the node graph is built with (the graph is compiled once, and the
 * renderer's depth mode is fixed at construction, so a build-time branch is
 * correct, no per-pixel uniform needed).
 */
export function buildEdlOutputNode(
  scenePass: ReturnType<typeof pass>,
  strength: TslNode,
  near: TslNode,
  far: TslNode,
  radiusPx: number,
  usesLogDepth: boolean,
): TslNode {
  const colorNode: TslNode = scenePass.getTextureNode();
  const depthNode: TslNode = scenePass.getTextureNode('depth');

  // Positive eye-space distance at a screen UV, floored away from zero so the
  // following log2 is always finite.
  //
  // The inversion MUST match the encoding the renderer actually wrote:
  //
  //  • Logarithmic depth buffer (this app's default, see the renderer
  //    construction): three's node pipeline (`NodeMaterial.setupDepth` →
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
  //  • Standard perspective depth otherwise: three's own
  //    `perspectiveDepthToViewZ` (which internally also handles a reversed
  //    depth buffer) recovers viewZ; negate for a positive distance.
  //
  // Using the wrong inversion is not subtle: treating a log-encoded sample as
  // perspective depth computes obscurance in the wrong space, EDL reads far
  // too weak up close and erratic at range, silently defeating the
  // unit-tested maths in `edl.ts`. That was the v0.4.x audit defect.
  const eyeDistAt = Fn(([sampleUv]: TslNode[]): TslNode => {
    const raw: TslNode = depthNode.sample(sampleUv).r;
    if (usesLogDepth) {
      const nearClamped: TslNode = max(near, float(1e-6));
      const eyeDist: TslNode = nearClamped.mul(
        exp2(raw.mul(log2(far.div(nearClamped)))),
      );
      return max(eyeDist, float(1e-4));
    }
    return max(perspectiveDepthToViewZ(raw, near, far).negate(), float(1e-4));
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

