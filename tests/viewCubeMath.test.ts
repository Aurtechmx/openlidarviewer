import { describe, test, expect } from 'vitest';
import {
  compassHeadingDeg,
  unwrapAngleDeg,
  stableHeadingDeg,
  NEAR_VERTICAL_HORIZONTAL_EPS,
} from '../src/render/viewCubeMath';

describe('compassHeadingDeg', () => {
  test('north / east / south / west', () => {
    expect(compassHeadingDeg(0, 1)).toBeCloseTo(0); // +North
    expect(compassHeadingDeg(1, 0)).toBeCloseTo(90); // +East
    expect(compassHeadingDeg(0, -1)).toBeCloseTo(180); // +South
    expect(compassHeadingDeg(-1, 0)).toBeCloseTo(270); // +West
  });
  test('always in [0,360)', () => {
    for (let e = -3; e <= 3; e++)
      for (let n = -3; n <= 3; n++) {
        const h = compassHeadingDeg(e, n);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(360);
      }
  });
  test('degenerate / non-finite input → 0', () => {
    expect(compassHeadingDeg(0, 0)).toBe(0);
    expect(compassHeadingDeg(NaN, 1)).toBe(0);
    expect(compassHeadingDeg(1, Infinity)).toBe(0);
  });
});

describe('unwrapAngleDeg — continuous display heading (spec 6A)', () => {
  test('crossing north takes the short way', () => {
    expect(unwrapAngleDeg(359, 1)).toBe(361);
    expect(unwrapAngleDeg(1, 359)).toBe(-1);
  });
  test('repeated rotations stay continuous', () => {
    let d = 0;
    for (let turn = 0; turn < 3; turn++) for (let h = 10; h <= 360; h += 10) d = unwrapAngleDeg(d, h % 360);
    expect(d).toBe(1080);
    for (let i = 0; i < 36; i++) d = unwrapAngleDeg(d, ((360 - (i + 1) * 10) % 360 + 360) % 360);
    expect(d).toBe(720);
  });
  test('a display many turns in still lands on the congruent angle', () => {
    expect(unwrapAngleDeg(725, 10)).toBe(730);
    expect(unwrapAngleDeg(-725, 350)).toBe(-730);
  });
  test('non-finite next keeps prev; non-finite prev starts from next', () => {
    expect(unwrapAngleDeg(42, Number.NaN)).toBe(42);
    expect(unwrapAngleDeg(42, Number.POSITIVE_INFINITY)).toBe(42);
    expect(unwrapAngleDeg(Number.NaN, 90)).toBe(90);
  });
});

describe('stableHeadingDeg — near-vertical guard (spec 6A)', () => {
  test('a usable horizontal component gives the canonical heading', () => {
    expect(stableHeadingDeg(1, 0)).toBe(compassHeadingDeg(1, 0));
    expect(stableHeadingDeg(0, -0.5, 10)).toBe(180);
  });
  test('looking straight down keeps the last reliable heading instead of 0', () => {
    const tiny = NEAR_VERTICAL_HORIZONTAL_EPS / 10;
    expect(stableHeadingDeg(tiny, -tiny, 123)).toBe(123);
    expect(stableHeadingDeg(0, 0, 77)).toBe(77);
    expect(Number.isNaN(stableHeadingDeg(0, 0))).toBe(true);
    expect(stableHeadingDeg(Number.NaN, 1, 5)).toBe(5);
  });
  test('canonical outputs for existing consumers are unchanged', () => {
    expect(compassHeadingDeg(0, 0)).toBe(0);
  });
});

import {
  CUBE_TARGETS,
  activeCubeFace,
  cubeFaceLabel,
  cubeFaceMatrix,
  cubeTargetForView,
  cubeTargetName,
  cubeTargetOrientation,
  cubeViewMatrix,
  placeCube,
  projectCubePoint,
  type SceneVec,
  type StandardView,
} from '../src/render/viewCubeMath';
import { standardViewPose, presetInputForBounds } from '../src/render/camera/cameraPresets';

