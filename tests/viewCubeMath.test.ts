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
  const clearOf = (p: { left: number; top: number }, size: number, o: { left: number; top: number; right: number; bottom: number }, gap = 10): boolean =>
    p.left >= o.right + gap || p.left + size <= o.left - gap || p.top >= o.bottom + gap || p.top + size <= o.top - gap;

  test('top-right of the stage when nothing is in the way', () => {
    expect(placeCube(host, 112, [])).toEqual({ left: 1440 - 14 - 112, top: 14 });
  });
  test('left of the expanded right rail, never over it', () => {
    const rail = { left: 1096, top: 0, right: 1426, bottom: 800 };
    const p = placeCube(host, 112, [rail])!;
    expect(p.left + 112).toBeLessThanOrEqual(rail.left - 10);
    expect(p.top).toBe(14);
  });
  test('below the header and a floating colour key, still at the right edge', () => {
    const header = { left: 0, top: 0, right: 1440, bottom: 56 };
    const key = { left: 1094, top: 64, right: 1374, bottom: 230 };
    const p = placeCube(host, 112, [header, key])!;
    expect(p.left).toBe(1440 - 14 - 112);
    expect(p.top).toBeGreaterThanOrEqual(230);
  });
  test('a covered corner with no room left steps down', () => {
    const p = placeCube({ width: 400, height: 800 }, 112, [{ left: 20, top: 0, right: 400, bottom: 100 }])!;
    expect(p.top).toBeGreaterThanOrEqual(100);
  });
  test('rail and header together: left of the rail, below the header', () => {
    const p = placeCube(host, 112, [
      { left: 0, top: 0, right: 1440, bottom: 56 },
      { left: 1096, top: 66, right: 1426, bottom: 800 },
    ])!;
    expect(p.left + 112).toBeLessThanOrEqual(1096 - 10);
    expect(p.top).toBeGreaterThanOrEqual(56);
  });
  test('above an active-tool pill when the stage is too short to sit beside or below it', () => {
    const measure = { left: 340, top: 56, right: 1100, bottom: 250 };
    const pill = { left: 430, top: 430, right: 620, bottom: 465 };
    const sized = { width: 1024, height: 768 };
    const p = placeCube(sized, 156, [measure, pill]);
    expect(p).not.toBeNull();
    expect(clearOf(p!, 156, measure)).toBe(true);
    expect(clearOf(p!, 156, pill)).toBe(true);
  });
  test('returns null when nothing clear exists, so the cube is hidden rather than drawn over a control', () => {
    const everything = { left: 0, top: 0, right: 400, bottom: 400 };
    expect(placeCube({ width: 400, height: 400 }, 112, [everything])).toBeNull();
  });
  test('never returns a place that covers any obstacle', () => {
    const boxes = [
      { left: 1000, top: 40, right: 1420, bottom: 300 },
      { left: 300, top: 600, right: 900, bottom: 760 },
      { left: 0, top: 0, right: 1440, bottom: 40 },
    ];
    const p = placeCube(host, 120, boxes);
    expect(p).not.toBeNull();
    for (const b of boxes) expect(clearOf(p!, 120, b)).toBe(true);
  });
});

import { layoutCubeTargets, CUBE_FACE_MIN_DEPTH, CUBE_FACE_NORMALS, CUBE_SIZE } from '../src/render/viewCubeMath';

