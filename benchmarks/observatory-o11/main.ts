/**
 * main.ts: the O11 benchmark page. It builds a scenario's field once, then
 * measures one overlay arm per call, as validation/protocols/observatory-o11-v1.md
 * describes. Driven by scripts/bench-observatory-o11.mjs through
 * `window.__o11`; never part of the app build.
 */
import * as THREE from 'three/webgpu';
import { buildO11Scenarios } from '../../scripts/lib/observatoryO11Scenarios.mjs';
import { buildScenarioField, type DenseField } from './field';
import { createInstanceArm, createSliceArm, instanceCountOf, type OverlayArm } from './arms';

const WARMUP = 60;
const MEASURED = 600;
const FRAME_LIMIT_MS = 10_000;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(1280, 800, false);
const ready = renderer.init();
const fields = new Map<string, DenseField>();

async function gpuDone(): Promise<void> {
  const backend = (renderer as unknown as { backend: { device?: GPUDevice; gl?: WebGL2RenderingContext } }).backend;
  if (backend.device) { await backend.device.queue.onSubmittedWorkDone(); return; }
  if (backend.gl) backend.gl.readPixels(0, 0, 1, 1, backend.gl.RGBA, backend.gl.UNSIGNED_BYTE, new Uint8Array(4));
}

function backendName(): string {
  const backend = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
  return backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
}

function p95(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

async function prepare(id: string) {
  await ready;
  const scene = buildO11Scenarios().find((s) => s.id === id);
  if (!scene) throw new Error(`unknown scenario ${id}`);
  const field = buildScenarioField(scene);
  fields.set(id, field);
  return {
    id, grid: field.grid, voxelEdge: field.voxelEdge, returns: field.returns, notReadRays: field.notReadRays,
    buildMs: Math.round(field.buildMs), instances: instanceCountOf(field), backend: backendName(),
  };
}

async function measure(id: string, arm: 'slicing' | 'instancing') {
  const field = fields.get(id);
  if (!field) throw new Error(`prepare ${id} first`);
  const { nx, ny, nz } = field.grid;
  const h = field.voxelEdge;
  const centre = new THREE.Vector3((nx * h) / 2, (ny * h) / 2, (nz * h) / 2);
  const radius = 1.2 * Math.hypot(nx * h, ny * h, nz * h) / 2;
  const camera = new THREE.PerspectiveCamera(50, 1280 / 800, radius / 1000, radius * 10);
  camera.up.set(0, 0, 1);
  const scene = new THREE.Scene();
  let overlay: OverlayArm;
  try {
    overlay = arm === 'slicing' ? createSliceArm(field) : createInstanceArm(field);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  scene.add(overlay.object);
  const times: number[] = [];
  const elev = Math.PI / 6;
  try {
    for (let f = 0; f < WARMUP + MEASURED; f++) {
      const az = (f / (WARMUP + MEASURED)) * Math.PI * 2;
      camera.position.set(centre.x + radius * Math.cos(elev) * Math.cos(az), centre.y + radius * Math.cos(elev) * Math.sin(az), centre.z + radius * Math.sin(elev));
      camera.lookAt(centre);
      if (f === WARMUP) overlay.startCounting();
      overlay.frame(f);
      const t0 = performance.now();
      renderer.render(scene, camera);
      await gpuDone();
      const dt = performance.now() - t0;
      if (dt > FRAME_LIMIT_MS) throw new Error(`frame ${f} took ${Math.round(dt)} ms`);
      if (f >= WARMUP) times.push(dt);
    }
  } catch (e) {
    overlay.dispose();
    return { ok: false, error: String(e) };
  }
  const bytes = overlay.uploadBytes();
  scene.remove(overlay.object);
  overlay.dispose();
  return { ok: true, p95Ms: p95(times), medianMs: [...times].sort((a, b) => a - b)[times.length >> 1], uploadBytes: bytes, frames: times.length };
}

(window as unknown as { __o11: unknown }).__o11 = { prepare, measure, userAgent: navigator.userAgent };
document.getElementById('log')!.textContent = 'ready';
