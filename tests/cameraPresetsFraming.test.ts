/**
 * cameraPresetsFraming.test.ts — standard views and named presets keep the
 * whole cloud on screen.
 *
 * Each pose is projected through a real three.js perspective camera, with the
 * camera's up set to the scene's world up as the viewer does, and every corner
 * of the bounds must land inside the screen-edge reserve. A thin diagonal
 * cloud is the case a bounding-sphere fit with a sub-1 pad crops.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_PRESET_ORDER,
  FRAME_EDGE_RESERVE,
  STANDARD_VIEW_ORDER,
  cameraPresetPose,
  presetInputForBounds,
  standardViewPose,
  type PresetInput,
  type PresetPose,
  type Vec3,
} from '../src/render/camera/cameraPresets';

const FOV = 60;
const LIMIT = 1 - FRAME_EDGE_RESERVE + 1e-9;

/** Largest |NDC| over `points` seen from `pose`. */
function maxNdc(pose: PresetPose, worldUp: Vec3, aspect: number, points: readonly Vec3[]): number {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.001, 1e6);
  cam.up.set(worldUp.x, worldUp.y, worldUp.z);
  cam.position.set(pose.position.x, pose.position.y, pose.position.z);
  cam.lookAt(pose.target.x, pose.target.y, pose.target.z);
  cam.updateMatrixWorld();
  let m = 0;
  for (const p of points) {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(cam);
    m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
  }
  return m;
}

function corners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    out.push({ x: i & 1 ? max.x : min.x, y: i & 2 ? max.y : min.y, z: i & 4 ? max.z : min.z });
  }
  return out;
}

describe('a thin diagonal cloud in the Front view', () => {
  // Two points whose AABB-derived sphere is centred at the origin with radius 1.
  const a = { x: 0.5, y: Math.sqrt(0.75), z: 0 };
  const b = { x: -0.5, y: -Math.sqrt(0.75), z: 0 };
  const input: PresetInput = {
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    worldUp: { x: 0, y: 0, z: 1 },
    horizontal: { x: 1, y: 0, z: 0 },
    fovDeg: FOV,
    boxMin: { x: -0.5, y: -Math.sqrt(0.75), z: 0 },
    boxMax: { x: 0.5, y: Math.sqrt(0.75), z: 0 },
    aspect: 1,
  };

  it('keeps both endpoints on screen, inside the edge reserve', () => {
    const pose = standardViewPose('front', input);
    expect(maxNdc(pose, input.worldUp, 1, [a, b])).toBeLessThanOrEqual(LIMIT);
  });
});

type Shape = { name: string; min: Vec3; max: Vec3 };

const SHAPES_Z: readonly Shape[] = [
  { name: 'thin diagonal', min: { x: -0.5, y: -0.866, z: 0 }, max: { x: 0.5, y: 0.866, z: 0 } },
  { name: 'volumetric', min: { x: 10, y: -4, z: 2 }, max: { x: 18, y: 5, z: 9 } },
  { name: 'tall and narrow', min: { x: -0.5, y: -0.5, z: 0 }, max: { x: 0.5, y: 0.5, z: 30 } },
  { name: 'long thin strip', min: { x: -200, y: -1, z: 0 }, max: { x: 200, y: 1, z: 0.5 } },
];

/** The same shapes with the up axis on y. */
const SHAPES_Y: readonly Shape[] = SHAPES_Z.map((s) => ({
  name: s.name,
  min: { x: s.min.x, y: s.min.z, z: s.min.y },
  max: { x: s.max.x, y: s.max.z, z: s.max.y },
}));

const AXES = [
  { label: 'Z up', up: { x: 0, y: 0, z: 1 }, horizontal: { x: 1, y: 0, z: 0 }, shapes: SHAPES_Z },
  { label: 'Y up', up: { x: 0, y: 1, z: 0 }, horizontal: { x: 1, y: 0, z: 0 }, shapes: SHAPES_Y },
] as const;

const ASPECTS = [
  { label: 'portrait 480x800', aspect: 480 / 800 },
  { label: 'square', aspect: 1 },
  { label: 'wide 1600x600', aspect: 1600 / 600 },
] as const;

describe('every standard view and preset contains the bounds', () => {
  for (const axis of AXES) {
    for (const shape of axis.shapes) {
      for (const { label, aspect } of ASPECTS) {
        const input = presetInputForBounds(shape, axis.up, axis.horizontal, { fovDeg: FOV, aspect });
        const pts = corners(shape.min, shape.max);
        it(`${axis.label}, ${shape.name}, ${label}`, () => {
          for (const view of STANDARD_VIEW_ORDER) {
            const ndc = maxNdc(standardViewPose(view, input), axis.up, aspect, pts);
            expect(ndc, `standard view ${view}`).toBeLessThanOrEqual(LIMIT);
          }
          for (const name of CAMERA_PRESET_ORDER) {
            const ndc = maxNdc(cameraPresetPose(name, input), axis.up, aspect, pts);
            expect(ndc, `preset ${name}`).toBeLessThanOrEqual(LIMIT);
          }
        });
      }
    }
  }
});

describe('the box fit keeps each pose direction', () => {
  it('looks from the same side as the sphere fit did', () => {
    const shape = SHAPES_Z[1];
    const up = { x: 0, y: 0, z: 1 };
    const horizontal = { x: 1, y: 0, z: 0 };
    const boxed = presetInputForBounds(shape, up, horizontal, { fovDeg: FOV, aspect: 1.5 });
    const { boxMin: _min, boxMax: _max, ...sphereOnly } = boxed;
    const dirOf = (p: PresetPose): THREE.Vector3 =>
      new THREE.Vector3(p.position.x - p.target.x, p.position.y - p.target.y, p.position.z - p.target.z).normalize();
    for (const view of STANDARD_VIEW_ORDER) {
      const d = dirOf(standardViewPose(view, boxed)).dot(dirOf(standardViewPose(view, sphereOnly)));
      expect(d, view).toBeCloseTo(1, 9);
    }
    for (const name of CAMERA_PRESET_ORDER) {
      const d = dirOf(cameraPresetPose(name, boxed)).dot(dirOf(cameraPresetPose(name, sphereOnly)));
      expect(d, name).toBeCloseTo(1, 9);
    }
  });
});
