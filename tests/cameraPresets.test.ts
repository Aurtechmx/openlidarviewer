/**
 * cameraPresets.test.ts
 *
 * Contract tests for the v0.3.9 Smart camera presets pure-data
 * module. The presets must be deterministic, geometrically sensible
 * (camera distance proportional to radius, target on the centroid,
 * direction matching the named pose), and stable across input
 * scalings.
 */

import { describe, it, expect } from 'vitest';
import {
  cameraPresetPose,
  standardViewPose,
  STANDARD_VIEW_ORDER,
  STANDARD_VIEW_LABEL,
  CAMERA_PRESET_KEY,
  CAMERA_PRESET_LABEL,
  CAMERA_PRESET_ORDER,
  type CameraPresetName,
  type StandardView,
  type PresetInput,
} from '../src/render/camera/cameraPresets';

const baseInput: PresetInput = {
  center: { x: 0, y: 0, z: 0 },
  radius: 10,
  worldUp: { x: 0, y: 0, z: 1 },
  horizontal: { x: 1, y: 0, z: 0 },
  fovDeg: 50,
};

function len(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function sub(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

describe('camera preset registry', () => {
  it('ships exactly four preset names in stable order', () => {
    expect(CAMERA_PRESET_ORDER).toEqual(['top', 'iso', 'oblique', 'planar']);
  });

  it('every preset has a label; keys are single letters or deliberately empty', () => {
    for (const name of CAMERA_PRESET_ORDER) {
      expect(CAMERA_PRESET_LABEL[name]).toBeTruthy();
      // Iso deliberately has NO key: bare `I` belongs to the Inspect tool
      // (v0.4.4 collision fix). Empty string = "no chip, no binding".
      if (name === 'iso') {
        expect(CAMERA_PRESET_KEY[name]).toBe('');
      } else {
        expect(CAMERA_PRESET_KEY[name]).toMatch(/^[A-Z]$/);
      }
    }
  });

  it('non-empty keyboard shortcuts are unique and never reuse the Inspect key', () => {
    const keys = CAMERA_PRESET_ORDER.map((n) => CAMERA_PRESET_KEY[n]).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('I');
  });
});

describe('degenerate (zero-radius) bounding sphere stays finite', () => {
  // A cloud whose points are all at one location yields a zero-radius sphere.
  // The pose math must treat radius 0 as 1 (via fitDistance) so a standard view
  // or preset still produces a finite camera pose rather than collapsing onto
  // the point — the regression guard for the empty/degenerate-cloud framing path.
  const zero: PresetInput = { ...baseInput, radius: 0 };

  it.each(CAMERA_PRESET_ORDER)('preset %s yields finite position + target at radius 0', (name) => {
    const { position, target } = cameraPresetPose(name as CameraPresetName, zero);
    for (const v of [position.x, position.y, position.z, target.x, target.y, target.z]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // Camera is pulled back a real distance, not left sitting on the centroid.
    expect(len(sub(position, target))).toBeGreaterThan(0);
  });

  it.each(STANDARD_VIEW_ORDER)('standard view %s yields finite position + target at radius 0', (view) => {
    const { position, target } = standardViewPose(view as StandardView, zero);
    for (const v of [position.x, position.y, position.z, target.x, target.y, target.z]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(len(sub(position, target))).toBeGreaterThan(0);
  });
});

describe('cameraPresetPose — invariants every preset must satisfy', () => {
  const names: CameraPresetName[] = ['top', 'iso', 'oblique', 'planar'];

  it.each(names)('%s places target on the centroid', (name) => {
    const { target } = cameraPresetPose(name, baseInput);
    expect(target.x).toBeCloseTo(0, 6);
    expect(target.y).toBeCloseTo(0, 6);
    expect(target.z).toBeCloseTo(0, 6);
  });

  it.each(names)('%s places camera at a non-zero distance', (name) => {
    const { position, target } = cameraPresetPose(name, baseInput);
    const dist = len(sub(position, target));
    expect(dist).toBeGreaterThan(0);
  });

  it.each(names)('%s respects the FOV-fit distance formula', (name) => {
    const { position, target } = cameraPresetPose(name, baseInput);
    const dist = len(sub(position, target));
    // dist = r / sin(fov/2) * pad ; pad default 1.2
    const fovRad = (50 * Math.PI) / 180;
    const expected = (10 / Math.sin(fovRad / 2)) * 1.2;
    expect(dist).toBeCloseTo(expected, 5);
  });

  it.each(names)('%s scales distance linearly with the radius', (name) => {
    const a = cameraPresetPose(name, { ...baseInput, radius: 10 });
    const b = cameraPresetPose(name, { ...baseInput, radius: 25 });
    const distA = len(sub(a.position, a.target));
    const distB = len(sub(b.position, b.target));
    expect(distB / distA).toBeCloseTo(2.5, 5);
  });

  it.each(names)('%s honours the optional pad multiplier', (name) => {
    const tight = cameraPresetPose(name, { ...baseInput, pad: 1 });
    const loose = cameraPresetPose(name, { ...baseInput, pad: 2 });
    const distT = len(sub(tight.position, tight.target));
    const distL = len(sub(loose.position, loose.target));
    expect(distL / distT).toBeCloseTo(2, 5);
  });

  it.each(names)('%s is deterministic for repeated calls', (name) => {
    const a = cameraPresetPose(name, baseInput);
    const b = cameraPresetPose(name, baseInput);
    expect(a).toEqual(b);
  });
});

describe('Top preset — straight down', () => {
  it('positions the camera high above the centroid', () => {
    const { position } = cameraPresetPose('top', baseInput);
    // worldUp is +Z; the camera should be above the target.
    expect(position.z).toBeGreaterThan(0);
    // Above target means the dominant component of the displacement
    // is along worldUp.
    const upMag = Math.abs(position.z);
    const horizMag = Math.sqrt(position.x * position.x + position.y * position.y);
    expect(upMag).toBeGreaterThan(horizMag * 10);
  });

  it('avoids a pure-vertical gimbal-lock pose (tiny horizontal bias)', () => {
    const { position } = cameraPresetPose('top', baseInput);
    const horizMag = Math.sqrt(position.x * position.x + position.y * position.y);
    // 1° tilt at the configured distance — must be > 0 but small.
    expect(horizMag).toBeGreaterThan(0);
  });
});

describe('Iso preset — 35° elevation, 45° heading', () => {
  it('elevates the camera at the canonical iso angle', () => {
    const { position, target } = cameraPresetPose('iso', baseInput);
    const dir = sub(position, target);
    const dist = len(dir);
    // sin(elevation) = z-component / dist for a worldUp = +Z scene.
    const elev = Math.asin(dir.z / dist);
    const expected = Math.atan(1 / Math.sqrt(2)); // ≈ 0.6155 rad ≈ 35.264°
    expect(elev).toBeCloseTo(expected, 4);
  });

  it('rotates the heading 45° clockwise from the horizontal seed', () => {
    const { position, target } = cameraPresetPose('iso', baseInput);
    const dir = sub(position, target);
    // Horizontal projection of the direction.
    const horizDir = { x: dir.x, y: dir.y, z: 0 };
    const horizLen = len(horizDir);
    // Horizontal seed was (1, 0, 0) — 45° CW rotation (around +Z, the
    // worldUp) of (1, 0, 0) is (cos(-π/4), sin(-π/4), 0) = (√2/2, -√2/2, 0).
    expect(horizDir.x / horizLen).toBeCloseTo(Math.SQRT1_2, 4);
    expect(horizDir.y / horizLen).toBeCloseTo(-Math.SQRT1_2, 4);
  });
});

describe('Oblique preset — matches frameAll opening pose', () => {
  it('lifts the camera 0.61 rad toward worldUp', () => {
    const { position, target } = cameraPresetPose('oblique', baseInput);
    const dir = sub(position, target);
    const dist = len(dir);
    const elev = Math.asin(dir.z / dist);
    expect(elev).toBeCloseTo(0.61, 4);
  });

  it('preserves the horizontal seed direction', () => {
    const { position, target } = cameraPresetPose('oblique', baseInput);
    const dir = sub(position, target);
    // Horizontal projection should align with the seed (1, 0, 0)
    // since oblique does not rotate around the up axis.
    const horizDir = { x: dir.x, y: dir.y, z: 0 };
    const horizLen = len(horizDir);
    expect(horizDir.x / horizLen).toBeCloseTo(1, 4);
    expect(horizDir.y / horizLen).toBeCloseTo(0, 4);
  });
});

describe('Planar preset — true side elevation', () => {
  it('places the camera at zero elevation along the horizontal seed', () => {
    const { position, target } = cameraPresetPose('planar', baseInput);
    const dir = sub(position, target);
    // No vertical component along worldUp (+Z) — true side view.
    expect(dir.z).toBeCloseTo(0, 6);
    // Direction matches the horizontal seed.
    const dist = len(dir);
    expect(dir.x / dist).toBeCloseTo(1, 4);
    expect(dir.y / dist).toBeCloseTo(0, 4);
  });
});

describe('Origin + axis independence', () => {
  it('translates the position when the centroid translates', () => {
    const moved = cameraPresetPose('oblique', {
      ...baseInput,
      center: { x: 50, y: -30, z: 5 },
    });
    expect(moved.target).toEqual({ x: 50, y: -30, z: 5 });
    // The camera-to-target vector is unchanged by translation.
    const dir = sub(moved.position, moved.target);
    const dist = len(dir);
    const fovRad = (50 * Math.PI) / 180;
    const expected = (10 / Math.sin(fovRad / 2)) * 1.2;
    expect(dist).toBeCloseTo(expected, 5);
  });

  it('works with a Y-up scene (PLY default)', () => {
    const yUpInput: PresetInput = {
      ...baseInput,
      worldUp: { x: 0, y: 1, z: 0 },
      horizontal: { x: 1, y: 0, z: 0 },
    };
    const { position, target } = cameraPresetPose('top', yUpInput);
    const dir = sub(position, target);
    // Camera should be above the target along +Y now.
    expect(dir.y).toBeGreaterThan(0);
    const horizMag = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    expect(Math.abs(dir.y)).toBeGreaterThan(horizMag * 10);
  });
});

describe('standard views — six axis-aligned faces', () => {
  const views: StandardView[] = ['top', 'bottom', 'front', 'back', 'left', 'right'];

  it('ships exactly six views in stable order, each labelled', () => {
    expect(STANDARD_VIEW_ORDER).toEqual(views);
    for (const v of STANDARD_VIEW_ORDER) expect(STANDARD_VIEW_LABEL[v]).toBeTruthy();
  });

  it.each(views)('%s targets the centroid at the fit distance', (view) => {
    const { position, target } = standardViewPose(view, baseInput);
    expect(target).toEqual({ x: 0, y: 0, z: 0 });
    const dist = len(sub(position, target));
    const fovRad = (50 * Math.PI) / 180;
    expect(dist).toBeCloseTo((10 / Math.sin(fovRad / 2)) * 1.2, 5);
  });

  it('Top and Bottom look along ±worldUp (dominantly vertical)', () => {
    const top = standardViewPose('top', baseInput);
    const bottom = standardViewPose('bottom', baseInput);
    expect(top.position.z).toBeGreaterThan(0); // above
    expect(bottom.position.z).toBeLessThan(0); // below
    for (const p of [top.position, bottom.position]) {
      const horizMag = Math.sqrt(p.x * p.x + p.y * p.y);
      expect(Math.abs(p.z)).toBeGreaterThan(horizMag * 10);
    }
  });

  it('Front/Back and Left/Right are horizontal and mutually opposed', () => {
    const front = standardViewPose('front', baseInput);
    const back = standardViewPose('back', baseInput);
    const left = standardViewPose('left', baseInput);
    const right = standardViewPose('right', baseInput);
    // Horizontal: zero vertical component (worldUp = +Z).
    for (const p of [front.position, back.position, left.position, right.position]) {
      expect(p.z).toBeCloseTo(0, 6);
    }
    // Opposites point in opposite directions.
    expect(front.position.x).toBeCloseTo(-back.position.x, 5);
    expect(front.position.y).toBeCloseTo(-back.position.y, 5);
    expect(left.position.x).toBeCloseTo(-right.position.x, 5);
    expect(left.position.y).toBeCloseTo(-right.position.y, 5);
    // Front (seed +X) and Right (up×seed) are perpendicular headings.
    const dotFR = front.position.x * right.position.x + front.position.y * right.position.y;
    expect(dotFR).toBeCloseTo(0, 4);
  });

  it('is deterministic and radius-linear', () => {
    expect(standardViewPose('left', baseInput)).toEqual(standardViewPose('left', baseInput));
    const a = standardViewPose('right', { ...baseInput, radius: 10 });
    const b = standardViewPose('right', { ...baseInput, radius: 30 });
    expect(len(sub(b.position, b.target)) / len(sub(a.position, a.target))).toBeCloseTo(3, 5);
  });
});