describe('layoutCubeTargets — the 26 targets partition the cube at every camera orientation', () => {
  // A camera orientation in the scene basis [east, north, up] from yaw, pitch and roll (degrees).
  function orientation(yaw: number, pitch: number, roll: number) {
    const r = (d: number): number => (d * Math.PI) / 180;
    const [sy, cy, sp, cp, sr, cr] = [Math.sin(r(yaw)), Math.cos(r(yaw)), Math.sin(r(pitch)), Math.cos(r(pitch)), Math.sin(r(roll)), Math.cos(r(roll))];
    const forward: SceneVec = [cp * sy, cp * cy, sp];
    const upBase: SceneVec = [-sp * sy, -sp * cy, cp];
    const right: SceneVec = [
      forward[1] * upBase[2] - forward[2] * upBase[1],
      forward[2] * upBase[0] - forward[0] * upBase[2],
      forward[0] * upBase[1] - forward[1] * upBase[0],
    ];
    const up: SceneVec = [cr * upBase[0] + sr * right[0], cr * upBase[1] + sr * right[1], cr * upBase[2] + sr * right[2]];
    return { forward, up, upIsZ: true };
  }

  /** Is the point inside the face's projected parallelogram (a square mapped by the affine)? */
  function insideFace(a: readonly number[], half: number, x: number, y: number): boolean {
    const [m00, m10, m01, m11, tx, ty] = a;
    const det = m00 * m11 - m01 * m10;
    if (Math.abs(det) < 1e-9) return false;
    const dx = x - tx;
    const dy = y - ty;
    const lx = (m11 * dx - m01 * dy) / det;
    const ly = (-m10 * dx + m00 * dy) / det;
    return Math.abs(lx) < half && Math.abs(ly) < half;
  }

  for (const [name, half, hit] of [['desktop', 34, 24], ['touch', 45, 44]] as const) {
    test(`${name}: every shown target's centre belongs to that target alone, over a yaw/pitch/roll sweep`, () => {
      let swept = 0;
      for (let yaw = 0; yaw < 360; yaw += 15) {
        for (let pitch = -90; pitch <= 90; pitch += 15) {
          for (let roll = 0; roll < 360; roll += 30) {
            const m = cubeViewMatrix(orientation(yaw, pitch, roll));
            const { faces, spots } = layoutCubeTargets(m, half, hit);
            const where = `yaw ${yaw} pitch ${pitch} roll ${roll}`;
            const shownFaces = VIEWS.filter((v) => faces[v].visible);
            const shownSpots = spots.filter((s) => s.visible);
            expect(shownFaces.length, `a face is toward the viewer at ${where}`).toBeGreaterThanOrEqual(1);
            // Spots are drawn above faces: no shown spot's circle may cover any shown target's centre.
            for (const s of shownSpots) {
              for (const v of shownFaces) {
                expect(Math.hypot(s.x - faces[v].cx, s.y - faces[v].cy), `${s.id} over the ${v} face centre at ${where}`).toBeGreaterThanOrEqual(hit / 2);
              }
              for (const o of shownSpots) {
                if (o !== s) expect(Math.hypot(s.x - o.x, s.y - o.y), `${s.id} and ${o.id} overlap at ${where}`).toBeGreaterThanOrEqual(hit);
              }
            }
            // The visible faces tile the silhouette: a face's centre is inside no other shown face.
            for (const v of shownFaces) {
              for (const o of shownFaces) {
                if (o !== v) expect(insideFace(faces[o].affine, half, faces[v].cx, faces[v].cy), `${v} centre inside ${o} at ${where}`).toBe(false);
              }
              expect(insideFace(faces[v].affine, half, faces[v].cx, faces[v].cy), `${v} centre inside itself at ${where}`).toBe(true);
            }
            // The bounding-box centre a hit test would read is the projected face centre (the parallelogram is symmetric).
            for (const v of shownFaces) {
              const [a, b, c, d, e, f] = faces[v].affine;
              const xs = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => e + (a * sx + c * sy) * half));
              const ys = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => f + (b * sx + d * sy) * half));
              expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(faces[v].cx, 6);
              expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(faces[v].cy, 6);
            }
            swept += 1;
          }
        }
      }
      expect(swept).toBe(24 * 13 * 12);
    });
  }

  test('a visible face is toward the viewer by more than the minimum depth', () => {
    const m = cubeViewMatrix(orientation(40, 25, 0));
    const { faces } = layoutCubeTargets(m, 34, 24);
    for (const v of VIEWS) {
      const depth = projectCubePoint(m, CUBE_FACE_NORMALS[v])[2];
      expect(faces[v].visible).toBe(depth > CUBE_FACE_MIN_DEPTH);
    }
  });

  test('straight-on views keep the useful targets: the near face plus its 8 edges and corners', () => {
    for (const view of ['top', 'front'] as const) {
      const o = cubeTargetOrientation(cubeTargetForView(view));
      const m = cubeViewMatrix({ forward: [-o.dir[0], -o.dir[1], -o.dir[2]], up: o.up, upIsZ: true });
      for (const [half, hit] of [[34, 24], [45, 44]] as const) {
        const { faces, spots } = layoutCubeTargets(m, half, hit);
        expect(faces[view].visible).toBe(true);
        expect(spots.filter((s) => s.visible).length).toBeGreaterThanOrEqual(8);
      }
    }
  });
});

