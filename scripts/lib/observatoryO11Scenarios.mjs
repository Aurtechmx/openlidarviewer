/**
 * observatoryO11Scenarios.mjs: the O11 scenario builders of
 * scripts/generate-observatory-fixtures.mjs, with no Node imports so the
 * benchmark page can load them in a browser.
 */
/**
 * O11 benchmark scenarios (validation/protocols/observatory-o11-v1.md). Pure
 * values: each room scene lists its stations, its angular grid and its box
 * pillars, placed by a seeded integer generator so every run builds the same
 * scene. `castO11Returns` turns a room scene into the returns a scanner at
 * each station would record. `stress` is a synthetic field, not a room.
 */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function roomScene(id, spec) {
  const rand = lcg(spec.seed);
  const [sx, sy, sz] = spec.room;
  const pillars = [];
  for (let i = 0; i < spec.pillarCount; i++) {
    const cx = 2 + rand() * (sx - 4);
    const cy = 2 + rand() * (sy - 4);
    const half = 0.3 + rand() * 0.5;
    pillars.push({ minCorner: [cx - half, cy - half, 0], maxCorner: [cx + half, cy + half, sz * 0.75] });
  }
  const stations = spec.stationXY.map(([x, y], i) => ({ id: `station-${i + 1}`, origin: [x, y, 1.5] }));
  return {
    id,
    kind: 'room',
    room: { minCorner: [0, 0, 0], maxCorner: [sx, sy, sz] },
    pillars,
    stations,
    angularGrid: { azimuthSteps: spec.grid, elevationSteps: spec.grid, elevationDeg: [-80, 80] },
    stride: spec.stride,
    voxelEdge: spec.voxelEdge,
  };
}

export function buildO11Scenarios() {
  return [
    roomScene('small', { seed: 11, room: [30, 20, 6], pillarCount: 4, stationXY: [[6, 10]], grid: 316, stride: 1, voxelEdge: 0.25 }),
    roomScene('medium', { seed: 12, room: [60, 40, 8], pillarCount: 12, stationXY: [[10, 20], [30, 12], [50, 28]], grid: 600, stride: 1, voxelEdge: 0.5 }),
    roomScene('large', { seed: 13, room: [80, 60, 10], pillarCount: 16, stationXY: [[20, 30], [60, 30]], grid: 1000, stride: 4, voxelEdge: 0.5 }),
    { id: 'stress', kind: 'synthetic', grid: { nx: 1024, ny: 1024, nz: 8 }, blockEdge: 8, seed: 14, voxelEdge: 0.25 },
  ];
}

function rayBoxExit(o, d, min, max) {
  // Distance to the far side of a box the ray starts inside.
  let t = Infinity;
  for (let k = 0; k < 3; k++) {
    if (d[k] > 0) t = Math.min(t, (max[k] - o[k]) / d[k]);
    else if (d[k] < 0) t = Math.min(t, (min[k] - o[k]) / d[k]);
  }
  return t;
}

function rayBoxEnter(o, d, min, max) {
  let t0 = 0;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) {
      if (o[k] < min[k] || o[k] > max[k]) return Infinity;
      continue;
    }
    const a = (min[k] - o[k]) / d[k];
    const b = (max[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 && t0 > 0 ? t0 : Infinity;
}

/**
 * The returns of every station of a room scene, station by station, in
 * azimuth-major order: one per angular cell, at the nearest pillar or room
 * face the ray meets. Returns `{ positions, recordRanges }`, positions in the
 * room's own frame.
 */
export function castO11Returns(scene) {
  const { azimuthSteps, elevationSteps, elevationDeg } = scene.angularGrid;
  const perStation = azimuthSteps * elevationSteps;
  const positions = new Float32Array(scene.stations.length * perStation * 3);
  const recordRanges = [];
  let w = 0;
  scene.stations.forEach((station, si) => {
    const o = station.origin;
    for (let a = 0; a < azimuthSteps; a++) {
      const az = ((a + 0.5) / azimuthSteps) * Math.PI * 2;
      for (let e = 0; e < elevationSteps; e++) {
        const el = ((elevationDeg[0] + ((e + 0.5) / elevationSteps) * (elevationDeg[1] - elevationDeg[0])) * Math.PI) / 180;
        const d = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
        let t = rayBoxExit(o, d, scene.room.minCorner, scene.room.maxCorner);
        for (const p of scene.pillars) t = Math.min(t, rayBoxEnter(o, d, p.minCorner, p.maxCorner));
        positions[w++] = o[0] + d[0] * t;
        positions[w++] = o[1] + d[1] * t;
        positions[w++] = o[2] + d[2] * t;
      }
    }
    recordRanges.push({ start: si * perStation, end: (si + 1) * perStation });
  });
  return { positions, recordRanges };
}

/** The `stress` scenario's state per voxel, x fastest, as indices into `states`: one state per `blockEdge` block from a seeded hash. */
export function buildO11StressStates(scene, states) {
  const { nx, ny, nz } = scene.grid;
  const out = new Uint8Array(nx * ny * nz);
  const b = scene.blockEdge;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        let h = (Math.imul((ix / b) | 0, 73856093) ^ Math.imul((iy / b) | 0, 19349663) ^ Math.imul(iz, 83492791) ^ scene.seed) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        out[ix + nx * (iy + ny * iz)] = h % states;
      }
    }
  }
  return out;
}
