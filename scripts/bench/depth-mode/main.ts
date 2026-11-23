/**
 * main.ts: the depth-mode benchmark page. One page load is one arm: the depth
 * mode and the backend are renderer construction options, read from the URL
 * (?depth=log|reversed|standard&backend=webgpu|webgl2). Driven by
 * scripts/bench-depth-mode.mjs through `window.__depth`; never part of the
 * app build.
 *
 * The points are drawn the way the viewer draws them (src/render/Viewer.ts
 * buildPointMesh): instanced quads through PointsNodeMaterial, fixed pixel
 * size, MSAA, and for round points an alpha-tested disc with alpha to
 * coverage. Near and far planes are the viewer's (0.1 m and 5000 km).
 */
import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, positionGeometry, smoothstep } from 'three/tsl';

const W = 1280;
const H = 800;
const NEAR = 0.1;
const FAR = 5_000_000;
const WARMUP = 40;
const MEASURED = 200;
const POINTS = 3_000_000;

const params = new URLSearchParams(location.search);
const depth = (params.get('depth') ?? 'log') as 'log' | 'reversed' | 'standard';
const forceWebGL = params.get('backend') === 'webgl2';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGPURenderer({
  canvas,
  forceWebGL,
  antialias: true,
  alpha: false,
  logarithmicDepthBuffer: depth === 'log',
  reversedDepthBuffer: depth === 'reversed',
} as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.highPrecision = true;
renderer.sortObjects = false;
const ready = renderer.init();

type AnyRenderer = { backend: { device?: GPUDevice; gl?: WebGL2RenderingContext; isWebGPUBackend?: boolean }; logarithmicDepthBuffer?: boolean; reversedDepthBuffer?: boolean };
const r = renderer as unknown as AnyRenderer;

async function gpuDone(): Promise<void> {
  if (r.backend.device) { await r.backend.device.queue.onSubmittedWorkDone(); return; }
  if (r.backend.gl) r.backend.gl.readPixels(0, 0, 1, 1, r.backend.gl.RGBA, r.backend.gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** A small deterministic generator, so every arm draws the same points. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scenario = 'sheets-front-first' | 'sheets-back-first' | 'terrain';

/**
 * sheets: 30 screen-filling sheets of points between 50 m and 80 m, drawn
 * nearest first (the case early depth rejection helps most) or farthest first
 * (the case it cannot help). terrain: one rolling surface seen at a low angle,
 * points in random order, as a streamed scan arrives.
 */
function positionsFor(scenario: Scenario): Float32Array {
  const out = new Float32Array(POINTS * 3);
  const rand = rng(12345);
  if (scenario === 'terrain') {
    for (let i = 0; i < POINTS; i++) {
      const x = (rand() - 0.5) * 400;
      const z = -rand() * 600;
      out[i * 3] = x;
      out[i * 3 + 1] = -6 + 3 * Math.sin(x * 0.05) * Math.cos(z * 0.04) + 1.5 * Math.sin(z * 0.11);
      out[i * 3 + 2] = z;
    }
    return out;
  }
  const sheets = 30;
  const per = POINTS / sheets;
  const halfFov = Math.tan((50 * Math.PI) / 360);
  for (let s = 0; s < sheets; s++) {
    const order = scenario === 'sheets-front-first' ? s : sheets - 1 - s;
    const d = 50 + order;
    const hh = d * halfFov;
    const hw = hh * (W / H);
    for (let i = 0; i < per; i++) {
      const k = (s * per + i) * 3;
      out[k] = (rand() * 2 - 1) * hw;
      out[k + 1] = (rand() * 2 - 1) * hh;
      out[k + 2] = -d;
    }
  }
  return out;
}

const QUAD_CORNERS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
type TslNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function pointMesh(positions: Float32Array, round: boolean, sizePx: number): THREE.Mesh {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_CORNERS, 3));
  geometry.setIndex(QUAD_INDEX);
  geometry.instanceCount = positions.length / 3;
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < colors.length; i += 3) {
    const t = (i / colors.length);
    colors[i] = 0.3 + 0.7 * t; colors[i + 1] = 0.8 - 0.5 * t; colors[i + 2] = 0.4;
  }
  const material = new THREE.PointsNodeMaterial();
  material.positionNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(positions, 3)) as TslNode;
  material.colorNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(colors, 3)) as TslNode;
  material.size = sizePx;
  material.sizeAttenuation = false;
  material.transparent = false;
  if (round) {
    // The viewer's round mask: a soft disc gated by alphaTest, with alpha to coverage.
    const rr: TslNode = length((positionGeometry as TslNode).xy);
    material.opacityNode = smoothstep(float(0.30), float(0.50), rr).oneMinus() as typeof material.opacityNode;
    material.alphaTest = 0.18;
    material.alphaToCoverage = true;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, W / H, NEAR, FAR);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  return cam;
}

async function info() {
  await ready;
  return {
    backend: r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    requested: depth,
    logarithmicDepthBuffer: r.logarithmicDepthBuffer === true,
    reversedDepthBuffer: r.reversedDepthBuffer === true,
    userAgent: navigator.userAgent,
  };
}

/** Median and p95 frame time of one scenario, GPU work included. */
async function measure(scenario: Scenario, round: boolean, sizePx: number) {
  await ready;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  const mesh = pointMesh(positionsFor(scenario), round, sizePx);
  scene.add(mesh);
  const cam = camera();
  const times: number[] = [];
  try {
    for (let f = 0; f < WARMUP + MEASURED; f++) {
      // A slow yaw of two degrees either way: the image changes every frame
      // and the sheets keep their order.
      cam.rotation.y = 0.035 * Math.sin((f / MEASURED) * Math.PI * 2);
      cam.updateMatrixWorld();
      const t0 = performance.now();
      renderer.render(scene, cam);
      await gpuDone();
      const dt = performance.now() - t0;
      if (f >= WARMUP) times.push(dt);
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  return { ok: true, times };
}

/**
 * The smallest gap the depth buffer resolves at distance d: a red wall is
 * drawn first at d, then a green wall behind it at d + gap. The green wall is
 * farther, so it must fail the depth test; if the two depths are stored as
 * one value it passes (the test is less-or-equal) and the pixel turns green.
 * Returns the smallest gap/d of the ladder that stays red, or null when none
 * does.
 */
async function resolvedGap(d: number) {
  await ready;
  const target = new THREE.RenderTarget(16, 16, { depthBuffer: true, samples: 1 });
  const cam = camera();
  const wall = (color: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicNodeMaterial({ color }));
    m.scale.set(z, z, 1);
    m.position.set(0, 0, -z);
    return m;
  };
  const ladder = [1e-3, 3e-4, 1e-4, 3e-5, 1e-5, 3e-6, 1e-6, 3e-7, 1e-7, 3e-8];
  let best: number | null = null;
  for (const rel of ladder) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const far = wall(0x00ff00, d * (1 + rel));
    const near = wall(0xff0000, d);
    scene.add(near, far);
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(target, 8, 8, 1, 1);
    for (const m of [far, near]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    if (px[0] > 128 && px[1] < 128) best = rel; else break;
  }
  target.dispose();
  return { d, resolvedRelativeGap: best };
}

(window as unknown as { __depth: unknown }).__depth = { info, measure, resolvedGap };
const log = document.getElementById('log')!;
void ready.then(() => { log.textContent = 'ready'; }, (e: unknown) => { log.textContent = `error: ${String(e)}`; });