describe('layoutCubeTargets: every shown target meets the 24 CSS px minimum target size', () => {
  const MIN = 24;
  function orient(yaw: number, pitch: number, roll: number) {
    const r = (d: number): number => (d * Math.PI) / 180;
    const [sy, cy, sp, cp, sr, cr] = [Math.sin(r(yaw)), Math.cos(r(yaw)), Math.sin(r(pitch)), Math.cos(r(pitch)), Math.sin(r(roll)), Math.cos(r(roll))];
    const forward: SceneVec = [cp * sy, cp * cy, sp];
    const upBase: SceneVec = [-sp * sy, -sp * cy, cp];
    const right: SceneVec = [
      forward[1] * upBase[2] - forward[2] * upBase[1],
      forward[2] * upBase[0] - forward[0] * upBase[2],
      forward[0] * upBase[1] - forward[1] * upBase[0],
    ];
    const up: SceneVec = [cr * upBase[0] + sr * right[0], cr * upBase[1] + sr * right[1], cr * upBase[2] + sr * right[2]];
    return { forward, up, upIsZ: true };
  }

  for (const [name, geo] of Object.entries(CUBE_SIZE)) {
    // Default view, glancing views (a face a few degrees off edge-on) and a sweep.
    const poses: [number, number, number][] = [[0, 0, 0], [180, 0, 0], [0, 85, 0], [5, 5, 0], [84, 10, 0], [-84, 3, 0], [3, 50, 0], [45, 35, 0], [89, 0, 0]];
    for (let yaw = 0; yaw < 360; yaw += 7) for (let pitch = -90; pitch <= 90; pitch += 7) poses.push([yaw, pitch, (yaw * 3) % 360]);

    test(`${name} pointer: faces and spots are at least ${MIN}px, with no undersized neighbour`, () => {
      for (const [yaw, pitch, roll] of poses) {
        const where = `yaw ${yaw} pitch ${pitch} roll ${roll}`;
        const m = cubeViewMatrix(orient(yaw, pitch, roll));
        const { faces, spots } = layoutCubeTargets(m, geo.half, geo.hit);
        for (const v of VIEWS) {
          const f = faces[v];
          if (!f.visible) continue;
          const [a, b, c, d] = f.affine;
          const w = 2 * geo.half * (Math.abs(a) + Math.abs(c));
          const h = 2 * geo.half * (Math.abs(b) + Math.abs(d));
          expect(Math.min(w, h), `${v} face ${w.toFixed(1)}x${h.toFixed(1)} at ${where}`).toBeGreaterThanOrEqual(MIN - 1e-6);
        }
        const shown = spots.filter((s) => s.visible);
        for (const s of shown) {
          expect(geo.hit, `${s.id} target size`).toBeGreaterThanOrEqual(MIN);
          for (const o of shown) if (o !== s) expect(Math.hypot(s.x - o.x, s.y - o.y), `${s.id}/${o.id} spacing at ${where}`).toBeGreaterThanOrEqual(MIN - 1e-6);
        }
      }
    });
  }
});

describe('cube keyboard order and keys', () => {
  it('orders all 26 targets: faces, then edges, then corners, with no repeats', async () => {
    const { CUBE_KEY_ORDER } = await import('../src/render/viewCubeMath');
    expect(CUBE_KEY_ORDER).toHaveLength(26);
    expect(new Set(CUBE_KEY_ORDER.map((t) => t.id)).size).toBe(26);
    expect(CUBE_KEY_ORDER.slice(0, 6).map((t) => t.view)).toEqual(['top', 'front', 'right', 'back', 'left', 'bottom']);
    expect(CUBE_KEY_ORDER.slice(6, 18).every((t) => t.kind === 'edge')).toBe(true);
    expect(CUBE_KEY_ORDER.slice(18).every((t) => t.kind === 'corner')).toBe(true);
  });

  it('steps with the arrows (wrapping), jumps with Home/End and ignores other keys', async () => {
    const { cubeKeyStep } = await import('../src/render/viewCubeMath');
    expect(cubeKeyStep('ArrowRight', 0, 26)).toBe(1);
    expect(cubeKeyStep('ArrowDown', 25, 26)).toBe(0);
    expect(cubeKeyStep('ArrowLeft', 0, 26)).toBe(25);
    expect(cubeKeyStep('ArrowUp', 5, 26)).toBe(4);
    expect(cubeKeyStep('Home', 13, 26)).toBe(0);
    expect(cubeKeyStep('End', 2, 26)).toBe(25);
    expect(cubeKeyStep('Enter', 2, 26)).toBeNull();
    expect(cubeKeyStep('a', 2, 26)).toBeNull();
  });

  it('names each target by what it does', async () => {
    const { cubeTargetActionName } = await import('../src/render/viewCubeMath');
    const byId = (id: string) => CUBE_TARGETS.find((t) => t.id === id)!;
    expect(cubeTargetActionName(byId('bottom-south-east'), false)).toBe('View from bottom, back, left');
    expect(cubeTargetActionName(byId('top'), false)).toBe('View from top');
    expect(cubeTargetActionName(cubeTargetForView('front'), true)).toBe('View from grid north');
    expect(cubeTargetActionName(byId('top-north'), true)).toBe('View from top, north');
  });
});