const VIEWS: StandardView[] = ['top', 'bottom', 'front', 'back', 'left', 'right'];
const len = (v: SceneVec): number => Math.hypot(v[0], v[1], v[2]);
const dot3 = (a: SceneVec, b: SceneVec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('CUBE_TARGETS — 26 targets', () => {
  test('6 faces, 12 edges, 8 corners, unique ids and sign triples', () => {
    expect(CUBE_TARGETS).toHaveLength(26);
    expect(CUBE_TARGETS.filter((t) => t.kind === 'face')).toHaveLength(6);
    expect(CUBE_TARGETS.filter((t) => t.kind === 'edge')).toHaveLength(12);
    expect(CUBE_TARGETS.filter((t) => t.kind === 'corner')).toHaveLength(8);
    expect(new Set(CUBE_TARGETS.map((t) => t.id)).size).toBe(26);
    expect(new Set(CUBE_TARGETS.map((t) => t.signs.join())).size).toBe(26);
    expect(CUBE_TARGETS.filter((t) => t.view).map((t) => t.view).sort()).toEqual([...VIEWS].sort());
  });

  test.each(CUBE_TARGETS.map((t) => [t.id, t] as const))('%s: unit direction on its own side of the cube, orthogonal unit up', (_id, t) => {
    const { dir, up } = cubeTargetOrientation(t);
    expect(len(dir)).toBeCloseTo(1, 9);
    expect(len(up)).toBeCloseTo(1, 9);
    expect(dot3(dir, up)).toBeCloseTo(0, 9);
    // Every non-zero sign is honoured; zero components stay (near) zero.
    for (let a = 0; a < 3; a++) {
      const s = t.signs[a];
      if (s !== 0) expect(Math.sign(dir[a])).toBe(s);
      else if (!(t.kind === 'face' && (t.view === 'top' || t.view === 'bottom') && a === 1)) expect(dir[a]).toBeCloseTo(0, 9);
    }
    // Screen-up leans toward the scene's up axis (never upside down) except straight down/up views.
    if (t.signs[0] !== 0 || t.signs[1] !== 0) expect(up[2]).toBeGreaterThan(0);
    if (t.kind !== 'face') {
      const expected = t.signs.map((v) => v / Math.hypot(...t.signs));
      for (let a = 0; a < 3; a++) expect(dir[a]).toBeCloseTo(expected[a], 9);
    }
  });

  test('ids name the sides: top-north-east is up, north and east', () => {
    const t = CUBE_TARGETS.find((c) => c.id === 'top-north-east')!;
    expect(t.signs).toEqual([1, 1, 1]);
    expect(CUBE_TARGETS.find((c) => c.id === 'south-west')!.signs).toEqual([-1, -1, 0]);
  });
});

describe('faces reproduce the standard views', () => {
  // Z-up scene with the Viewer's basis: north = up × (1,0,0) = +Y, east = north × up = +X.
  const input = presetInputForBounds(
    { min: { x: -1, y: -2, z: -0.5 }, max: { x: 3, y: 2, z: 1.5 } },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    { fovDeg: 50, aspect: 1.5 },
  );
  test.each(VIEWS)('%s', (view) => {
    const pose = standardViewPose(view, input);
    const d = [pose.position.x - pose.target.x, pose.position.y - pose.target.y, pose.position.z - pose.target.z];
    const l = Math.hypot(d[0], d[1], d[2]);
    // World (x, y, z) = (east, north, up) in this scene.
    const { dir } = cubeTargetOrientation(cubeTargetForView(view));
    for (let a = 0; a < 3; a++) expect(dir[a]).toBeCloseTo(d[a] / l, 9);
  });
});

describe('cubeViewMatrix — the cube follows pitch, yaw and roll', () => {
  test('looking north from the south, level: north face is away, south toward the viewer, up is screen-up', () => {
    const m = cubeViewMatrix({ forward: [0, 1, 0], up: [0, 0, 1], upIsZ: true });
    expect(projectCubePoint(m, [0, 0, 1])[1]).toBeCloseTo(-1); // up → screen up (CSS y negative)
    expect(projectCubePoint(m, [0, -1, 0])[2]).toBeCloseTo(1); // south → toward viewer
    expect(projectCubePoint(m, [1, 0, 0])[0]).toBeCloseTo(1); // east → screen right
  });
  test('yaw: looking east puts north on the left', () => {
    const m = cubeViewMatrix({ forward: [1, 0, 0], up: [0, 0, 1], upIsZ: true });
    expect(projectCubePoint(m, [0, 1, 0])[0]).toBeCloseTo(-1);
  });
  test('pitch: looking straight down shows the top face to the viewer', () => {
    const o = cubeTargetOrientation(cubeTargetForView('top'));
    const m = cubeViewMatrix({ forward: [-o.dir[0], -o.dir[1], -o.dir[2]], up: o.up, upIsZ: true });
    expect(projectCubePoint(m, [0, 0, 1])[2]).toBeGreaterThan(0.99);
  });
  test('roll: a camera rolled 90° turns the scene up axis to screen-right', () => {
    const m = cubeViewMatrix({ forward: [0, 1, 0], up: [-1, 0, 0], upIsZ: true });
    expect(projectCubePoint(m, [0, 0, 1])[0]).toBeCloseTo(1);
  });
  test('is a rotation (orthonormal rows) for an arbitrary orientation', () => {
    const m = cubeViewMatrix({ forward: [0.3, 0.5, -0.81], up: [0.1, 0.8, 0.6], upIsZ: true });
    for (const p of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as SceneVec[]) expect(len(projectCubePoint(m, p))).toBeCloseTo(1, 9);
  });
  test('clicking a target and arriving there shows that target nearest the viewer', () => {
    for (const t of CUBE_TARGETS) {
      const o = cubeTargetOrientation(t);
      const m = cubeViewMatrix({ forward: [-o.dir[0], -o.dir[1], -o.dir[2]], up: o.up, upIsZ: true });
      const z = projectCubePoint(m, t.signs as unknown as SceneVec)[2];
      for (const other of CUBE_TARGETS) {
        if (other === t) continue;
        const zo = projectCubePoint(m, other.signs as unknown as SceneVec)[2] / len(other.signs as unknown as SceneVec);
        expect(zo).toBeLessThanOrEqual(z / len(t.signs as unknown as SceneVec) + 1e-9);
      }
    }
  });
});

describe('cubeFaceMatrix — faces sit on the cube, label upright from their own view', () => {
  test.each(VIEWS)('%s', (view) => {
    const m = cubeFaceMatrix(view, 30);
    const t = cubeTargetForView(view);
    // Translation is the outward normal × half.
    expect([m[12], m[13], m[14]].map((v) => v / 30)).toEqual(t.signs.map((s) => s + 0));
    // Seen from its own view, the face's x axis is screen-right and y axis screen-down.
    const o = cubeTargetOrientation(t);
    const cam = cubeViewMatrix({ forward: [-o.dir[0], -o.dir[1], -o.dir[2]], up: o.up, upIsZ: true });
    const x = projectCubePoint(cam, [m[0], m[1], m[2]]);
    const y = projectCubePoint(cam, [m[4], m[5], m[6]]);
    expect(x[0]).toBeCloseTo(1, 9);
    expect(y[1]).toBeCloseTo(1, 9);
  });
});

describe('activeCubeFace', () => {
  test('squarely on a face highlights it; between faces nothing', () => {
    for (const v of VIEWS) {
      const o = cubeTargetOrientation(cubeTargetForView(v));
      expect(activeCubeFace({ forward: [-o.dir[0], -o.dir[1], -o.dir[2]], up: o.up, upIsZ: true })).toBe(v);
    }
    const c = cubeTargetOrientation(CUBE_TARGETS.find((t) => t.id === 'top-north-east')!);
    expect(activeCubeFace({ forward: [-c.dir[0], -c.dir[1], -c.dir[2]], up: c.up, upIsZ: true })).toBeNull();
  });
});

describe('labels — no fabricated geography', () => {
  test('a local / unknown-CRS scan reads the standard view names, never N/E/S/W', () => {
    for (const v of VIEWS) expect(['N', 'E', 'S', 'W']).not.toContain(cubeFaceLabel(v, false));
    expect(cubeFaceLabel('front', false)).toBe('Front');
    for (const t of CUBE_TARGETS) expect(cubeTargetName(t, false)).not.toMatch(/north|south|east|west/i);
  });
  test('a georeferenced Z-up scan reads cardinals by the side each face faces', () => {
    expect(cubeFaceLabel('front', true)).toBe('N');
    expect(cubeFaceLabel('back', true)).toBe('S');
    expect(cubeFaceLabel('left', true)).toBe('E');
    expect(cubeFaceLabel('right', true)).toBe('W');
    expect(cubeFaceLabel('top', true)).toBe('Top');
    expect(cubeTargetName(cubeTargetForView('front'), true)).toBe('Grid north face');
    expect(cubeTargetName(cubeTargetForView('front'), false)).toBe('Front face');
    expect(cubeTargetName(CUBE_TARGETS.find((t) => t.id === 'top-north-east')!, false)).toBe('Top-front-left corner');
  });
});

describe('placeCube — collision-aware top-right placement', () => {
  const host = { width: 1440, height: 800 };
  test('top-right of the stage when nothing is in the way', () => {
    expect(placeCube(host, 112, [])).toEqual({ left: 1440 - 14 - 112, top: 14 });
  });
  test('left of the expanded right rail, never over it', () => {
    const rail = { left: 1096, top: 0, right: 1426, bottom: 800 };
    const p = placeCube(host, 112, [rail]);
    expect(p.left + 112).toBeLessThanOrEqual(rail.left - 10);
    expect(p.top).toBe(14);
  });
  test('below the header and a floating colour key, still at the right edge', () => {
    const header = { left: 0, top: 0, right: 1440, bottom: 56, push: 'down' as const };
    const key = { left: 1094, top: 64, right: 1374, bottom: 230, push: 'down' as const };
    const p = placeCube(host, 112, [header, key]);
    expect(p.left).toBe(1440 - 14 - 112);
    expect(p.top).toBeGreaterThanOrEqual(230);
  });
  test('a left push with no room left steps down instead', () => {
    const narrow = placeCube({ width: 400, height: 800 }, 112, [{ left: 20, top: 0, right: 400, bottom: 100 }]);
    expect(narrow.top).toBeGreaterThanOrEqual(100);
  });
  test('rail and header together: left of the rail, below the header', () => {
    const p = placeCube(host, 112, [
      { left: 0, top: 0, right: 1440, bottom: 56, push: 'down' },
      { left: 1096, top: 66, right: 1426, bottom: 800 },
    ]);
    expect(p.left + 112).toBeLessThanOrEqual(1096 - 10);
    expect(p.top).toBeGreaterThanOrEqual(56);
  });
});
