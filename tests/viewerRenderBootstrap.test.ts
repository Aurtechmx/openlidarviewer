/**
 * viewerRenderBootstrap.test.ts
 *
 * The render core forms every model-view matrix on the CPU in float64.
 *
 * With three's `highPrecision` off, the vertex shader multiplies the camera's
 * view matrix by the object's world matrix after both were rounded to float32.
 * A layer mounted far from the project origin carries that offset in its mesh
 * position, so the two large translations cancel in float32 and the layer is
 * drawn millimetres to decimetres from where it is. These tests build the
 * renderer the Viewer builds, on both backends, and compile a point material
 * configured the way the Viewer configures one. Neither needs a GPU device:
 * the renderer is constructed but never initialised, and the node builder
 * emits shader source without one.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform } from 'three/tsl';
import { createViewerRenderCore } from '../src/render/viewerRenderBootstrap';

/** A canvas stand-in: the render core reads its box and sizes its buffer. */
function fakeCanvas(): HTMLCanvasElement {
  return {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext() { return null; },
  } as unknown as HTMLCanvasElement;
}

function buildCore(forceWebGL: boolean) {
  return createViewerRenderCore(fakeCanvas(), forceWebGL, {
    strength: uniform(1),
    near: uniform(0.1),
    far: uniform(1000),
  });
}

/**
 * The vertex shader three would compile for an instanced point quad, built
 * the way `Viewer.buildPointMesh` builds one: a `PointsNodeMaterial` on a
 * `Mesh`, with the per-point centre as an instanced position node.
 */
function pointVertexShader(core: ReturnType<typeof buildCore>): string {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const centres = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 9, 9, 9]), 3);
  geometry.instanceCount = 2;
  const material = new THREE.PointsNodeMaterial();
  material.positionNode = instancedBufferAttribute(centres) as typeof material.positionNode;
  material.sizeAttenuation = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(1_000_000, 0, 0);
  core.scene.add(mesh);
  // The backend's node builder is what `NodeManager` uses for a real render
  // object; the four fields below are the ones it sets before building.
  const backend = core.renderer.backend as unknown as {
    createNodeBuilder(object: THREE.Object3D, renderer: THREE.WebGPURenderer): {
      scene: THREE.Scene;
      material: THREE.Material;
      camera: THREE.Camera;
      context: Record<string, unknown>;
      build(): void;
      vertexShader: string;
    };
  };
  const builder = backend.createNodeBuilder(mesh, core.renderer);
  builder.scene = core.scene;
  builder.material = material;
  builder.camera = core.camera;
  builder.context.material = material;
  builder.build();
  return builder.vertexShader;
}

/** Column-major 4x4 product in float64, the reference both paths are held to. */
function mul64(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** The same product with every step rounded to float32, as a vertex shader forms it. */
function mul32(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const f = Math.fround;
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s = f(s + f(a[k * 4 + r] * b[c * 4 + k]));
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** A point through a model-view matrix, in float32 (the shader) or float64. */
function transform(m: ArrayLike<number>, p: readonly number[], f32: boolean): number[] {
  const f = f32 ? Math.fround : (x: number) => x;
  return [0, 1, 2].map((r) => f(f(f(f(m[r] * p[0]) + f(m[4 + r] * p[1])) + f(m[8 + r] * p[2])) + m[12 + r]));
}

/**
 * The worst view-space displacement, in metres, of a ten-point tile placed
 * `offset` metres east of the project origin, seen from twelve directions at
 * 32 m. The tile, the Z-up camera and the poses are the ones the browser
 * measurement used (`gate2-origin-b.las`, points (i, i, 6i) about its origin).
 *
 * `path` is how the uploaded matrices reach the vertex stage: `gpu` multiplies
 * the float32 camera view and world matrices in the shader, `cpu` uploads the
 * float32 rounding of their float64 product, which is what three computes per
 * object when `highPrecision` is on.
 */
function worstDisplacement(path: 'cpu' | 'gpu', offset: number): number {
  const points = Array.from({ length: 10 }, (_, i) => [i, i, 6 * i]);
  const mesh = new THREE.Object3D();
  mesh.position.set(offset, 0, 0);
  mesh.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera();
  camera.up.set(0, 0, 1);
  const [cx, cy, cz] = [offset + 4.5, 4.5, 27];
  let worst = 0;
  for (let k = 0; k < 12; k++) {
    const az = ((k * 30 + 7) * Math.PI) / 180;
    const el = (35 * Math.PI) / 180;
    camera.position.set(cx + 32 * Math.cos(el) * Math.cos(az), cy + 32 * Math.cos(el) * Math.sin(az), cz + 32 * Math.sin(el));
    camera.lookAt(cx, cy, cz);
    camera.updateMatrixWorld(true);
    const view = camera.matrixWorldInverse.elements;
    const world = mesh.matrixWorld.elements;
    const uploaded = path === 'cpu'
      ? new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).elements.map(Math.fround)
      : mul32(view.map(Math.fround), world.map(Math.fround));
    const exact = mul64(view, world);
    for (const p of points) {
      const a = transform(uploaded, p, true);
      const e = transform(exact, p, false);
      worst = Math.max(worst, Math.hypot(a[0] - e[0], a[1] - e[1], a[2] - e[2]));
    }
  }
  return worst;
}

describe('viewer render core precision', () => {
  it.each([
    ['WebGPU', false],
    ['WebGL 2', true],
  ])('turns high precision on for the %s backend', (_name, forceWebGL) => {
    const core = buildCore(forceWebGL);
    expect(core.renderer.highPrecision).toBe(true);
  });

  it.each([
    ['WebGPU', false],
    ['WebGL 2', true],
  ])('compiles the %s point vertex stage against a CPU-formed model-view uniform', (_name, forceWebGL) => {
    const vertex = pointVertexShader(buildCore(forceWebGL));
    // The CPU-formed matrix arrives as one uniform and is used as it is.
    expect(vertex).toMatch(/modelViewMatrix = highpModelViewMatrix;/);
    // No stage multiplies the float32 camera view matrix by the world matrix.
    expect(vertex).not.toMatch(/cameraViewMatrix\s*\*/);
  });

  it('keeps a far layer within 5 micrometres of where it is, at any offset', () => {
    // The path is read off the shader the render core compiles, so this
    // follows the renderer rather than restating the flag.
    const vertex = pointVertexShader(buildCore(false));
    const path = /cameraViewMatrix\s*\*/.test(vertex) ? 'gpu' : 'cpu';
    const unplaced = worstDisplacement(path, 0);
    for (const offset of [20_000, 100_000, 1_000_000]) {
      const d = worstDisplacement(path, offset);
      expect(d, `${offset} m`).toBeLessThan(5e-6);
      expect(Math.abs(d - unplaced), `${offset} m against unplaced`).toBeLessThan(1e-10);
    }
  });

  it('reproduces the float32 displacements measured in the browser', () => {
    // Chromium, Firefox and WebKit returned these to the last digit, from the
    // uniforms the renderer uploaded. The GPU path is the one three uses with
    // `highPrecision` off, kept here as the size of what it costs.
    const measured: Array<[number, number, number]> = [
      [20_000, 1.214453704046025e-3, 4.03333144955579e-6],
      [100_000, 5.185639100344751e-3, 4.033331364468038e-6],
      [1_000_000, 6.466293771321338e-2, 4.033344395401406e-6],
    ];
    for (const [offset, gpu, cpu] of measured) {
      expect(worstDisplacement('gpu', offset)).toBeCloseTo(gpu, 12);
      expect(worstDisplacement('cpu', offset)).toBeCloseTo(cpu, 12);
    }
  });
});
